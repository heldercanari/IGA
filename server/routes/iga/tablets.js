'use strict';

/**
 * Tablets — o quinto tipo de activo do módulo.
 *
 * Montado pelo `index.js` em `/tablets`, **dentro do gate de VER**: as
 * permissões são as mesmas do resto (grupos `IGA`, `IGA-Consulta` e
 * `IGA-Admin`). É o molde completo dos telemóveis — entregas a pessoas,
 * avarias, abates e `estado` —, mas na base do `db.js`, a dos rádios: os
 * tablets não têm base própria (ver a migração 005).
 *
 * ⚠️ **O PIN e o PUK vêm no detalhe, à vista, e não na listagem.** Ao contrário
 * dos telemóveis, não há rota de credenciais nem botão "mostrar": quem gere os
 * tablets quer ver tudo do aparelho ao abrir a ficha (decisão de 2026-10-20).
 * Ficam fora do `COLUNAS` — a tabela e o CSV não os levam — e só o `GET /:id`
 * os acrescenta. Gravá-los continua a ser só da administração.
 */

const express = require('express');
const router = express.Router();

const { poolPromise, sql } = require('../../../db');
const { exigirEdicao, exigirAdmin } = require('./permissoes');
const { limpar, inteiro, data, hoje, actor, falhou } = require('./comum');

const ESTADOS = ['disponivel', 'atribuido', 'avariado', 'abatido'];

/** As colunas da listagem. O PIN e o PUK não estão aqui: só o detalhe os traz. */
const COLUNAS = `t.id, t.num_inventario, t.numero, t.iccid, t.imei, t.num_serie, t.marca, t.modelo,
  t.finalidade, t.estado, t.localizacao, t.obs, t.criado_em, t.atualizado_em`;

/** Os índices únicos e o que dizer quando um deles recusa uma gravação. */
const DUPLICADOS = {
  UX_tablets_num_inventario: 'Já existe um tablet com esse número de inventário.',
  UX_tablets_numero: 'Já existe um tablet com esse número de cartão.',
  UX_tablets_imei: 'Já existe um tablet com esse IMEI.',
  UX_tablets_num_serie: 'Já existe um tablet com esse número de série.',
};

/** Responde 409 se o erro for de um índice único; senão devolve false. */
function duplicado(res, err) {
  const indice = Object.keys(DUPLICADOS).find(n => err && new RegExp(n).test(err.message));
  if (!indice) return false;
  res.status(409).json({ error: DUPLICADOS[indice] });
  return true;
}

/**
 * Os números de série em maiúsculas.
 *
 * Os da Samsung são-no; a folha tem alguns em minúsculas ("r5gyb2x49dt") por
 * terem sido copiados à mão. A mesma série escrita das duas maneiras passava o
 * índice único como se fossem dois aparelhos.
 */
function serie(v) {
  const s = limpar(v);
  return s ? s.toUpperCase() : s;
}

/** Mesma regra e mesma precedência dos rádios e dos telemóveis. */
async function recalcularEstado(pool, id) {
  await pool.request()
    .input('id', sql.Int, id)
    .query(`
      UPDATE dbo.tablets
      SET estado = CASE
            WHEN EXISTS (SELECT 1 FROM dbo.tablets_abates  WHERE tablet_id = @id) THEN 'abatido'
            WHEN EXISTS (SELECT 1 FROM dbo.tablets_avarias WHERE tablet_id = @id AND estado = 'aberta') THEN 'avariado'
            WHEN EXISTS (SELECT 1 FROM dbo.tablets_atribuicoes WHERE tablet_id = @id AND data_devolucao IS NULL) THEN 'atribuido'
            ELSE 'disponivel'
          END,
          atualizado_em = GETDATE()
      WHERE id = @id`);
}

/** O tablet existe? Devolve a linha (sem PIN nem PUK) ou responde 404. */
async function tabletOu404(pool, id, res) {
  const r = await pool.request().input('id', sql.Int, id)
    .query(`SELECT ${COLUNAS} FROM dbo.tablets t WHERE t.id = @id`);
  const row = r.recordset && r.recordset[0];
  if (!row) {
    res.status(404).json({ error: 'Tablet não encontrado.' });
    return null;
  }
  return row;
}

