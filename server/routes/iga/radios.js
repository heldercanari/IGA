'use strict';

/**
 * Rádios — porte do ficheiro `Radios apanhado.xlsx` (OneDrive, 7 folhas) para o
 * Express da intranet.
 *
 * Montado pelo `index.js` em `/radios`, **dentro do gate de VER**: as mutações
 * levam ainda `exigirEdicao` por-rota, e o abate/remoção `exigirAdmin`.
 * Endereço final das rotas: `/api/iga/radios/…`.
 *
 * Correspondência com as folhas de origem:
 *   Radios            → GET|POST /              (+ /:id/atribuir, /:id/devolver)
 *   Radios Avariados  → POST /:id/avarias, POST /avarias/:id/reparar
 *   Folha1            → a mesma coisa: era a lista dos avariados com nº de série
 *   Radios - Abate    → POST /:id/abate
 *   TEI               → GET /sistema            (registo do TETRA, só leitura)
 *   Quest             → GET /conferencia        (o cruzamento com o questionário)
 *   Motorola          → entra pela importação, marca=Motorola
 *
 * ⚠️ **A ORDEM DAS ROTAS AQUI É SIGNIFICATIVA.** O `/sistema`, o `/conferencia`
 * e o `/utilizadores` estão escritos ANTES do `/:id` de propósito: o Express
 * serve a primeira que casa, e o `/:id` apanha qualquer palavra. Uma rota nova
 * com nome fixo vai para cima do `/:id`, não para o fim do ficheiro.
 *
 * A alternativa — restringir o parâmetro com `/:id(\d+)` — foi tentada e **não
 * funciona nesta versão do Express** (4.22): a rota deixa de casar de todo e o
 * pedido morre num "Cannot GET /api/iga/radios/791". Se um dia apetecer
 * voltar a isso, abrir o detalhe de um rádio antes de dar por bom.
 */

const express = require('express');
const router = express.Router();

const { poolPromise, sql } = require('../../../db');
const { exigirEdicao, exigirAdmin } = require('./permissoes');
const { limpar, inteiro, data, hoje, actor, falhou } = require('./comum');

const ESTADOS = ['disponivel', 'atribuido', 'avariado', 'abatido'];

// ─── Helpers ───────────────────────────────────────────────
// Os que os telemóveis também usam vivem em ./comum.js — ver o cabeçalho de lá.

/**
 * Reavalia o estado do rádio a partir dos factos e grava-o.
 *
 * O estado é coluna e não consulta (ver a migração 001), mas quem o escreve é
 * só esta função: qualquer rota que mexa em atribuições, avarias ou abates
 * chama-a a seguir. A precedência é abatido > avariado > atribuído >
 * disponível, porque é assim que a PM olha para o equipamento — um rádio
 * entregue a alguém mas avariado conta como avariado para efeitos de parque.
 */
async function recalcularEstado(pool, radioId) {
  await pool.request()
    .input('id', sql.Int, radioId)
    .query(`
      UPDATE dbo.radios
      SET estado = CASE
            WHEN EXISTS (SELECT 1 FROM dbo.radios_abates  WHERE radio_id = @id) THEN 'abatido'
            WHEN EXISTS (SELECT 1 FROM dbo.radios_avarias WHERE radio_id = @id AND estado = 'aberta') THEN 'avariado'
            WHEN EXISTS (SELECT 1 FROM dbo.radios_atribuicoes WHERE radio_id = @id AND data_devolucao IS NULL) THEN 'atribuido'
            ELSE 'disponivel'
          END,
          atualizado_em = GETDATE()
      WHERE id = @id`);
}

/** O rádio existe? Devolve a linha ou responde 404 e devolve null. */
async function radioOu404(pool, id, res) {
  const r = await pool.request()
    .input('id', sql.Int, id)
    .query('SELECT * FROM dbo.radios WHERE id = @id');
  const row = r.recordset && r.recordset[0];
  if (!row) {
    res.status(404).json({ error: 'Rádio não encontrado.' });
    return null;
  }
  return row;
}

// ─── Estatísticas do topo do ecrã ──────────────────────────

