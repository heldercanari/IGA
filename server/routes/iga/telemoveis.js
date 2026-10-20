'use strict';

/**
 * Telemóveis — o segundo tipo de activo do módulo.
 *
 * Montado pelo `index.js` em `/telemoveis`, **dentro do gate de VER**: as
 * permissões são as mesmas do resto (grupos `IGA`, `IGA-Consulta` e
 * `IGA-Admin`). O que muda é a base de dados — ver `db-telemoveis.js`.
 *
 * ⚠️ **O PIN, o PUK e a palavra passe nunca saem daqui sem ser pela rota
 * própria.** Nenhuma consulta deste ficheiro devolve `pin`, `puk` ou
 * `palavra_passe`: as colunas estão escritas uma a uma nos SELECT, e não há
 * `SELECT *`, para que acrescentar um campo à listagem seja uma decisão e não um
 * descuido. Só `GET /telemoveis/:id/credenciais`, reservada ao grupo
 * `IGA-Admin`, as lê.
 *
 * A **conta do aparelho** (`utilizador`) foi uma dessas decisões (2026-10-13):
 * sai na listagem porque é por ela que o NSIC identifica o telemóvel no dia a
 * dia, e o ecrã mostra-a numa coluna. Tomada sabendo que a palavra passe se
 * deduz dela (`pmNNNind` → `pmNNNind!`) — o que obriga a trocar as palavras
 * passe, não a esconder a conta. Continua a só se poder **gravar** pela
 * administração.
 */

const express = require('express');
const router = express.Router();

const { poolPromise, sql } = require('../../../db-telemoveis');
const { exigirEdicao, exigirAdmin } = require('./permissoes');
const { limpar, inteiro, data, hoje, actor, falhou } = require('./comum');
const { montarAutos, abateDoEquipamento } = require('./autos');

const ESTADOS = ['disponivel', 'atribuido', 'avariado', 'abatido'];

/** As colunas que podem sair daqui. O PIN, o PUK e a palavra passe não estão nesta lista. */
const COLUNAS = `t.id, t.numero, t.imei1, t.imei2, t.marca, t.modelo, t.utilizador,
  t.estado, t.localizacao, t.marcador, t.obs, t.criado_em, t.atualizado_em`;

/** Mesma regra e mesma precedência do módulo dos rádios. */
async function recalcularEstado(pool, id) {
  await pool.request()
    .input('id', sql.Int, id)
    .query(`
      UPDATE dbo.telemoveis
      SET estado = CASE
            WHEN EXISTS (SELECT 1 FROM dbo.telemoveis_abates  WHERE telemovel_id = @id AND estado = 'abatido') THEN 'abatido'
            WHEN EXISTS (SELECT 1 FROM dbo.telemoveis_avarias WHERE telemovel_id = @id AND estado = 'aberta') THEN 'avariado'
            WHEN EXISTS (SELECT 1 FROM dbo.telemoveis_atribuicoes WHERE telemovel_id = @id AND data_devolucao IS NULL) THEN 'atribuido'
            ELSE 'disponivel'
          END,
          atualizado_em = GETDATE()
      WHERE id = @id`);
}

/** O aparelho existe? Devolve a linha (sem credenciais) ou responde 404. */
async function telemovelOu404(pool, id, res) {
  const r = await pool.request().input('id', sql.Int, id)
    .query(`SELECT ${COLUNAS} FROM dbo.telemoveis t WHERE t.id = @id`);
  const row = r.recordset && r.recordset[0];
  if (!row) {
    res.status(404).json({ error: 'Telemóvel não encontrado.' });
    return null;
  }
  return row;
}

// ─── Estatísticas ──────────────────────────────────────────