// ─── Estatísticas ──────────────────────────────────────────

router.get('/estatisticas', async (req, res) => {
  try {
    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });
    const r = await pool.request().query(`
      SELECT
        (SELECT COUNT(*) FROM dbo.tablets)                                  AS total,
        (SELECT COUNT(*) FROM dbo.tablets WHERE estado = 'atribuido')       AS atribuidos,
        (SELECT COUNT(*) FROM dbo.tablets WHERE estado = 'disponivel')      AS disponiveis,
        (SELECT COUNT(*) FROM dbo.tablets WHERE estado = 'avariado')        AS avariados,
        (SELECT COUNT(*) FROM dbo.tablets WHERE estado = 'abatido')         AS abatidos,
        (SELECT COUNT(*) FROM dbo.tablets WHERE num_inventario IS NULL)     AS sem_inventario,
        (SELECT COUNT(*) FROM dbo.tablets_avarias WHERE estado = 'aberta')  AS avarias_abertas`);
    res.json(r.recordset[0]);
  } catch (err) {
    falhou(res, 'obter as estatísticas dos tablets', err);
  }
});

// ─── Serviços ──────────────────────────────────────────────

/** GET /tablets/locais — os serviços já usados, para o autocompletar do ecrã. */
router.get('/locais', async (req, res) => {
  try {
    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });
    const r = await pool.request().query(`
      SELECT localizacao, COUNT(*) AS total FROM dbo.tablets
      WHERE localizacao IS NOT NULL GROUP BY localizacao ORDER BY localizacao`);
    res.json(r.recordset);
  } catch (err) {
    falhou(res, 'listar os serviços', err);
  }
});

// ─── Listagem ──────────────────────────────────────────────

/** GET /tablets?q=&estado= — `q` procura nos números do aparelho, no modelo, no serviço e em quem o tem. */
router.get('/', async (req, res) => {
  try {
    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });

    const pedido = pool.request();
    const filtros = [];

    const q = limpar(req.query.q);
    if (q) {
      pedido.input('q', sql.NVarChar(200), `%${q}%`);
      filtros.push(`(t.num_inventario LIKE @q OR t.numero LIKE @q OR t.imei LIKE @q
                     OR t.num_serie LIKE @q OR t.iccid LIKE @q OR t.modelo LIKE @q
                     OR t.localizacao LIKE @q OR t.finalidade LIKE @q
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
        ab.data_abate, ab.motivo AS motivo_abate
      FROM dbo.tablets t
      OUTER APPLY (
        SELECT TOP 1 * FROM dbo.tablets_atribuicoes x
        WHERE x.tablet_id = t.id AND x.data_devolucao IS NULL
        ORDER BY x.data_entrega DESC, x.id DESC) a
      OUTER APPLY (
        SELECT TOP 1 * FROM dbo.tablets_avarias x
        WHERE x.tablet_id = t.id AND x.estado = 'aberta'
        ORDER BY x.id DESC) av
      OUTER APPLY (
        SELECT TOP 1 * FROM dbo.tablets_abates x
        WHERE x.tablet_id = t.id ORDER BY x.id DESC) ab
      ${where}
      ORDER BY t.localizacao, CASE WHEN t.num_inventario IS NULL THEN 1 ELSE 0 END,
               TRY_CAST(LEFT(t.num_inventario, CHARINDEX('/', t.num_inventario + '/') - 1) AS INT),
               t.numero, t.id`);

    res.json(r.recordset);
  } catch (err) {
    falhou(res, 'listar os tablets', err);
  }
});

// ─── Detalhe ───────────────────────────────────────────────

