'use strict';

/**
 * Máquinas fotográficas — o quarto tipo de activo do módulo.
 *
 * Montado pelo `index.js` em `/maquinas`, **dentro do gate de VER**: as
 * permissões são as mesmas do resto (grupos `IGA`, `IGA-Consulta` e
 * `IGA-Admin`). A base é a do módulo, pela pool do `db.js` — como as
 * impressoras, e pela mesma razão: não há base própria, logo não há pool.
 *
 * **Tem entregas, ao contrário das impressoras**: uma máquina fotográfica é
 * levantada por alguém, e a folha de origem traz quem a tem. O que não tem são
 * avarias, abates e coluna `estado` — a migração `004` explica cada ausência.
 * Sem `estado` guardado, **não existe `recalcularEstado()`** aqui: a máquina
 * está entregue se tiver uma linha em `maquinas_atribuicoes` sem devolução, e
 * essa pergunta faz-se onde é precisa.
 *
 * ⚠️ **A ORDEM DAS ROTAS AQUI É SIGNIFICATIVA**, como no `radios.js`: o
 * `/estatisticas` está escrito ANTES do `/:id`, senão o `/:id` apanha-o como
 * identificador.
 */

const express = require('express');
const router = express.Router();

const { poolPromise, sql } = require('../../../db');
const { exigirEdicao, exigirAdmin } = require('./permissoes');
const { limpar, inteiro, data, hoje, actor, falhou } = require('./comum');
const { montarAutos, abateDoEquipamento } = require('./autos');

/** As colunas que saem daqui. Escritas uma a uma, como no resto do módulo. */
const COLUNAS = `m.id, m.pm_id, m.marca, m.modelo, m.num_serie,
  m.cartao_marca, m.cartao_capacidade, m.obs, m.criado_em, m.atualizado_em`;

/**
 * A entrega aberta de cada máquina, para a listagem e para o detalhe.
 *
 * É esta linha — existir ou não — que faz o "Atribuído" da tabela e o
 * disponível/entregue do ecrã. Não há coluna `estado` a duplicá-la.
 */
const ENTREGA_ABERTA = `
  OUTER APPLY (
    SELECT TOP 1 * FROM dbo.maquinas_atribuicoes x
    WHERE x.maquina_id = m.id AND x.data_devolucao IS NULL
    ORDER BY ISNULL(x.data_entrega, '1900-01-01') DESC, x.id DESC) a`;

/**
 * A capacidade na forma correcta: `32Gb`, `32GB` e `32 Gb` → `32 GB`.
 *
 * Duas coisas se arrumam, e as duas têm razão de ser:
 *
 *  - **`B` maiúsculo.** `B` é *byte* e `b` é *bit* — um "32 Gb" à letra seria um
 *    cartão de 4 GB. Não é isso que alguém quis escrever, e a forma que engana
 *    quem sabe ler a unidade não é a que fica na base.
 *  - **Espaço entre o número e a unidade**, que é como se escreve uma grandeza.
 *
 * **O número não se toca** — nem sequer a vírgula decimal, que em português é a
 * separadora certa: arrumar a unidade é ortografia, converter o número era
 * outra coisa. E **só toca no que reconhece**: um valor que não seja um número
 * seguido de KB/MB/GB/TB passa intacto, seja "32 Gigabytes" ou uma frase.
 */
function normalizarCapacidade(v) {
  if (!v) return v;
  const s = String(v).trim();
  const m = /^(\d+(?:[.,]\d+)?)\s*([kmgt])b$/i.exec(s);
  return m ? `${m[1]} ${m[2].toUpperCase()}B` : s;
}

/**
 * Os campos da própria máquina que se podem gravar, com o tipo da coluna e —
 * quando o campo precisa — a função que o põe na forma canónica.
 */
const CAMPOS = [
  ['pm_id', sql.NVarChar(20)],
  ['marca', sql.NVarChar(40)],
  ['modelo', sql.NVarChar(80)],
  ['num_serie', sql.NVarChar(40)],
  ['cartao_marca', sql.NVarChar(40)],
  ['cartao_capacidade', sql.NVarChar(20), normalizarCapacidade],
  ['obs', sql.NVarChar(sql.MAX)],
];