router.get('/estatisticas', async (req, res) => {
  try {
    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base dos telemóveis.' });
    const r = await pool.request().query(`
      SELECT
        (SELECT COUNT(*) FROM dbo.telemoveis)                                    AS total,
        (SELECT COUNT(*) FROM dbo.telemoveis WHERE estado = 'atribuido')         AS atribuidos,
        (SELECT COUNT(*) FROM dbo.telemoveis WHERE estado = 'disponivel')        AS disponiveis,
        (SELECT COUNT(*) FROM dbo.telemoveis WHERE estado = 'avariado')          AS avariados,
        (SELECT COUNT(*) FROM dbo.telemoveis WHERE estado = 'abatido')           AS abatidos,
        (SELECT COUNT(*) FROM dbo.telemoveis_abates WHERE estado = 'proposto')      AS propostos,
        (SELECT COUNT(*) FROM dbo.telemoveis WHERE numero IS NULL)               AS sem_numero,
        (SELECT COUNT(*) FROM dbo.telemoveis_avarias WHERE estado = 'aberta')    AS avarias_abertas`);
    res.json(r.recordset[0]);
  } catch (err) {
    falhou(res, 'obter as estatísticas dos telemóveis', err);
  }
});

// ─── Listagem ──────────────────────────────────────────────

/** GET /telemoveis?q=&estado= — `q` procura no número, IMEI, modelo e no nome de quem o tem. */
router.get('/', async (req, res) => {
  try {
    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base dos telemóveis.' });

    const pedido = pool.request();
    const filtros = [];

    const q = limpar(req.query.q);
    if (q) {
      pedido.input('q', sql.NVarChar(200), `%${q}%`);
      filtros.push(`(t.numero LIKE @q OR t.utilizador LIKE @q
                     OR t.imei1 LIKE @q OR t.imei2 LIKE @q OR t.modelo LIKE @q
                     OR t.marca LIKE @q OR t.localizacao LIKE @q
                     OR a.nome_utilizador LIKE @q OR CAST(a.matricula AS NVARCHAR(20)) LIKE @q)`);
    }
    const estado = limpar(req.query.estado);
    if (estado && ESTADOS.includes(estado)) {
      pedido.input('estado', sql.VarChar(20), estado);
      filtros.push('t.estado = @estado');
    }

    const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
    const r = await pedido.query(`
      SELECT TOP 2000 ${COLUNAS},
        a.id AS atribuicao_id, a.matricula, a.nome_utilizador, a.data_entrega,
        av.id AS avaria_id, av.descricao AS avaria_descricao,
        ab.data_abate, ab.motivo AS motivo_abate, ab.estado AS abate_estado
      FROM dbo.telemoveis t
      OUTER APPLY (
        SELECT TOP 1 * FROM dbo.telemoveis_atribuicoes x
        WHERE x.telemovel_id = t.id AND x.data_devolucao IS NULL
        ORDER BY x.data_entrega DESC, x.id DESC) a
      OUTER APPLY (
        SELECT TOP 1 * FROM dbo.telemoveis_avarias x
        WHERE x.telemovel_id = t.id AND x.estado = 'aberta'
        ORDER BY x.id DESC) av
      OUTER APPLY (
        SELECT TOP 1 * FROM dbo.telemoveis_abates x
        WHERE x.telemovel_id = t.id ORDER BY x.id DESC) ab
      ${where}
      ORDER BY t.numero, t.id`);

    res.json(r.recordset);
  } catch (err) {
    falhou(res, 'listar os telemóveis', err);
  }
});

// ─── Credenciais: só administração ─────────────────────────

/**
 * GET /telemoveis/:id/credenciais
 *
 * A única porta para o PIN, o PUK e a conta do aparelho. Fica antes de
 * `GET /:id` no ficheiro por ser a rota mais específica das duas.
 *
 * `pin_curto` diz ao ecrã que o valor tem menos de 4 dígitos: na folha de origem
 * o PIN era numérico e o Excel comeu os zeros à esquerda ("0020" ficou 20). Não
 * se completa aqui — ver a migração 002.
 */
router.get('/:id/credenciais', exigirAdmin, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });

    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base dos telemóveis.' });

    const r = await pool.request().input('id', sql.Int, id)
      .query('SELECT pin, puk, utilizador, palavra_passe FROM dbo.telemoveis WHERE id = @id');
    const row = r.recordset && r.recordset[0];
    if (!row) return res.status(404).json({ error: 'Telemóvel não encontrado.' });

    console.warn(`[iga/telemoveis] credenciais do telemóvel ${id} lidas por ${actor(req)}`);
    res.json({
      ...row,
      pin_curto: !!(row.pin && /^\d{1,3}$/.test(row.pin)),
    });
  } catch (err) {
    falhou(res, 'obter as credenciais', err);
  }
});