/** O detalhe traz tudo, PIN e PUK incluídos — ver o comentário no topo. */
router.get('/:id', async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });

    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });

    const tablet = await tabletOu404(pool, id, res);
    if (!tablet) return;

    const [cartao, atribuicoes, avarias, abate] = await Promise.all([
      pool.request().input('id', sql.Int, id).query('SELECT pin, puk FROM dbo.tablets WHERE id = @id'),
      pool.request().input('id', sql.Int, id).query(
        `SELECT * FROM dbo.tablets_atribuicoes WHERE tablet_id = @id
         ORDER BY ISNULL(data_entrega, '1900-01-01') DESC, id DESC`),
      pool.request().input('id', sql.Int, id).query(
        'SELECT * FROM dbo.tablets_avarias WHERE tablet_id = @id ORDER BY id DESC'),
      pool.request().input('id', sql.Int, id).query(
        'SELECT TOP 1 * FROM dbo.tablets_abates WHERE tablet_id = @id ORDER BY id DESC'),
    ]);

    const { pin, puk } = cartao.recordset[0] || {};
    res.json({
      ...tablet,
      pin, puk,
      // O PIN fica como está: completá-lo com zeros era adivinhar, e um PIN
      // errado tranca o cartão. O ecrã avisa quando tem menos de 4 dígitos.
      pin_curto: !!(pin && /^\d{1,3}$/.test(pin)),
      atribuicoes: atribuicoes.recordset,
      avarias: avarias.recordset,
      abate: abate.recordset[0] || null,
    });
  } catch (err) {
    falhou(res, 'obter o tablet', err);
  }
});

// ─── Criar e editar ────────────────────────────────────────

router.post('/', exigirEdicao, async (req, res) => {
  try {
    const b = req.body || {};
    const campos = {
      num_inventario: limpar(b.num_inventario),
      numero: limpar(b.numero),
      iccid: limpar(b.iccid),
      imei: limpar(b.imei),
      num_serie: serie(b.num_serie),
    };
    if (!campos.num_inventario && !campos.numero && !campos.imei && !campos.num_serie) {
      return res.status(400).json({ error: 'É preciso pelo menos o inventário, o número do cartão, o IMEI ou a série.' });
    }

    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });

    const podeCredenciais = req.igaUser && req.igaUser.canAdmin;
    const r = await pool.request()
      .input('num_inventario', sql.NVarChar(40), campos.num_inventario)
      .input('numero', sql.NVarChar(20), campos.numero)
      .input('iccid', sql.NVarChar(30), campos.iccid)
      .input('imei', sql.NVarChar(30), campos.imei)
      .input('num_serie', sql.NVarChar(40), campos.num_serie)
      .input('marca', sql.NVarChar(40), limpar(b.marca))
      .input('modelo', sql.NVarChar(80), limpar(b.modelo))
      .input('pin', sql.NVarChar(20), podeCredenciais ? limpar(b.pin) : null)
      .input('puk', sql.NVarChar(20), podeCredenciais ? limpar(b.puk) : null)
      .input('finalidade', sql.NVarChar(120), limpar(b.finalidade))
      .input('localizacao', sql.NVarChar(120), limpar(b.localizacao))
      .input('obs', sql.NVarChar(sql.MAX), limpar(b.obs))
      .query(`INSERT INTO dbo.tablets
                (num_inventario, numero, iccid, imei, num_serie, marca, modelo, pin, puk, finalidade, localizacao, obs)
              OUTPUT INSERTED.id
              VALUES (@num_inventario, @numero, @iccid, @imei, @num_serie, @marca, @modelo, @pin, @puk, @finalidade, @localizacao, @obs)`);

    res.status(201).json({ id: r.recordset[0].id });
  } catch (err) {
    if (duplicado(res, err)) return;
    falhou(res, 'criar o tablet', err);
  }
});

/**
 * PUT /tablets/:id
 *
 * Grava a lista toda do aparelho, como o dos telemóveis. O PIN e o PUK só se
 * gravam se vierem no corpo, e só para quem é administrador: o formulário de
 * quem tem escrita nem os mostra, e sem esta regra gravava NULL por cima deles.
 */