/** O valor de um campo pronto a gravar: limpo e, se for caso disso, canónico. */
function valorDe(corpo, col, normalizar) {
  const v = limpar(corpo[col]);
  return normalizar ? normalizar(v) : v;
}

/** A máquina existe? Devolve a linha (com a entrega aberta) ou responde 404. */
async function maquinaOu404(pool, id, res) {
  const r = await pool.request().input('id', sql.Int, id)
    .query(`SELECT ${COLUNAS}, a.id AS atribuicao_id, a.matricula, a.nome_utilizador, a.data_entrega
            FROM dbo.maquinas m ${ENTREGA_ABERTA} WHERE m.id = @id`);
  const row = r.recordset && r.recordset[0];
  if (!row) {
    res.status(404).json({ error: 'Máquina não encontrada.' });
    return null;
  }
  return row;
}

/** Traduz a violação de um índice único na frase que o ecrã mostra. */
function conflitoDeIndice(err) {
  if (/UX_maquinas_pm_id/.test(err.message)) {
    return 'Já existe outra máquina com esse ID-PM.';
  }
  if (/UX_maquinas_num_serie/.test(err.message)) {
    return 'Já existe outra máquina com esse número de série.';
  }
  return null;
}

// ─── Estatísticas ──────────────────────────────────────────

/**
 * As contagens do cartão da entrada e dos KPI do ecrã.
 *
 * `entregues` e `disponiveis` saem da existência de uma entrega aberta, não de
 * uma coluna. `entregas_sem_data` é o que aqui é trabalho por fazer: a folha só
 * traz a data de um dos quatro levantamentos, e o resto ficou por saber.
 */
router.get('/estatisticas', async (req, res) => {
  try {
    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });
    const r = await pool.request().query(`
      WITH abertas AS (
        SELECT maquina_id, data_entrega FROM dbo.maquinas_atribuicoes WHERE data_devolucao IS NULL
      )
      SELECT
        (SELECT COUNT(*) FROM dbo.maquinas)                                          AS total,
        (SELECT COUNT(DISTINCT maquina_id) FROM abertas)                             AS entregues,
        (SELECT COUNT(*) FROM dbo.maquinas m
          WHERE id NOT IN (SELECT maquina_id FROM abertas) AND NOT EXISTS (SELECT 1 FROM dbo.maquinas_abates b WHERE b.maquina_id = m.id AND b.estado = 'abatido'))      AS disponiveis,
        (SELECT COUNT(*) FROM dbo.maquinas_abates WHERE estado = 'abatido')          AS abatidas,
        (SELECT COUNT(*) FROM dbo.maquinas_abates WHERE estado = 'proposto')         AS propostos,
        (SELECT COUNT(*) FROM abertas WHERE data_entrega IS NULL)                    AS entregas_sem_data,
        (SELECT COUNT(*) FROM dbo.maquinas WHERE num_serie IS NULL)                  AS sem_serie`);
    res.json(r.recordset[0]);
  } catch (err) {
    falhou(res, 'obter as estatísticas das máquinas', err);
  }
});

// ─── Listagem ──────────────────────────────────────────────

