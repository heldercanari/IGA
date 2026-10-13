/**
 * Harness do módulo de Inventário e Gestão de Ativos — só para verificação local.
 * Serve `public/` e monta o router com um utilizador injectado, no lugar do SSPI.
 *
 *   npm run harness
 *   ATOR=andreia.r.goncalves npm run harness
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
 * **Uma página por tipo de equipamento.** Um tipo novo é mais uma entrada em
 * `PAGINAS` — e é só isso que aqui muda.
 */
const path = require('path');
const express = require('express');
const router = require('./server/routes/iga');
const { exigirAcesso } = require('./server/routes/iga/permissoes');

const ATOR = process.env.ATOR || 'helder.canarias';
const PORTA = parseInt(process.env.HARNESS_PORT || '3943', 10);

/**
 * As páginas do módulo, todas atrás do gate de VER. A primeira é a porta de
 * entrada — é para lá que a raiz reencaminha, e é o link que se dá às pessoas.
 */
const PAGINAS = ['iga', 'radios', 'telemoveis', 'impressoras', 'maquinas'];

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = `PM\\${ATOR}`; next(); });

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
  console.log(`[harness IGA] http://localhost:${PORTA}/  (actor: ${ATOR}, BD: ${process.env.DB_DATABASE || 'do .env'})`);
  for (const p of PAGINAS) console.log(`    · http://localhost:${PORTA}/${p}.html`);
});