router.get('/estatisticas', async (req, res) => {
  try {
    const pool = await poolPromise;
    const r = await pool.request().query(`
      SELECT
        (SELECT COUNT(*) FROM dbo.radios)                                              AS total,
        (SELECT COUNT(*) FROM dbo.radios WHERE estado = 'atribuido')                   AS atribuidos,
        (SELECT COUNT(*) FROM dbo.radios WHERE estado = 'disponivel')                  AS disponiveis,
        (SELECT COUNT(*) FROM dbo.radios WHERE estado = 'avariado')                    AS avariados,
        (SELECT COUNT(*) FROM dbo.radios WHERE estado = 'abatido')                     AS abatidos,
        (SELECT COUNT(*) FROM dbo.radios WHERE num_serie IS NULL)                      AS sem_serie,
        (SELECT COUNT(*) FROM dbo.radios_avarias WHERE estado = 'aberta')              AS avarias_abertas,
        (SELECT COUNT(*) FROM dbo.radios_sistema)                                      AS no_sistema,
        (SELECT COUNT(*) FROM dbo.radios_conferencia)                                  AS respostas_conferencia,
        (SELECT TOP 1 executado_em FROM dbo.radios_importacoes ORDER BY id DESC)       AS ultima_importacao`);

    const marcas = await pool.request().query(`
      SELECT ISNULL(marca, N'(sem marca)') AS marca, COUNT(*) AS total
      FROM dbo.radios GROUP BY marca ORDER BY COUNT(*) DESC`);

    const avarias = await pool.request().query(`
      SELECT ISNULL(tipo_avaria, N'(por classificar)') AS tipo, COUNT(*) AS total
      FROM dbo.radios_avarias WHERE estado = 'aberta'
      GROUP BY tipo_avaria ORDER BY COUNT(*) DESC`);

    res.json({
      ...r.recordset[0],
      marcas: marcas.recordset,
      avarias_por_tipo: avarias.recordset,
    });
  } catch (err) {
    falhou(res, 'obter estatísticas', err);
  }
});

// ─── Registo do sistema TETRA (folha TEI) ──────────────────

router.get('/sistema', async (req, res) => {
  try {
    const pool = await poolPromise;
    const pedido = pool.request();
    const q = limpar(req.query.q);
    let where = '';
    if (q) {
      pedido.input('q', sql.NVarChar(200), `%${q}%`);
      where = `WHERE alias LIKE @q OR num_serie LIKE @q OR indicativo LIKE @q
               OR CAST(radio_id AS NVARCHAR(20)) LIKE @q`;
    }
    const r = await pedido.query(`SELECT TOP 1000 * FROM dbo.radios_sistema ${where} ORDER BY radio_id`);
    res.json(r.recordset);
  } catch (err) {
    falhou(res, 'consultar o registo do sistema', err);
  }
});

// ─── Conferência: o questionário contra o registo ──────────

/**
 * GET /conferencia?situacao=
 *
 * Cruza as respostas do questionário com o que está registado. Duas direcções,
 * porque as duas falham de maneiras diferentes:
 *   1. quem respondeu — o que diz bate certo com o que lhe está entregue?
 *   2. quem tem rádio entregue e não respondeu — ninguém confirmou que o tem.
 *
 * Só conta a ÚLTIMA resposta de cada matrícula: houve quem respondesse duas
 * vezes, e a primeira não é uma divergência, é um rascunho.
 *
 * As situações:
 *   ok             → declarou ter, e o indicativo é um dos que lhe estão entregues
 *   divergente     → declarou ter, mas com outro indicativo
 *   nao_registado  → declarou ter, e não há registo de rádio entregue a esta pessoa
 *   nao_declarado  → declarou NÃO ter, mas está-lhe um rádio entregue
 *   sem_resposta   → tem rádio entregue e não respondeu ao questionário
 */
