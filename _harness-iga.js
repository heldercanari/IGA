/**
 * Harness do módulo de Inventário e Gestão de Ativos — só para verificação local.
 * Serve `public/` e monta o router com um utilizador injectado, no lugar do SSPI.
 *
 *   npm run harness
 *   ATOR=andreia.r.goncalves npm run harness
 *   npm run harness-rede          (o mesmo que IDENTIDADE=windows)
 *
 * ATOR escolhe quem se está a fingir. O gate lê o username, resolve-o para
 * mecanográfico em `colaboradores.[user]` e vai aos grupos:
 *   helder.canarias      → escrita + administração (abater, apagar)
 *   andreia.r.goncalves  → escrita, sem administração
 *   sem.acesso           → 403 nas páginas e na API
 *
 * Estes utilizadores vêm de `migrations/000_seed_local.sql`. Na intranet a
 * sério não há harness nenhum: a identidade vem do Windows (SSPI) e o router é
 * montado pelo `server/index.js`.
 *
 * **`IDENTIDADE=windows` é para os colegas testarem pela rede.** Em vez de um
 * ATOR fixo, cada pedido traz o login do Windows de quem o faz — o mesmo que a
 * intranet recebe do SSPI —, e o que cada um regista fica com o seu nome. Ver
 * `inscreverColega()` para quem ainda não está na base.
 *
 * **Uma página por tipo de equipamento.** Um tipo novo é mais uma entrada em
 * `PAGINAS` — e é só isso que aqui muda.
 */
const path = require('path');
const express = require('express');
const router = require('./server/routes/iga');
const { exigirAcesso } = require('./server/routes/iga/permissoes');
const { poolPromise, sql } = require('./db');

const ATOR = process.env.ATOR || 'helder.canarias';
const PORTA = parseInt(process.env.HARNESS_PORT || '3943', 10);
const WINDOWS = (process.env.IDENTIDADE || '').toLowerCase() === 'windows'
  || process.argv.includes('--windows');

/**
 * As páginas do módulo, todas atrás do gate de VER. A primeira é a porta de
 * entrada — é para lá que a raiz reencaminha, e é o link que se dá às pessoas.
 */
const PAGINAS = ['iga', 'radios', 'telemoveis', 'impressoras', 'maquinas', 'tablets'];

/**
 * Onde começam os mecanográficos inventados para os colegas.
 *
 * A base de desenvolvimento não tem a tabela `colaboradores` da intranet, só os
 * quatro utilizadores de teste; quem chega pela rede não tem mecanográfico
 * nenhum. Um número a partir daqui não pode ser confundido com um verdadeiro
 * (os da PM têm seis algarismos) e diz, só de olhar, de onde veio.
 */
const MEC_COLEGAS = 900000000;

/** Inscrições a decorrer, por username — dois pedidos ao mesmo tempo não inscrevem duas vezes. */
const inscricoes = new Map();

/**
 * Põe na base de desenvolvimento um colega que entrou pelo Windows e não está lá.
 *
 * Fica em `colaboradores` com um mecanográfico de `MEC_COLEGAS` para cima e
 * entra no grupo `IGA` — edição sem administração, que é o que se quer de quem
 * vem testar: abater e apagar continuam só de quem está no `IGA-Admin`. Quem já
 * existe (os utilizadores de teste, ou um colega da segunda visita em diante)
 * mantém o mecanográfico e os grupos que tiver.
 *
 * O `nome` é o do Active Directory, e é acertado também a quem já existe: é o
 * que o cabeçalho das páginas mostra ao lado de "Utilizador:". Os utilizadores
 * do `000_seed_local.sql` são contas verdadeiras com nomes de teste ("Teste —
 * escrita e administração"), e quem entra com o seu login quer ver o seu nome.
 * Sem nome no AD fica o que lá estiver, ou o username para quem é novo.
 *
 * Isto é andaime de desenvolvimento, como o `000_seed_local.sql`: na intranet a
 * tabela é a dos colaboradores a sério e os grupos geram-se na consola AD-PM.
 */