// ─── Detalhe ───────────────────────────────────────────────

// ─── Abates e autos de abate ───────────────────────────────

/**
 * Propor para abate e os autos — ver o `autos.js`. Fica acima do `/:id`
 * porque o `/autos` é um nome fixo.
 */
const AUTOS = {
  tipo: 'telemoveis', nome: 'Telemóveis',
  pool: poolPromise,
  equip: 'dbo.telemoveis', abates: 'dbo.telemoveis_abates', fk: 'telemovel_id',
  atribuicoes: 'dbo.telemoveis_atribuicoes',
  descricao: "CONCAT(N'Telemóvel', ' ' + e.modelo)",
  marca: 'e.marca',
  serie: "COALESCE(N'IMEI ' + e.imei1, N'n.º ' + e.numero)",
  identificacao: 'COALESCE(e.numero, e.imei1)',
  recalcular: recalcularEstado,
};
montarAutos(router, AUTOS);

router.get('/:id', async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });

    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base dos telemóveis.' });

    const telemovel = await telemovelOu404(pool, id, res);
    if (!telemovel) return;

    const [atribuicoes, avarias, abate] = await Promise.all([
      pool.request().input('id', sql.Int, id).query(
        `SELECT * FROM dbo.telemoveis_atribuicoes WHERE telemovel_id = @id
         ORDER BY ISNULL(data_entrega, '1900-01-01') DESC, id DESC`),
      pool.request().input('id', sql.Int, id).query(
        'SELECT * FROM dbo.telemoveis_avarias WHERE telemovel_id = @id ORDER BY id DESC'),
      abateDoEquipamento(pool, AUTOS, id),
    ]);

    res.json({
      ...telemovel,
      atribuicoes: atribuicoes.recordset,
      avarias: avarias.recordset,
      abate,
    });
  } catch (err) {
    falhou(res, 'obter o telemóvel', err);
  }
});

// ─── Criar e editar ────────────────────────────────────────

router.post('/', exigirEdicao, async (req, res) => {
  try {
    const b = req.body || {};
    const numero = limpar(b.numero);
    const imei1 = limpar(b.imei1);
    if (!numero && !imei1) {
      return res.status(400).json({ error: 'É preciso pelo menos o número do cartão ou o IMEI.' });
    }

    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base dos telemóveis.' });

    if (numero) {
      const dup = await pool.request().input('n', sql.NVarChar(20), numero)
        .query('SELECT TOP 1 id FROM dbo.telemoveis WHERE numero = @n');
      if (dup.recordset.length) {
        return res.status(409).json({ error: `Já existe um telemóvel com o número ${numero}.`, id: dup.recordset[0].id });
      }
    }

    const r = await pool.request()
      .input('numero', sql.NVarChar(20), numero)
      .input('imei1', sql.NVarChar(30), imei1)
      .input('imei2', sql.NVarChar(30), limpar(b.imei2))
      .input('marca', sql.NVarChar(40), limpar(b.marca))
      .input('modelo', sql.NVarChar(80), limpar(b.modelo))
      .input('pin', sql.NVarChar(20), limpar(b.pin))
      .input('puk', sql.NVarChar(20), limpar(b.puk))
      .input('utilizador', sql.NVarChar(60), limpar(b.utilizador))
      .input('palavra_passe', sql.NVarChar(60), limpar(b.palavra_passe))
      .input('localizacao', sql.NVarChar(120), limpar(b.localizacao))
      .input('obs', sql.NVarChar(sql.MAX), limpar(b.obs))
      .query(`INSERT INTO dbo.telemoveis
                (numero, imei1, imei2, marca, modelo, pin, puk, utilizador, palavra_passe, localizacao, obs)
              OUTPUT INSERTED.id
              VALUES (@numero, @imei1, @imei2, @marca, @modelo, @pin, @puk, @utilizador, @palavra_passe, @localizacao, @obs)`);

    res.status(201).json({ id: r.recordset[0].id });
  } catch (err) {
    falhou(res, 'criar o telemóvel', err);
  }
});