router.get('/conferencia', async (req, res) => {
  try {
    const pool = await poolPromise;
    const r = await pool.request().query(`
      WITH ultima AS (
        SELECT c.*,
               ROW_NUMBER() OVER (PARTITION BY c.matricula
                                  ORDER BY ISNULL(c.data_resposta, '1900-01-01') DESC, c.id DESC) AS rn
        FROM dbo.radios_conferencia c
        WHERE c.matricula IS NOT NULL
      ),
      entregues AS (
        SELECT a.matricula,
               MIN(a.nome_utilizador)                  AS nome_registado,
               COUNT(*)                                AS n_radios,
               STRING_AGG(CAST(r.indicativo AS NVARCHAR(20)), N', ')
                 WITHIN GROUP (ORDER BY r.indicativo)  AS indicativos
        FROM dbo.radios_atribuicoes a
        INNER JOIN dbo.radios r ON r.id = a.radio_id
        WHERE a.data_devolucao IS NULL AND a.matricula IS NOT NULL AND r.estado <> 'abatido'
        GROUP BY a.matricula
      )
      SELECT
        u.matricula, u.nome, u.email, u.data_resposta, u.tem_radio,
        u.indicativo_declarado, u.baterias,
        e.indicativos AS indicativos_registados, e.n_radios,
        CASE
          WHEN u.tem_radio = 'SIM' AND e.matricula IS NULL THEN 'nao_registado'
          WHEN u.tem_radio = 'SIM' AND u.indicativo_declarado IS NOT NULL
               AND N',' + REPLACE(e.indicativos, N' ', N'') + N','
                   NOT LIKE N'%,' + u.indicativo_declarado + N',%' THEN 'divergente'
          WHEN u.tem_radio = 'NAO' AND e.matricula IS NOT NULL THEN 'nao_declarado'
          ELSE 'ok'
        END AS situacao
      FROM ultima u
      LEFT JOIN entregues e ON e.matricula = u.matricula
      WHERE u.rn = 1

      UNION ALL

      SELECT
        e.matricula, e.nome_registado AS nome, NULL AS email, NULL AS data_resposta,
        NULL AS tem_radio, NULL AS indicativo_declarado, NULL AS baterias,
        e.indicativos AS indicativos_registados, e.n_radios,
        'sem_resposta' AS situacao
      FROM entregues e
      WHERE NOT EXISTS (SELECT 1 FROM ultima u WHERE u.matricula = e.matricula AND u.rn = 1)

      ORDER BY situacao, matricula`);

    const linhas = r.recordset;
    const resumo = linhas.reduce((acc, l) => {
      acc[l.situacao] = (acc[l.situacao] || 0) + 1;
      return acc;
    }, {});

    // `?so=resumo` devolve só as contagens. É o que a página de entrada precisa,
    // e evita mandar-lhe as 420 linhas para mostrar um número.
    if (limpar(req.query.so) === 'resumo') return res.json({ resumo, total: linhas.length });

    const situacao = limpar(req.query.situacao);
    res.json({
      resumo,
      total: linhas.length,
      linhas: situacao ? linhas.filter(l => l.situacao === situacao) : linhas,
    });
  } catch (err) {
    falhou(res, 'cruzar a conferência', err);
  }
});

// ─── Pessoas, para o autocompletar da entrega ──────────────

/**
 * GET /utilizadores?q= — matrículas e nomes já conhecidos.
 *
 * A fonte é o questionário (405 pessoas com matrícula, nome e email) e o
 * histórico de entregas. Não é `colaboradores`: essa é a vista do cadastro de RH
 * e traz a autarquia inteira, onde quase ninguém tem rádio.
 */
router.get('/utilizadores', async (req, res) => {
  try {
    const pool = await poolPromise;
    const pedido = pool.request();
    const q = limpar(req.query.q);
    let filtro = '';
    if (q) {
      pedido.input('q', sql.NVarChar(200), `%${q}%`);
      filtro = 'WHERE nome LIKE @q OR CAST(matricula AS NVARCHAR(20)) LIKE @q';
    }
    const r = await pedido.query(`
      SELECT TOP 50 matricula, MIN(nome) AS nome, MIN(email) AS email
      FROM (
        SELECT matricula, nome, email FROM dbo.radios_conferencia WHERE matricula IS NOT NULL
        UNION ALL
        SELECT matricula, nome_utilizador, NULL FROM dbo.radios_atribuicoes WHERE matricula IS NOT NULL
      ) AS pessoas
      ${filtro}
      GROUP BY matricula
      ORDER BY MIN(nome)`);
    res.json(r.recordset);
  } catch (err) {
    falhou(res, 'listar as pessoas', err);
  }
});

// ─── Listagem do parque ────────────────────────────────────