router.put('/:id', exigirEdicao, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });

    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });
    if (!await tabletOu404(pool, id, res)) return;

    const b = req.body || {};
    const p = pool.request().input('id', sql.Int, id);
    const sets = [];
    for (const [col, tipo, valor] of [
      ['num_inventario', sql.NVarChar(40), limpar(b.num_inventario)],
      ['numero', sql.NVarChar(20), limpar(b.numero)],
      ['iccid', sql.NVarChar(30), limpar(b.iccid)],
      ['imei', sql.NVarChar(30), limpar(b.imei)],
      ['num_serie', sql.NVarChar(40), serie(b.num_serie)],
      ['marca', sql.NVarChar(40), limpar(b.marca)],
      ['modelo', sql.NVarChar(80), limpar(b.modelo)],
      ['finalidade', sql.NVarChar(120), limpar(b.finalidade)],
      ['localizacao', sql.NVarChar(120), limpar(b.localizacao)],
      ['obs', sql.NVarChar(sql.MAX), limpar(b.obs)],
    ]) {
      p.input(col, tipo, valor);
      sets.push(`${col} = @${col}`);
    }

    const podeCredenciais = req.igaUser && req.igaUser.canAdmin;
    for (const [col, tipo] of [['pin', sql.NVarChar(20)], ['puk', sql.NVarChar(20)]]) {
      if (!podeCredenciais || b[col] === undefined) continue;
      p.input(col, tipo, limpar(b[col]));
      sets.push(`${col} = @${col}`);
    }

    await p.query(`UPDATE dbo.tablets SET ${sets.join(', ')}, atualizado_em = GETDATE() WHERE id = @id`);
    res.json({ ok: true });
  } catch (err) {
    if (duplicado(res, err)) return;
    falhou(res, 'gravar o tablet', err);
  }
});

router.delete('/:id', exigirAdmin, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });
    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });
    if (!await tabletOu404(pool, id, res)) return;
    await pool.request().input('id', sql.Int, id).query('DELETE FROM dbo.tablets WHERE id = @id');
    res.json({ ok: true });
  } catch (err) {
    falhou(res, 'apagar o tablet', err);
  }
});

// ─── Entregas e devoluções ─────────────────────────────────