function inscreverColega(username, nome) {
  if (!inscricoes.has(username)) {
    inscricoes.set(username, (async () => {
      const pool = await poolPromise;
      const r = await pool.request()
        .input('u', sql.NVarChar(120), username)
        .input('nome', sql.NVarChar(200), nome || null)
        .input('base', sql.Int, MEC_COLEGAS)
        .query(`
          SET XACT_ABORT ON;
          BEGIN TRAN;
          DECLARE @mec INT = (SELECT TOP 1 mecanografico FROM dbo.colaboradores WITH (UPDLOCK, HOLDLOCK)
                              WHERE LOWER([user]) = LOWER(@u));
          DECLARE @novo BIT = 0;
          IF @mec IS NULL
          BEGIN
            SET @mec = (SELECT ISNULL(MAX(mecanografico), @base) + 1 FROM dbo.colaboradores WITH (UPDLOCK, HOLDLOCK)
                        WHERE mecanografico > @base);
            INSERT INTO dbo.colaboradores (mecanografico, nome, [user]) VALUES (@mec, ISNULL(@nome, @u), @u);
            INSERT INTO dbo.grupo_membros (grupo_id, mecanografico, data_entrada, ativo)
            SELECT id, @mec, CAST(GETDATE() AS DATE), 1 FROM dbo.grupos WHERE nome = 'IGA';
            SET @novo = 1;
          END
          ELSE IF @nome IS NOT NULL
            UPDATE dbo.colaboradores SET nome = @nome
            WHERE mecanografico = @mec AND (nome IS NULL OR nome <> @nome);
          COMMIT;
          SELECT @mec AS mec, @novo AS novo;`);
      const { mec, novo } = r.recordset[0];
      if (novo) console.log(`[harness IGA] ${username} (${nome || 'sem nome no AD'}) inscrito no grupo IGA (mecanográfico ${mec})`);
    })().catch(err => {
      // Sem a inscrição o colega leva um 403 e pode tentar outra vez; esquecer a
      // falha deixa a próxima visita repetir em vez de ficar presa a ela.
      inscricoes.delete(username);
      throw err;
    }));
  }
  return inscricoes.get(username);
}

/**
 * O nome por extenso de quem entrou, tal como o AD o mostra no Outlook
 * ("Hélder Canarias (PM)"). O AD devolve cada atributo como lista; vazio quando
 * não está disponível, e quem chama decide o que fica no lugar.
 */
function nomeDoAD(u) {
  const ad = u.adUser || {};
  const v = [].concat(ad.displayName || ad.cn || [])[0];
  return v ? String(v).trim() || null : null;
}

const app = express();
app.use(express.json());

if (WINDOWS) {
  // NTLM e não Negotiate: o harness corre na conta de quem o arrancou, não como
  // serviço, e o Kerberos cifra o bilhete para a conta da máquina — o processo
  // não o conseguia ler e a autenticação falhava sem mensagem nenhuma.
  // O Active Directory é só para o nome por extenso (ver `nomeDoAD()`).
  const { sso } = require('node-expose-sspi');
  app.use(sso.auth({ forceNTLM: true, useActiveDirectory: true, useGroups: false }));
  app.use(async (req, res, next) => {
    const u = req.sso && req.sso.user;
    if (!u || !u.name) return res.status(401).send('Sem identidade do Windows.');
    req.user = `${u.domain || ''}\\${u.name}`;
    try {
      await inscreverColega(u.name.toLowerCase(), nomeDoAD(u));
      next();
    } catch (err) {
      next(err);
    }
  });
} else {
  app.use((req, _res, next) => { req.user = `PM\\${ATOR}`; next(); });
}

// Mesma ordem do server/index.js: as páginas são gated, os assets são públicos.
app.use('/api/iga', router);
for (const pagina of PAGINAS) {
  app.get([`/${pagina}.html`, `/${pagina}`], exigirAcesso, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'public', `${pagina}.html`));
  });
}
app.get('/', (req, res) => res.redirect(`/${PAGINAS[0]}.html`));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORTA, () => {
  const quem = WINDOWS ? 'login do Windows de cada pedido' : `actor: ${ATOR}`;
  console.log(`[harness IGA] http://localhost:${PORTA}/  (${quem}, BD: ${process.env.DB_DATABASE || 'do .env'})`);
  for (const p of PAGINAS) console.log(`    · http://localhost:${PORTA}/${p}.html`);
});
