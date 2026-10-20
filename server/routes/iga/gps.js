'use strict';

/**
 * GPS — o sexto tipo de activo: os GPS dos reboques.
 *
 * Montado pelo `index.js` em `/gps`, **dentro do gate de VER**. É o molde das
 * impressoras com a viatura no lugar do serviço: um GPS não se entrega a ninguém,
 * está num reboque, e o que se quer dele é saber em qual (ver a migração 008).
 * Por isso não há entregas, avarias nem `recalcularEstado()`. Abates há, como em
 * todo o equipamento desde a 006: "abatido" lê-se do `gps_abates`.
 *
 * ⚠️ **A ORDEM DAS ROTAS É SIGNIFICATIVA**: o `/estatisticas` e os autos estão
 * escritos ANTES do `/:id`, senão o `/:id` apanha-os como identificador.
 *
 * ⚠️ **O `PUT` grava só os campos que vierem no corpo**, como o das impressoras:
 * "mudar de viatura" manda só a viatura, e não pode apagar a série nem o modelo.
 */

const express = require('express');
const router = express.Router();

const { poolPromise, sql } = require('../../../db');
const { exigirEdicao, exigirAdmin } = require('./permissoes');
const { limpar, inteiro, falhou } = require('./comum');
const { montarAutos, abateDoEquipamento } = require('./autos');

/** As colunas que saem daqui. Escritas uma a uma, como no resto do módulo. */
const COLUNAS = `g.id, g.marca, g.modelo, g.num_serie, g.viatura_chave, g.viatura_marca,
  g.viatura_matricula, g.obs, g.criado_em, g.atualizado_em`;

/** Matrícula e série em maiúsculas: "aa-00-00" e "AA-00-00" são a mesma. */
function maiusculas(v) {
  return v ? v.toUpperCase() : v;
}

/** Os campos que se podem gravar — uma lista só para o POST e o PUT. */
const CAMPOS = [
  ['marca', sql.NVarChar(40)],
  ['modelo', sql.NVarChar(80)],
  ['num_serie', sql.NVarChar(40), maiusculas],
  ['viatura_chave', sql.NVarChar(20)],
  ['viatura_marca', sql.NVarChar(60)],
  ['viatura_matricula', sql.NVarChar(20), maiusculas],
  ['obs', sql.NVarChar(sql.MAX)],
];

function valorDe(corpo, col, normalizar) {
  const v = limpar(corpo[col]);
  return normalizar ? normalizar(v) : v;
}

/** O GPS está numa viatura se tiver a chave ou a matrícula do reboque. */
const EM_VIATURA = '(g.viatura_chave IS NOT NULL OR g.viatura_matricula IS NOT NULL)';
const ABATIDO = "EXISTS (SELECT 1 FROM dbo.gps_abates b WHERE b.gps_id = g.id AND b.estado = 'abatido')";

async function gpsOu404(pool, id, res) {
  const r = await pool.request().input('id', sql.Int, id)
    .query(`SELECT ${COLUNAS} FROM dbo.gps g WHERE g.id = @id`);
  const row = r.recordset && r.recordset[0];
  if (!row) {
    res.status(404).json({ error: 'GPS não encontrado.' });
    return null;
  }
  return row;
}

// ─── Estatísticas ──────────────────────────────────────────

/** Em viatura, sem viatura e abatidos são a partição do total. */
router.get('/estatisticas', async (req, res) => {
  try {
    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });
    const r = await pool.request().query(`
      SELECT
        (SELECT COUNT(*) FROM dbo.gps)                                              AS total,
        (SELECT COUNT(*) FROM dbo.gps g WHERE ${EM_VIATURA} AND NOT ${ABATIDO})     AS em_viatura,
        (SELECT COUNT(*) FROM dbo.gps g WHERE NOT ${EM_VIATURA} AND NOT ${ABATIDO}) AS sem_viatura,
        (SELECT COUNT(*) FROM dbo.gps_abates WHERE estado = 'abatido')              AS abatidos,
        (SELECT COUNT(*) FROM dbo.gps_abates WHERE estado = 'proposto')             AS propostos,
        (SELECT COUNT(*) FROM dbo.gps g WHERE marca = N'Garmin' AND NOT ${ABATIDO}) AS garmin,
        (SELECT COUNT(*) FROM dbo.gps g WHERE marca = N'TomTom' AND NOT ${ABATIDO}) AS tomtom`);
    res.json(r.recordset[0]);
  } catch (err) {
    falhou(res, 'obter as estatísticas dos GPS', err);
  }
});

// ─── Listagem ──────────────────────────────────────────────