/**
 * PUT /telemoveis/:id
 *
 * As credenciais só se gravam se vierem no corpo, e só para quem é
 * administrador: quem tem escrita edita o aparelho sem lhes tocar. Um campo
 * ausente fica como está — o ecrã de edição normal nem sequer os mostra, e sem
 * esta regra gravava NULL por cima de todos.
 */
router.put('/:id', exigirEdicao, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });

    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base dos telemóveis.' });
    if (!await telemovelOu404(pool, id, res)) return;

    const b = req.body || {};
    const p = pool.request().input('id', sql.Int, id);
    const sets = [];
    for (const [col, tipo, valor] of [
      ['numero', sql.NVarChar(20), limpar(b.numero)],
      ['imei1', sql.NVarChar(30), limpar(b.imei1)],
      ['imei2', sql.NVarChar(30), limpar(b.imei2)],
      ['marca', sql.NVarChar(40), limpar(b.marca)],
      ['modelo', sql.NVarChar(80), limpar(b.modelo)],
      ['localizacao', sql.NVarChar(120), limpar(b.localizacao)],
      ['obs', sql.NVarChar(sql.MAX), limpar(b.obs)],
    ]) {
      p.input(col, tipo, valor);
      sets.push(`${col} = @${col}`);
    }

    const podeCredenciais = req.igaUser && req.igaUser.canAdmin;
    for (const [col, tipo, campo] of [
      ['pin', sql.NVarChar(20), 'pin'],
      ['puk', sql.NVarChar(20), 'puk'],
      ['utilizador', sql.NVarChar(60), 'utilizador'],
      ['palavra_passe', sql.NVarChar(60), 'palavra_passe'],
    ]) {
      if (!podeCredenciais || b[campo] === undefined) continue;
      p.input(col, tipo, limpar(b[campo]));
      sets.push(`${col} = @${col}`);
    }

    await p.query(`UPDATE dbo.telemoveis SET ${sets.join(', ')}, atualizado_em = GETDATE() WHERE id = @id`);
    res.json({ ok: true });
  } catch (err) {
    if (/UX_telemoveis_numero/.test(err.message)) {
      return res.status(409).json({ error: 'Já existe outro telemóvel com esse número.' });
    }
    falhou(res, 'gravar o telemóvel', err);
  }
});

router.delete('/:id', exigirAdmin, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });
    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base dos telemóveis.' });
    if (!await telemovelOu404(pool, id, res)) return;
    await pool.request().input('id', sql.Int, id).query('DELETE FROM dbo.telemoveis WHERE id = @id');
    res.json({ ok: true });
  } catch (err) {
    falhou(res, 'apagar o telemóvel', err);
  }
});

// ─── Entregas e devoluções ─────────────────────────────────

router.post('/:id/atribuir', exigirEdicao, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });

    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base dos telemóveis.' });
    const telemovel = await telemovelOu404(pool, id, res);
    if (!telemovel) return;
    if (telemovel.estado === 'abatido') {
      return res.status(409).json({ error: 'Este telemóvel está abatido — não pode ser entregue.' });
    }
    const proposto = await pool.request().input('id', sql.Int, id)
      .query(`SELECT 1 AS ok FROM dbo.telemoveis_abates WHERE telemovel_id = @id AND estado = 'proposto'`);
    if (proposto.recordset.length) {
      return res.status(409).json({ error: 'Está proposto para abate — não pode ser entregue.' });
    }

    const b = req.body || {};
    const nome = limpar(b.nome_utilizador);
    const matricula = inteiro(b.matricula);
    if (!nome && matricula === null) {
      return res.status(400).json({ error: 'É preciso a matrícula ou o nome de quem fica com o telemóvel.' });
    }
    const entrega = data(b.data_entrega) || hoje();

    await pool.request().input('id', sql.Int, id).input('fim', sql.Date, entrega)
      .query(`UPDATE dbo.telemoveis_atribuicoes SET data_devolucao = @fim
              WHERE telemovel_id = @id AND data_devolucao IS NULL`);

    const r = await pool.request()
      .input('tid', sql.Int, id)
      .input('mec', sql.Int, matricula)
      .input('nome', sql.NVarChar(200), nome)
      .input('entrega', sql.Date, entrega)
      .input('obs', sql.NVarChar(sql.MAX), limpar(b.obs))
      .input('por', sql.NVarChar(120), actor(req))
      .query(`INSERT INTO dbo.telemoveis_atribuicoes (telemovel_id, matricula, nome_utilizador, data_entrega, obs, registado_por)
              OUTPUT INSERTED.id
              VALUES (@tid, @mec, @nome, @entrega, @obs, @por)`);

    await recalcularEstado(pool, id);
    res.status(201).json({ id: r.recordset[0].id });
  } catch (err) {
    falhou(res, 'registar a entrega', err);
  }
});