/**
 * GET /radios?q=&estado=&marca=
 *
 * `q` procura em série, indicativo, alias, modelo e no nome de quem o tem.
 * A ordenação é pelo indicativo tratado como número (`TRY_CONVERT`): ordenar o
 * texto punha o 1000 antes do 99, e o indicativo é lido como número por quem
 * trabalha com ele. Os que não têm indicativo vão para o fim.
 */
router.get('/', async (req, res) => {
  try {
    const pool = await poolPromise;
    const pedido = pool.request();
    const filtros = [];

    const q = limpar(req.query.q);
    if (q) {
      pedido.input('q', sql.NVarChar(200), `%${q}%`);
      filtros.push(`(r.num_serie LIKE @q OR r.indicativo LIKE @q OR r.alias_tei LIKE @q
                     OR r.modelo LIKE @q OR r.marca LIKE @q OR r.tie LIKE @q
                     OR a.nome_utilizador LIKE @q OR CAST(a.matricula AS NVARCHAR(20)) LIKE @q)`);
    }
    const estado = limpar(req.query.estado);
    if (estado && ESTADOS.includes(estado)) {
      pedido.input('estado', sql.VarChar(20), estado);
      filtros.push('r.estado = @estado');
    }
    const marca = limpar(req.query.marca);
    if (marca) {
      pedido.input('marca', sql.NVarChar(40), marca);
      filtros.push('r.marca = @marca');
    }

    const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
    const r = await pedido.query(`
      SELECT TOP 2000
        r.id, r.num_serie, r.indicativo, r.marca, r.modelo, r.alias_tei, r.radio_id_tei,
        r.tie, r.estado, r.obs,
        a.id AS atribuicao_id, a.matricula, a.nome_utilizador, a.data_entrega, a.guia,
        av.id AS avaria_id, av.tipo_avaria, av.ordem, av.localizacao,
        ab.data_abate, ab.motivo AS motivo_abate
      FROM dbo.radios r
      OUTER APPLY (
        SELECT TOP 1 * FROM dbo.radios_atribuicoes x
        WHERE x.radio_id = r.id AND x.data_devolucao IS NULL
        ORDER BY x.data_entrega DESC, x.id DESC) a
      OUTER APPLY (
        SELECT TOP 1 * FROM dbo.radios_avarias x
        WHERE x.radio_id = r.id AND x.estado = 'aberta'
        ORDER BY x.id DESC) av
      OUTER APPLY (
        SELECT TOP 1 * FROM dbo.radios_abates x
        WHERE x.radio_id = r.id ORDER BY x.id DESC) ab
      ${where}
      ORDER BY
        CASE WHEN TRY_CONVERT(INT, r.indicativo) IS NULL THEN 1 ELSE 0 END,
        TRY_CONVERT(INT, r.indicativo),
        r.indicativo, r.id`);

    res.json(r.recordset);
  } catch (err) {
    falhou(res, 'listar os rádios', err);
  }
});

/** GET /radios/:id — o equipamento com todo o historial e o que o sistema sabe dele. */
router.get('/:id', async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });

    const pool = await poolPromise;
    const radio = await radioOu404(pool, id, res);
    if (!radio) return;

    const [atribuicoes, avarias, abate, sistema] = await Promise.all([
      pool.request().input('id', sql.Int, id).query(
        'SELECT * FROM dbo.radios_atribuicoes WHERE radio_id = @id ORDER BY ISNULL(data_entrega, \'1900-01-01\') DESC, id DESC'),
      pool.request().input('id', sql.Int, id).query(
        'SELECT * FROM dbo.radios_avarias WHERE radio_id = @id ORDER BY id DESC'),
      pool.request().input('id', sql.Int, id).query(
        'SELECT TOP 1 * FROM dbo.radios_abates WHERE radio_id = @id ORDER BY id DESC'),
      // O cruzamento com o TETRA é por série, e só por série: o alias também dá
      // um palpite, mas é texto escrito à mão em duas listas diferentes.
      pool.request().input('serie', sql.NVarChar(60), radio.num_serie).query(
        'SELECT TOP 1 * FROM dbo.radios_sistema WHERE num_serie IS NOT NULL AND num_serie = @serie'),
    ]);

    res.json({
      ...radio,
      atribuicoes: atribuicoes.recordset,
      avarias: avarias.recordset,
      abate: abate.recordset[0] || null,
      sistema: sistema.recordset[0] || null,
    });
  } catch (err) {
    falhou(res, 'obter o rádio', err);
  }
});