/**
 * GET /gps?q=&marca=&viatura=
 *   `q` procura na série, no modelo, na marca e na viatura;
 *   `viatura=com` / `viatura=sem` separa os que estão num reboque dos que não.
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
      filtros.push(`(g.num_serie LIKE @q OR g.modelo LIKE @q OR g.marca LIKE @q
                     OR g.viatura_chave LIKE @q OR g.viatura_matricula LIKE @q OR g.viatura_marca LIKE @q)`);
    }
    const marca = limpar(req.query.marca);
    if (marca) {
      pedido.input('marca', sql.NVarChar(40), marca);
      filtros.push('g.marca = @marca');
    }
    const viatura = limpar(req.query.viatura);
    if (viatura === 'com') filtros.push(EM_VIATURA);
    else if (viatura === 'sem') filtros.push(`NOT ${EM_VIATURA}`);

    const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
    const r = await pedido.query(`
      SELECT TOP 2000 ${COLUNAS},
        ab.estado AS abate_estado, ab.data_abate
      FROM dbo.gps g
      OUTER APPLY (SELECT TOP 1 estado, data_abate FROM dbo.gps_abates x
                   WHERE x.gps_id = g.id ORDER BY x.id DESC) ab
      ${where}
      ORDER BY CASE WHEN ${EM_VIATURA} THEN 0 ELSE 1 END,
               TRY_CAST(g.viatura_chave AS INT), g.viatura_chave, g.marca, g.num_serie, g.id`);

    res.json(r.recordset);
  } catch (err) {
    falhou(res, 'listar os GPS', err);
  }
});

// ─── Abates e autos de abate ───────────────────────────────

/** Propor para abate e os autos — ver o `autos.js` e a migração 006. */
const AUTOS = {
  tipo: 'gps', nome: 'GPS',
  pool: poolPromise,
  equip: 'dbo.gps', abates: 'dbo.gps_abates', fk: 'gps_id',
  atribuicoes: null,
  descricao: "CONCAT(N'GPS', ' ' + e.modelo)",
  marca: 'e.marca',
  serie: 'e.num_serie',
  identificacao: "COALESCE(N'Chave ' + e.viatura_chave, e.num_serie)",
  recalcular: null,
};
montarAutos(router, AUTOS);

// ─── Detalhe ───────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });
    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });
    const gps = await gpsOu404(pool, id, res);
    if (!gps) return;
    res.json({ ...gps, abate: await abateDoEquipamento(pool, AUTOS, id) });
  } catch (err) {
    falhou(res, 'obter o GPS', err);
  }
});

// ─── Criar e editar ────────────────────────────────────────

router.post('/', exigirEdicao, async (req, res) => {
  try {
    const b = req.body || {};
    if (!limpar(b.num_serie) && !limpar(b.viatura_chave)) {
      return res.status(400).json({ error: 'É preciso pelo menos o número de série ou o n.º de chave da viatura.' });
    }
    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });

    const p = pool.request();
    for (const [col, tipo, normalizar] of CAMPOS) p.input(col, tipo, valorDe(b, col, normalizar));
    const colunas = CAMPOS.map(([c]) => c);
    const r = await p.query(`INSERT INTO dbo.gps (${colunas.join(', ')})
                             OUTPUT INSERTED.id
                             VALUES (${colunas.map(c => '@' + c).join(', ')})`);
    res.status(201).json({ id: r.recordset[0].id });
  } catch (err) {
    if (/UX_gps_num_serie/.test(err.message)) return res.status(409).json({ error: 'Já existe outro GPS com esse número de série.' });
    falhou(res, 'criar o GPS', err);
  }
});

/** Grava só os campos que vierem no corpo — ver o comentário do topo. */
router.put('/:id', exigirEdicao, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });
    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });
    if (!await gpsOu404(pool, id, res)) return;

    const b = req.body || {};
    const p = pool.request().input('id', sql.Int, id);
    const sets = [];
    for (const [col, tipo, normalizar] of CAMPOS) {
      if (b[col] === undefined) continue;
      p.input(col, tipo, valorDe(b, col, normalizar));
      sets.push(`${col} = @${col}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'Não veio nenhum campo para gravar.' });

    await p.query(`UPDATE dbo.gps SET ${sets.join(', ')}, atualizado_em = GETDATE() WHERE id = @id`);
    res.json({ ok: true });
  } catch (err) {
    if (/UX_gps_num_serie/.test(err.message)) return res.status(409).json({ error: 'Já existe outro GPS com esse número de série.' });
    falhou(res, 'gravar o GPS', err);
  }
});

router.delete('/:id', exigirAdmin, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });
    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });
    if (!await gpsOu404(pool, id, res)) return;
    await pool.request().input('id', sql.Int, id).query('DELETE FROM dbo.gps WHERE id = @id');
    res.json({ ok: true });
  } catch (err) {
    falhou(res, 'apagar o GPS', err);
  }
});

module.exports = router;