/**
 * GET /maquinas?q=&estado=
 *
 * `q` procura no ID-PM, na série, na marca, no modelo e em quem a tem. O
 * `estado` aceita `entregue` e `disponivel` — os dois únicos que existem, e
 * ambos lidos da entrega aberta.
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
      filtros.push(`(m.pm_id LIKE @q OR m.num_serie LIKE @q OR m.marca LIKE @q OR m.modelo LIKE @q
                     OR m.cartao_marca LIKE @q
                     OR a.nome_utilizador LIKE @q OR CAST(a.matricula AS NVARCHAR(20)) LIKE @q)`);
    }
    const estado = limpar(req.query.estado);
    if (estado === 'entregue') filtros.push('a.id IS NOT NULL');
    else if (estado === 'disponivel') filtros.push("a.id IS NULL AND ISNULL(ab.estado, '') <> 'abatido'");
    else if (estado === 'abatida') filtros.push("ab.estado = 'abatido'");

    const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
    const r = await pedido.query(`
      SELECT TOP 2000 ${COLUNAS},
        a.id AS atribuicao_id, a.matricula, a.nome_utilizador, a.data_entrega,
        ab.estado AS abate_estado, ab.data_abate
      FROM dbo.maquinas m
      ${ENTREGA_ABERTA}
      OUTER APPLY (SELECT TOP 1 estado, data_abate FROM dbo.maquinas_abates x
                   WHERE x.maquina_id = m.id ORDER BY x.id DESC) ab
      ${where}
      ORDER BY m.pm_id, m.id`);

    res.json(r.recordset);
  } catch (err) {
    falhou(res, 'listar as máquinas', err);
  }
});

// ─── Abates e autos de abate ───────────────────────────────

/**
 * Propor para abate e os autos — ver o `autos.js` e a migração 006. Continua
 * sem `estado`: abatida é ter um abate homologado, como entregue é ter uma
 * entrega aberta. A homologação fecha a entrega que houver.
 */
const AUTOS = {
  tipo: 'maquinas', nome: 'Máquinas fotográficas',
  pool: poolPromise,
  equip: 'dbo.maquinas', abates: 'dbo.maquinas_abates', fk: 'maquina_id',
  atribuicoes: 'dbo.maquinas_atribuicoes',
  descricao: "CONCAT(N'Máquina fotográfica', ' ' + e.modelo)",
  marca: 'e.marca',
  serie: 'e.num_serie',
  identificacao: 'COALESCE(e.pm_id, e.num_serie)',
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

    const maquina = await maquinaOu404(pool, id, res);
    if (!maquina) return;

    const atribuicoes = await pool.request().input('id', sql.Int, id).query(
      `SELECT * FROM dbo.maquinas_atribuicoes WHERE maquina_id = @id
       ORDER BY ISNULL(data_entrega, '1900-01-01') DESC, id DESC`);

    res.json({ ...maquina, atribuicoes: atribuicoes.recordset, abate: await abateDoEquipamento(pool, AUTOS, id) });
  } catch (err) {
    falhou(res, 'obter a máquina', err);
  }
});

// ─── Criar e editar ────────────────────────────────────────

router.post('/', exigirEdicao, async (req, res) => {
  try {
    const b = req.body || {};
    if (!limpar(b.pm_id) && !limpar(b.num_serie)) {
      return res.status(400).json({ error: 'É preciso pelo menos o ID-PM ou o número de série.' });
    }

    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });

    const p = pool.request();
    for (const [col, tipo, normalizar] of CAMPOS) p.input(col, tipo, valorDe(b, col, normalizar));
    const colunas = CAMPOS.map(([c]) => c);
    const r = await p.query(`INSERT INTO dbo.maquinas (${colunas.join(', ')})
                             OUTPUT INSERTED.id
                             VALUES (${colunas.map(c => '@' + c).join(', ')})`);

    res.status(201).json({ id: r.recordset[0].id });
  } catch (err) {
    const conflito = conflitoDeIndice(err);
    if (conflito) return res.status(409).json({ error: conflito });
    falhou(res, 'criar a máquina', err);
  }
});

/**
 * PUT /maquinas/:id — grava só os campos que vierem no corpo.
 *
 * Mesma regra das impressoras, e pela mesma razão: nada obriga um pedido a
 * trazer o formulário inteiro, e um `PUT` com um campo só não deve apagar os
 * outros. O ecrã manda-os todos na edição; a regra é para quem não mandar.
 */