// ─── Criar e editar equipamento ────────────────────────────

router.post('/', exigirEdicao, async (req, res) => {
  try {
    const b = req.body || {};
    const num_serie = limpar(b.num_serie);
    const indicativo = limpar(b.indicativo);
    if (!num_serie && !indicativo) {
      return res.status(400).json({ error: 'É preciso pelo menos o número de série ou o indicativo.' });
    }

    const pool = await poolPromise;
    if (num_serie) {
      const dup = await pool.request()
        .input('s', sql.NVarChar(60), num_serie)
        .query('SELECT TOP 1 id FROM dbo.radios WHERE num_serie = @s');
      if (dup.recordset.length) {
        return res.status(409).json({ error: `Já existe um rádio com o número de série ${num_serie}.`, id: dup.recordset[0].id });
      }
    }

    const r = await pool.request()
      .input('num_serie', sql.NVarChar(60), num_serie)
      .input('indicativo', sql.NVarChar(20), indicativo)
      .input('marca', sql.NVarChar(40), limpar(b.marca))
      .input('modelo', sql.NVarChar(60), limpar(b.modelo))
      .input('alias_tei', sql.NVarChar(60), limpar(b.alias_tei))
      .input('radio_id_tei', sql.Int, inteiro(b.radio_id_tei))
      .input('tie', sql.NVarChar(40), limpar(b.tie))
      .input('obs', sql.NVarChar(sql.MAX), limpar(b.obs))
      .query(`
        INSERT INTO dbo.radios (num_serie, indicativo, marca, modelo, alias_tei, radio_id_tei, tie, obs)
        OUTPUT INSERTED.id
        VALUES (@num_serie, @indicativo, @marca, @modelo, @alias_tei, @radio_id_tei, @tie, @obs)`);

    res.status(201).json({ id: r.recordset[0].id });
  } catch (err) {
    falhou(res, 'criar o rádio', err);
  }
});

router.put('/:id', exigirEdicao, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });

    const pool = await poolPromise;
    if (!await radioOu404(pool, id, res)) return;

    const b = req.body || {};
    await pool.request()
      .input('id', sql.Int, id)
      .input('num_serie', sql.NVarChar(60), limpar(b.num_serie))
      .input('indicativo', sql.NVarChar(20), limpar(b.indicativo))
      .input('marca', sql.NVarChar(40), limpar(b.marca))
      .input('modelo', sql.NVarChar(60), limpar(b.modelo))
      .input('alias_tei', sql.NVarChar(60), limpar(b.alias_tei))
      .input('radio_id_tei', sql.Int, inteiro(b.radio_id_tei))
      .input('tie', sql.NVarChar(40), limpar(b.tie))
      .input('obs', sql.NVarChar(sql.MAX), limpar(b.obs))
      .query(`
        UPDATE dbo.radios
        SET num_serie = @num_serie, indicativo = @indicativo, marca = @marca, modelo = @modelo,
            alias_tei = @alias_tei, radio_id_tei = @radio_id_tei, tie = @tie, obs = @obs,
            atualizado_em = GETDATE()
        WHERE id = @id`);

    res.json({ ok: true });
  } catch (err) {
    if (/UX_radios_num_serie/.test(err.message)) {
      return res.status(409).json({ error: 'Já existe outro rádio com esse número de série.' });
    }
    falhou(res, 'gravar o rádio', err);
  }
});

/** Apagar é de administração e apaga o historial todo em cascata (ver migração 001). */
router.delete('/:id', exigirAdmin, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });
    const pool = await poolPromise;
    if (!await radioOu404(pool, id, res)) return;
    await pool.request().input('id', sql.Int, id).query('DELETE FROM dbo.radios WHERE id = @id');
    res.json({ ok: true });
  } catch (err) {
    falhou(res, 'apagar o rádio', err);
  }
});

// ─── Entregas e devoluções ─────────────────────────────────

