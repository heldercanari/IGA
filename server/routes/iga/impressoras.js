'use strict';

/**
 * Impressoras — o terceiro tipo de activo do módulo, e o mais pequeno.
 *
 * Montado pelo `index.js` em `/impressoras`, **dentro do gate de VER**: as
 * permissões são as mesmas do resto (grupos `IGA`, `IGA-Consulta` e
 * `IGA-Admin`). A base é a do módulo — a mesma dos rádios, pela pool do `db.js`;
 * não há pool própria porque não há base própria (ver a migração 003).
 *
 * **Aqui não há entregas, avarias nem abates.** Uma impressora não é entregue a
 * ninguém: está instalada num serviço, e o que se quer dela é saber onde está.
 * É por isso que este ficheiro tem um terço do tamanho do `telemoveis.js` e que
 * não existe `recalcularEstado()` — sem avarias nem abates não há estado que
 * recalcular. A migração 003 explica a decisão por extenso.
 *
 * ⚠️ **A ORDEM DAS ROTAS AQUI É SIGNIFICATIVA**, como no `radios.js`: o
 * `/estatisticas` e o `/locais` estão escritos ANTES do `/:id`, senão o `/:id`
 * apanha-os como identificador.
 */

const express = require('express');
const router = express.Router();

const { poolPromise, sql } = require('../../../db');
const { exigirEdicao, exigirAdmin } = require('./permissoes');
const { limpar, inteiro, falhou } = require('./comum');

/** As colunas que saem daqui. Escritas uma a uma, como no resto do módulo. */
const COLUNAS = `i.id, i.marca, i.modelo, i.num_serie, i.localizacao, i.ip,
  i.host_name, i.obs, i.criado_em, i.atualizado_em`;

/**
 * O IP sem os zeros à esquerda de cada octeto: `10.22.129.049` → `10.22.129.49`.
 *
 * O ficheiro de origem escreve os endereços das duas maneiras, e guardá-los como
 * vinham deixava a coluna com duas escritas para a mesma máquina — uma procura
 * por "129.49" não encontrava a linha que dizia "129.049". A forma canónica é a
 * sem zeros, que é como o Windows, o `ping` e a própria impressora os mostram.
 *
 * **Só toca em endereços IPv4 bem formados.** Qualquer outra coisa no campo — um
 * IPv6, um nome de máquina, um endereço a meio de ser escrito — passa intacta:
 * mexer no que não se percebe é pior do que deixar como está.
 */
function normalizarIP(v) {
  if (!v) return v;
  const s = String(v).trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return s;
  return s.split('.').map(o => String(Number(o))).join('.');
}

/**
 * Os campos que se podem gravar, com o tipo e o tamanho da coluna, e — quando o
 * campo precisa — a função que o põe na forma canónica antes de gravar.
 *
 * Uma lista só, usada pelo POST e pelo PUT: quando uma coluna nova entrar na
 * tabela, entra aqui e passa a valer para os dois — que é como as duas rotas se
 * mantêm em sintonia sem ninguém se lembrar de as comparar.
 */
const CAMPOS = [
  ['marca', sql.NVarChar(40)],
  ['modelo', sql.NVarChar(80)],
  ['num_serie', sql.NVarChar(40)],
  ['localizacao', sql.NVarChar(160)],
  ['ip', sql.NVarChar(45), normalizarIP],
  ['host_name', sql.NVarChar(60)],
  ['obs', sql.NVarChar(sql.MAX)],
];

/** O valor de um campo pronto a gravar: limpo e, se for caso disso, canónico. */
function valorDe(corpo, col, normalizar) {
  const v = limpar(corpo[col]);
  return normalizar ? normalizar(v) : v;
}