router.put('/:id', exigirEdicao, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });

    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });
    if (!await maquinaOu404(pool, id, res)) return;

    const b = req.body || {};
    const p = pool.request().input('id', sql.Int, id);
    const sets = [];
    for (const [col, tipo, normalizar] of CAMPOS) {
      if (b[col] === undefined) continue;
      p.input(col, tipo, valorDe(b, col, normalizar));
      sets.push(`${col} = @${col}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'Não veio nenhum campo para gravar.' });

    await p.query(`UPDATE dbo.maquinas SET ${sets.join(', ')}, atualizado_em = GETDATE() WHERE id = @id`);
    res.json({ ok: true });
  } catch (err) {
    const conflito = conflitoDeIndice(err);
    if (conflito) return res.status(409).json({ error: conflito });
    falhou(res, 'gravar a máquina', err);
  }
});

router.delete('/:id', exigirAdmin, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });
    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });
    if (!await maquinaOu404(pool, id, res)) return;
    // As entregas caem com a máquina (ON DELETE CASCADE).
    await pool.request().input('id', sql.Int, id).query('DELETE FROM dbo.maquinas WHERE id = @id');
    res.json({ ok: true });
  } catch (err) {
    falhou(res, 'apagar a máquina', err);
  }
});

// ─── Entregas e devoluções ─────────────────────────────────

/**
 * POST /maquinas/:id/atribuir
 *
 * Entregar a outra pessoa fecha a entrega anterior em vez de a apagar — igual
 * aos rádios e aos telemóveis. A data é opcional aqui, ao contrário dos outros
 * dois: a folha de origem tem três levantamentos sem data e o ecrã tem de poder
 * registar o mesmo sem inventar um dia.
 */
router.post('/:id/atribuir', exigirEdicao, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });

    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });
    if (!await maquinaOu404(pool, id, res)) return;
    const abate = await pool.request().input('id', sql.Int, id)
      .query('SELECT TOP 1 estado FROM dbo.maquinas_abates WHERE maquina_id = @id');
    if (abate.recordset.length) {
      return res.status(409).json({ error: abate.recordset[0].estado === 'abatido'
        ? 'Esta máquina está abatida — não pode ser entregue.'
        : 'Está proposta para abate — não pode ser entregue.' });
    }

    const b = req.body || {};
    const nome = limpar(b.nome_utilizador);
    const matricula = inteiro(b.matricula);
    if (!nome && matricula === null) {
      return res.status(400).json({ error: 'É preciso a matrícula ou o nome de quem leva a máquina.' });
    }
    const entrega = data(b.data_entrega);

    // Fecha o que estiver aberto. Sem data de entrega nova, fecha-se hoje: uma
    // entrega anterior que fica aberta faz a máquina aparecer com dois donos.
    await pool.request().input('id', sql.Int, id).input('fim', sql.Date, entrega || hoje())
      .query(`UPDATE dbo.maquinas_atribuicoes SET data_devolucao = @fim
              WHERE maquina_id = @id AND data_devolucao IS NULL`);

    const r = await pool.request()
      .input('mid', sql.Int, id)
      .input('mec', sql.Int, matricula)
      .input('nome', sql.NVarChar(200), nome)
      .input('entrega', sql.Date, entrega)
      .input('obs', sql.NVarChar(sql.MAX), limpar(b.obs))
      .input('por', sql.NVarChar(120), actor(req))
      .query(`INSERT INTO dbo.maquinas_atribuicoes (maquina_id, matricula, nome_utilizador, data_entrega, obs, registado_por)
              OUTPUT INSERTED.id
              VALUES (@mid, @mec, @nome, @entrega, @obs, @por)`);

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
    if (!await maquinaOu404(pool, id, res)) return;

    const b = req.body || {};
    const r = await pool.request()
      .input('id', sql.Int, id)
      .input('fim', sql.Date, data(b.data_devolucao) || hoje())
      .input('obs', sql.NVarChar(sql.MAX), limpar(b.obs))
      .query(`
        UPDATE dbo.maquinas_atribuicoes
        SET data_devolucao = @fim,
            obs = CASE WHEN @obs IS NULL THEN obs
                       WHEN obs IS NULL THEN @obs
                       ELSE obs + N' · ' + @obs END
        WHERE maquina_id = @id AND data_devolucao IS NULL`);

    if (!r.rowsAffected[0]) {
      return res.status(409).json({ error: 'Esta máquina não está entregue a ninguém.' });
    }
    res.json({ ok: true });
  } catch (err) {
    falhou(res, 'registar a devolução', err);
  }
});

module.exports = router;