/**
 * POST /radios/:id/atribuir — entrega a alguém.
 *
 * Uma atribuição aberta que ainda exista é fechada com a data da nova entrega:
 * no ficheiro de origem, trocar de utilizador era escrever por cima do nome
 * anterior, e o histórico perdia-se. Aqui a entrega anterior fica fechada e
 * legível.
 */
router.post('/:id/atribuir', exigirEdicao, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });

    const pool = await poolPromise;
    const radio = await radioOu404(pool, id, res);
    if (!radio) return;
    if (radio.estado === 'abatido') {
      return res.status(409).json({ error: 'Este rádio está abatido — não pode ser entregue.' });
    }

    const b = req.body || {};
    const nome = limpar(b.nome_utilizador);
    const matricula = inteiro(b.matricula);
    if (!nome && matricula === null) {
      return res.status(400).json({ error: 'É preciso a matrícula ou o nome de quem fica com o rádio.' });
    }
    const entrega = data(b.data_entrega) || hoje();

    await pool.request()
      .input('id', sql.Int, id)
      .input('fim', sql.Date, entrega)
      .query(`UPDATE dbo.radios_atribuicoes SET data_devolucao = @fim
              WHERE radio_id = @id AND data_devolucao IS NULL`);

    const r = await pool.request()
      .input('radio_id', sql.Int, id)
      .input('matricula', sql.Int, matricula)
      .input('nome', sql.NVarChar(200), nome)
      .input('entrega', sql.Date, entrega)
      .input('guia', sql.NVarChar(60), limpar(b.guia))
      .input('obs', sql.NVarChar(sql.MAX), limpar(b.obs))
      .input('por', sql.NVarChar(120), actor(req))
      .query(`
        INSERT INTO dbo.radios_atribuicoes (radio_id, matricula, nome_utilizador, data_entrega, guia, obs, registado_por)
        OUTPUT INSERTED.id
        VALUES (@radio_id, @matricula, @nome, @entrega, @guia, @obs, @por)`);

    await recalcularEstado(pool, id);
    res.status(201).json({ id: r.recordset[0].id });
  } catch (err) {
    falhou(res, 'registar a entrega', err);
  }
});

/** POST /radios/:id/devolver — fecha a atribuição activa. */
router.post('/:id/devolver', exigirEdicao, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });

    const pool = await poolPromise;
    if (!await radioOu404(pool, id, res)) return;

    const b = req.body || {};
    const r = await pool.request()
      .input('id', sql.Int, id)
      .input('fim', sql.Date, data(b.data_devolucao) || hoje())
      .input('obs', sql.NVarChar(sql.MAX), limpar(b.obs))
      .query(`
        UPDATE dbo.radios_atribuicoes
        SET data_devolucao = @fim,
            obs = CASE WHEN @obs IS NULL THEN obs
                       WHEN obs IS NULL THEN @obs
                       ELSE obs + N' · ' + @obs END
        WHERE radio_id = @id AND data_devolucao IS NULL`);

    if (!r.rowsAffected[0]) {
      return res.status(409).json({ error: 'Este rádio não está entregue a ninguém.' });
    }
    await recalcularEstado(pool, id);
    res.json({ ok: true });
  } catch (err) {
    falhou(res, 'registar a devolução', err);
  }
});

// ─── Avarias ───────────────────────────────────────────────

router.post('/:id/avarias', exigirEdicao, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });

    const pool = await poolPromise;
    const radio = await radioOu404(pool, id, res);
    if (!radio) return;
    if (radio.estado === 'abatido') {
      return res.status(409).json({ error: 'Este rádio está abatido — não faz sentido registar avarias.' });
    }

    const b = req.body || {};
    const r = await pool.request()
      .input('radio_id', sql.Int, id)
      .input('tipo', sql.NVarChar(120), limpar(b.tipo_avaria))
      .input('ordem', sql.VarChar(10), limpar(b.ordem))
      .input('local', sql.NVarChar(60), limpar(b.localizacao) || 'Aguarda Reparação')
      .input('registo', sql.Date, data(b.data_registo) || hoje())
      .input('obs', sql.NVarChar(sql.MAX), limpar(b.obs))
      .input('por', sql.NVarChar(120), actor(req))
      .query(`
        INSERT INTO dbo.radios_avarias (radio_id, tipo_avaria, ordem, localizacao, data_registo, obs, registado_por)
        OUTPUT INSERTED.id
        VALUES (@radio_id, @tipo, @ordem, @local, @registo, @obs, @por)`);

    await recalcularEstado(pool, id);
    res.status(201).json({ id: r.recordset[0].id });
  } catch (err) {
    falhou(res, 'registar a avaria', err);
  }
});