/** A impressora existe? Devolve a linha ou responde 404. */
async function impressoraOu404(pool, id, res) {
  const r = await pool.request().input('id', sql.Int, id)
    .query(`SELECT ${COLUNAS} FROM dbo.impressoras i WHERE i.id = @id`);
  const row = r.recordset && r.recordset[0];
  if (!row) {
    res.status(404).json({ error: 'Impressora não encontrada.' });
    return null;
  }
  return row;
}

/** Traduz a violação de um índice único na frase que o ecrã mostra. */
function conflitoDeIndice(err) {
  if (/UX_impressoras_num_serie/.test(err.message)) {
    return 'Já existe outra impressora com esse número de série.';
  }
  if (/UX_impressoras_host_name/.test(err.message)) {
    return 'Já existe outra impressora com esse host name.';
  }
  return null;
}

// ─── Estatísticas ──────────────────────────────────────────

/**
 * As contagens do cartão da entrada e dos KPI do ecrã.
 *
 * Não são as dos outros tipos — aqui não há entregues nem abatidos. O que conta
 * é o parque, em quantos sítios está, quantos modelos diferentes tem, e quantas
 * máquinas estão sem morada, que é a única coisa que aqui é um problema por
 * resolver.
 */
router.get('/estatisticas', async (req, res) => {
  try {
    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });
    const r = await pool.request().query(`
      SELECT
        (SELECT COUNT(*) FROM dbo.impressoras)                                        AS total,
        (SELECT COUNT(*) FROM dbo.impressoras WHERE localizacao IS NOT NULL)          AS com_local,
        (SELECT COUNT(*) FROM dbo.impressoras WHERE localizacao IS NULL)              AS sem_local,
        (SELECT COUNT(DISTINCT localizacao) FROM dbo.impressoras WHERE localizacao IS NOT NULL) AS locais,
        (SELECT COUNT(DISTINCT modelo) FROM dbo.impressoras WHERE modelo IS NOT NULL) AS modelos,
        (SELECT COUNT(*) FROM dbo.impressoras WHERE ip IS NULL)                       AS sem_ip`);
    res.json(r.recordset[0]);
  } catch (err) {
    falhou(res, 'obter as estatísticas das impressoras', err);
  }
});

// ─── Locais ────────────────────────────────────────────────

/**
 * GET /impressoras/locais — os serviços onde há impressoras, com a contagem.
 *
 * Alimenta o filtro do ecrã e o autocompletar do campo "Serviço": a lista de
 * locais é a própria coluna, não uma tabela de referência, e escrever "DT -
 * Radares" onde as outras dizem "DT - RADARES" cria um sítio novo sem ninguém
 * dar por isso.
 */
router.get('/locais', async (req, res) => {
  try {
    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });
    const r = await pool.request().query(`
      SELECT localizacao, COUNT(*) AS total
      FROM dbo.impressoras
      WHERE localizacao IS NOT NULL
      GROUP BY localizacao
      ORDER BY localizacao`);
    res.json(r.recordset);
  } catch (err) {
    falhou(res, 'listar os locais', err);
  }
});

// ─── Listagem ──────────────────────────────────────────────

/**
 * GET /impressoras?q=&local=
 *
 * `q` procura na série, no modelo, no serviço, no IP e no host name — o IP entra
 * porque é assim que quem trata da rede identifica a máquina.
 *
 * O IP está guardado na forma canónica, sem zeros à esquerda (`normalizarIP()`),
 * portanto procurar por "129.49" encontra a máquina que na folha estava escrita
 * "129.049". A procura continua a ser LIKE sobre texto: "129.4" também apanha o
 * ".49" e o ".41", e é o que se quer de uma caixa de procura.
 */