router.post('/:id/atribuir', exigirEdicao, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });

    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });
    const tablet = await tabletOu404(pool, id, res);
    if (!tablet) return;
    if (tablet.estado === 'abatido') {
      return res.status(409).json({ error: 'Este tablet está abatido — não pode ser entregue.' });
    }

    const b = req.body || {};
    const nome = limpar(b.nome_utilizador);
    const matricula = inteiro(b.matricula);
    if (!nome && matricula === null) {
      return res.status(400).json({ error: 'É preciso a matrícula ou o nome de quem fica com o tablet.' });
    }
    const entrega = data(b.data_entrega) || hoje();

    await pool.request().input('id', sql.Int, id).input('fim', sql.Date, entrega)
      .query(`UPDATE dbo.tablets_atribuicoes SET data_devolucao = @fim
              WHERE tablet_id = @id AND data_devolucao IS NULL`);

    const r = await pool.request()
      .input('tid', sql.Int, id)
      .input('mec', sql.Int, matricula)
      .input('nome', sql.NVarChar(200), nome)
      .input('entrega', sql.Date, entrega)
      .input('obs', sql.NVarChar(sql.MAX), limpar(b.obs))
      .input('por', sql.NVarChar(120), actor(req))
      .query(`INSERT INTO dbo.tablets_atribuicoes (tablet_id, matricula, nome_utilizador, data_entrega, obs, registado_por)
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
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });
    if (!await tabletOu404(pool, id, res)) return;

    const b = req.body || {};
    const r = await pool.request()
      .input('id', sql.Int, id)
      .input('fim', sql.Date, data(b.data_devolucao) || hoje())
      .input('obs', sql.NVarChar(sql.MAX), limpar(b.obs))
      .query(`
        UPDATE dbo.tablets_atribuicoes
        SET data_devolucao = @fim,
            obs = CASE WHEN @obs IS NULL THEN obs
                       WHEN obs IS NULL THEN @obs
                       ELSE obs + N' · ' + @obs END
        WHERE tablet_id = @id AND data_devolucao IS NULL`);

    if (!r.rowsAffected[0]) {
      return res.status(409).json({ error: 'Este tablet não está entregue a ninguém.' });
    }
    await recalcularEstado(pool, id);
    res.json({ ok: true });
  } catch (err) {
    falhou(res, 'registar a devolução', err);
  }
});

// ─── Avarias ───────────────────────────────────────────────

router.post('/avarias/:id/reparar', exigirEdicao, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });

    const b = req.body || {};
    const estado = limpar(b.estado) === 'irreparavel' ? 'irreparavel' : 'reparada';

    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });

    const r = await pool.request()
      .input('id', sql.Int, id)
      .input('estado', sql.VarChar(20), estado)
      .input('fim', sql.Date, data(b.data_reparacao) || hoje())
      .input('obs', sql.NVarChar(sql.MAX), limpar(b.obs))
      .query(`
        UPDATE dbo.tablets_avarias
        SET estado = @estado, data_reparacao = @fim,
            obs = CASE WHEN @obs IS NULL THEN obs
                       WHEN obs IS NULL THEN @obs
                       ELSE obs + N' · ' + @obs END
        OUTPUT INSERTED.tablet_id
        WHERE id = @id AND estado = 'aberta'`);

    const linha = r.recordset && r.recordset[0];
    if (!linha) return res.status(409).json({ error: 'Avaria não encontrada ou já fechada.' });

    await recalcularEstado(pool, linha.tablet_id);
    res.json({ ok: true, tablet_id: linha.tablet_id });
  } catch (err) {
    falhou(res, 'fechar a avaria', err);
  }
});

router.post('/:id/avarias', exigirEdicao, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });

    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });
    const tablet = await tabletOu404(pool, id, res);
    if (!tablet) return;
    if (tablet.estado === 'abatido') {
      return res.status(409).json({ error: 'Este tablet está abatido — não faz sentido registar avarias.' });
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
      .query(`INSERT INTO dbo.tablets_avarias (tablet_id, descricao, data_registo, obs, registado_por)
              OUTPUT INSERTED.id
              VALUES (@tid, @desc, @registo, @obs, @por)`);

    await recalcularEstado(pool, id);
    res.status(201).json({ id: r.recordset[0].id });
  } catch (err) {
    falhou(res, 'registar a avaria', err);
  }
});

// ─── Abate ─────────────────────────────────────────────────

router.post('/:id/abate', exigirAdmin, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });

    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });
    if (!await tabletOu404(pool, id, res)) return;

    const b = req.body || {};
    const quando = data(b.data_abate) || hoje();

    const ja = await pool.request().input('id', sql.Int, id)
      .query('SELECT TOP 1 id FROM dbo.tablets_abates WHERE tablet_id = @id');
    if (ja.recordset.length) return res.status(409).json({ error: 'Este tablet já está abatido.' });

    await pool.request().input('id', sql.Int, id).input('fim', sql.Date, quando)
      .query('UPDATE dbo.tablets_atribuicoes SET data_devolucao = @fim WHERE tablet_id = @id AND data_devolucao IS NULL');

    await pool.request()
      .input('tid', sql.Int, id)
      .input('quando', sql.Date, quando)
      .input('motivo', sql.NVarChar(200), limpar(b.motivo))
      .input('obs', sql.NVarChar(sql.MAX), limpar(b.obs))
      .input('por', sql.NVarChar(120), actor(req))
      .query(`INSERT INTO dbo.tablets_abates (tablet_id, data_abate, motivo, obs, registado_por)
              VALUES (@tid, @quando, @motivo, @obs, @por)`);

    await recalcularEstado(pool, id);
    res.status(201).json({ ok: true });
  } catch (err) {
    falhou(res, 'registar o abate', err);
  }
});

router.delete('/:id/abate', exigirAdmin, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });
    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });
    const r = await pool.request().input('id', sql.Int, id)
      .query('DELETE FROM dbo.tablets_abates WHERE tablet_id = @id');
    if (!r.rowsAffected[0]) return res.status(404).json({ error: 'Este tablet não está abatido.' });
    await recalcularEstado(pool, id);
    res.json({ ok: true });
  } catch (err) {
    falhou(res, 'anular o abate', err);
  }
});

module.exports = router;