/**
 * POST /avarias/:id/reparar — fecha a avaria.
 * `estado` pode ser 'reparada' (volta ao parque) ou 'irreparavel' (fica fechada
 * e o rádio disponível para abate — abater é decisão separada, e de admin).
 */
router.post('/avarias/:id/reparar', exigirEdicao, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });

    const b = req.body || {};
    const estado = limpar(b.estado) === 'irreparavel' ? 'irreparavel' : 'reparada';

    const pool = await poolPromise;
    const r = await pool.request()
      .input('id', sql.Int, id)
      .input('estado', sql.VarChar(20), estado)
      .input('fim', sql.Date, data(b.data_reparacao) || hoje())
      .input('obs', sql.NVarChar(sql.MAX), limpar(b.obs))
      .query(`
        UPDATE dbo.radios_avarias
        SET estado = @estado, data_reparacao = @fim,
            obs = CASE WHEN @obs IS NULL THEN obs
                       WHEN obs IS NULL THEN @obs
                       ELSE obs + N' · ' + @obs END
        OUTPUT INSERTED.radio_id
        WHERE id = @id AND estado = 'aberta'`);

    const linha = r.recordset && r.recordset[0];
    if (!linha) return res.status(409).json({ error: 'Avaria não encontrada ou já fechada.' });

    await recalcularEstado(pool, linha.radio_id);
    res.json({ ok: true, radio_id: linha.radio_id });
  } catch (err) {
    falhou(res, 'fechar a avaria', err);
  }
});

// ─── Abate ─────────────────────────────────────────────────

/**
 * POST /radios/:id/abate — tira o equipamento do parque sem o apagar.
 * A atribuição activa é fechada: um rádio abatido não pode continuar entregue.
 */
router.post('/:id/abate', exigirAdmin, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });

    const pool = await poolPromise;
    const radio = await radioOu404(pool, id, res);
    if (!radio) return;

    const b = req.body || {};
    const quando = data(b.data_abate) || hoje();

    const jaAbatido = await pool.request()
      .input('id', sql.Int, id)
      .query('SELECT TOP 1 id FROM dbo.radios_abates WHERE radio_id = @id');
    if (jaAbatido.recordset.length) {
      return res.status(409).json({ error: 'Este rádio já está abatido.' });
    }

    await pool.request()
      .input('id', sql.Int, id).input('fim', sql.Date, quando)
      .query('UPDATE dbo.radios_atribuicoes SET data_devolucao = @fim WHERE radio_id = @id AND data_devolucao IS NULL');

    await pool.request()
      .input('radio_id', sql.Int, id)
      .input('quando', sql.Date, quando)
      .input('motivo', sql.NVarChar(200), limpar(b.motivo))
      .input('obs', sql.NVarChar(sql.MAX), limpar(b.obs))
      .input('por', sql.NVarChar(120), actor(req))
      .query(`INSERT INTO dbo.radios_abates (radio_id, data_abate, motivo, obs, registado_por)
              VALUES (@radio_id, @quando, @motivo, @obs, @por)`);

    await recalcularEstado(pool, id);
    res.status(201).json({ ok: true });
  } catch (err) {
    falhou(res, 'registar o abate', err);
  }
});

/** Anular um abate feito por engano — o rádio volta ao parque. */
router.delete('/:id/abate', exigirAdmin, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });
    const pool = await poolPromise;
    const r = await pool.request().input('id', sql.Int, id)
      .query('DELETE FROM dbo.radios_abates WHERE radio_id = @id');
    if (!r.rowsAffected[0]) return res.status(404).json({ error: 'Este rádio não está abatido.' });
    await recalcularEstado(pool, id);
    res.json({ ok: true });
  } catch (err) {
    falhou(res, 'anular o abate', err);
  }
});

module.exports = router;