router.get('/', async (req, res) => {
  try {
    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });

    const pedido = pool.request();
    const filtros = [];

    const q = limpar(req.query.q);
    if (q) {
      pedido.input('q', sql.NVarChar(200), `%${q}%`);
      filtros.push(`(i.num_serie LIKE @q OR i.modelo LIKE @q OR i.marca LIKE @q
                     OR i.localizacao LIKE @q OR i.ip LIKE @q OR i.host_name LIKE @q)`);
    }

    // `local=` com valor exacto (vem do filtro, que se enche do /locais);
    // `local=--sem--` são as que estão sem morada, o único caso a resolver.
    const local = limpar(req.query.local);
    if (local === '--sem--') {
      filtros.push('i.localizacao IS NULL');
    } else if (local) {
      pedido.input('local', sql.NVarChar(160), local);
      filtros.push('i.localizacao = @local');
    }

    const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
    const r = await pedido.query(`
      SELECT TOP 2000 ${COLUNAS}
      FROM dbo.impressoras i
      ${where}
      ORDER BY i.localizacao, i.num_serie, i.id`);

    res.json(r.recordset);
  } catch (err) {
    falhou(res, 'listar as impressoras', err);
  }
});

// ─── Detalhe ───────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });

    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });

    const impressora = await impressoraOu404(pool, id, res);
    if (!impressora) return;

    // Sem entregas, avarias nem abates para juntar: a ficha é a linha.
    res.json(impressora);
  } catch (err) {
    falhou(res, 'obter a impressora', err);
  }
});

// ─── Criar e editar ────────────────────────────────────────

router.post('/', exigirEdicao, async (req, res) => {
  try {
    const b = req.body || {};
    if (!limpar(b.num_serie) && !limpar(b.host_name)) {
      return res.status(400).json({ error: 'É preciso pelo menos o número de série ou o host name.' });
    }

    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });

    const p = pool.request();
    for (const [col, tipo, normalizar] of CAMPOS) p.input(col, tipo, valorDe(b, col, normalizar));
    const colunas = CAMPOS.map(([c]) => c);
    const r = await p.query(`INSERT INTO dbo.impressoras (${colunas.join(', ')})
                             OUTPUT INSERTED.id
                             VALUES (${colunas.map(c => '@' + c).join(', ')})`);

    res.status(201).json({ id: r.recordset[0].id });
  } catch (err) {
    const conflito = conflitoDeIndice(err);
    if (conflito) return res.status(409).json({ error: conflito });
    falhou(res, 'criar a impressora', err);
  }
});

/**
 * PUT /impressoras/:id — grava **só os campos que vierem no corpo**.
 *
 * Diferente do `telemoveis.js`, que grava a lista toda e apaga o que não vier.
 * Lá isso é seguro porque o ecrã manda sempre o formulário inteiro; aqui a acção
 * mais comum é a mais pequena — mudar uma impressora de serviço —, e é um pedido
 * com um campo só. Com a regra do outro ficheiro, mudar de sala apagava o IP, a
 * série e o modelo.
 */
router.put('/:id', exigirEdicao, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });

    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });
    if (!await impressoraOu404(pool, id, res)) return;

    const b = req.body || {};
    const p = pool.request().input('id', sql.Int, id);
    const sets = [];
    for (const [col, tipo, normalizar] of CAMPOS) {
      if (b[col] === undefined) continue;
      p.input(col, tipo, valorDe(b, col, normalizar));
      sets.push(`${col} = @${col}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'Não veio nenhum campo para gravar.' });

    await p.query(`UPDATE dbo.impressoras SET ${sets.join(', ')}, atualizado_em = GETDATE() WHERE id = @id`);
    res.json({ ok: true });
  } catch (err) {
    const conflito = conflitoDeIndice(err);
    if (conflito) return res.status(409).json({ error: conflito });
    falhou(res, 'gravar a impressora', err);
  }
});

router.delete('/:id', exigirAdmin, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });
    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });
    if (!await impressoraOu404(pool, id, res)) return;
    await pool.request().input('id', sql.Int, id).query('DELETE FROM dbo.impressoras WHERE id = @id');
    res.json({ ok: true });
  } catch (err) {
    falhou(res, 'apagar a impressora', err);
  }
});

module.exports = router;