router.post('/:id/devolver', exigirEdicao, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });

    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base dos telemóveis.' });
    if (!await telemovelOu404(pool, id, res)) return;

    const b = req.body || {};
    const r = await pool.request()
      .input('id', sql.Int, id)
      .input('fim', sql.Date, data(b.data_devolucao) || hoje())
      .input('obs', sql.NVarChar(sql.MAX), limpar(b.obs))
      .query(`
        UPDATE dbo.telemoveis_atribuicoes
        SET data_devolucao = @fim,
            obs = CASE WHEN @obs IS NULL THEN obs
                       WHEN obs IS NULL THEN @obs
                       ELSE obs + N' · ' + @obs END
        WHERE telemovel_id = @id AND data_devolucao IS NULL`);

    if (!r.rowsAffected[0]) {
      return res.status(409).json({ error: 'Este telemóvel não está entregue a ninguém.' });
    }
    await recalcularEstado(pool, id);
    res.json({ ok: true });
  } catch (err) {
    falhou(res, 'registar a devolução', err);
  }
});

// ─── Avarias ───────────────────────────────────────────────

/** Fica antes de `/:id/...` genérico? Não é preciso: o caminho é diferente. */
router.post('/avarias/:id/reparar', exigirEdicao, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });

    const b = req.body || {};
    const estado = limpar(b.estado) === 'irreparavel' ? 'irreparavel' : 'reparada';

    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base dos telemóveis.' });

    const r = await pool.request()
      .input('id', sql.Int, id)
      .input('estado', sql.VarChar(20), estado)
      .input('fim', sql.Date, data(b.data_reparacao) || hoje())
      .input('obs', sql.NVarChar(sql.MAX), limpar(b.obs))
      .query(`
        UPDATE dbo.telemoveis_avarias
        SET estado = @estado, data_reparacao = @fim,
            obs = CASE WHEN @obs IS NULL THEN obs
                       WHEN obs IS NULL THEN @obs
                       ELSE obs + N' · ' + @obs END
        OUTPUT INSERTED.telemovel_id
        WHERE id = @id AND estado = 'aberta'`);

    const linha = r.recordset && r.recordset[0];
    if (!linha) return res.status(409).json({ error: 'Avaria não encontrada ou já fechada.' });

    await recalcularEstado(pool, linha.telemovel_id);
    res.json({ ok: true, telemovel_id: linha.telemovel_id });
  } catch (err) {
    falhou(res, 'fechar a avaria', err);
  }
});

router.post('/:id/avarias', exigirEdicao, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });

    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base dos telemóveis.' });
    const telemovel = await telemovelOu404(pool, id, res);
    if (!telemovel) return;
    if (telemovel.estado === 'abatido') {
      return res.status(409).json({ error: 'Este telemóvel está abatido — não faz sentido registar avarias.' });
    }

    const b = req.body || {};
    const descricao = limpar(b.descricao);
    if (!descricao) return res.status(400).json({ error: 'Diz o que tem a avaria.' });

    const r = await pool.request()
      .input('tid', sql.Int, id)
      .input('desc', sql.NVarChar(200), descricao)
      .input('registo', sql.Date, data(b.data_registo) || hoje())
      .input('obs', sql.NVarChar(sql.MAX), limpar(b.obs))
      .input('por', sql.NVarChar(120), actor(req))
      .query(`INSERT INTO dbo.telemoveis_avarias (telemovel_id, descricao, data_registo, obs, registado_por)
              OUTPUT INSERTED.id
              VALUES (@tid, @desc, @registo, @obs, @por)`);

    await recalcularEstado(pool, id);
    res.status(201).json({ id: r.recordset[0].id });
  } catch (err) {
    falhou(res, 'registar a avaria', err);
  }
});

module.exports = router;
