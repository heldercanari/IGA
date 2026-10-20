'use strict';

/**
 * Abates e autos de abate — as mesmas rotas para os cinco tipos.
 *
 * Cada router de tipo chama `montarAutos(router, cfg)` **antes** das suas rotas
 * `/:id`: o `/autos` é um nome fixo e o `/:id` apanhava-o (ver o CLAUDE.md, a
 * ordem das rotas). O `cfg` diz as tabelas e as colunas do tipo; o resto é igual
 * para todos — e é por isso que vive aqui e não cinco vezes. As páginas, essas,
 * continuam independentes.
 *
 * O fluxo (ver a migração 006):
 *   POST   /:id/abate                 propor para abate          (edição)
 *   DELETE /:id/abate                 retirar a proposta         (edição; abate antigo: administração)
 *   GET    /autos                     os autos deste tipo
 *   POST   /autos                     novo auto com os propostos (edição) — número dado ou sugerido
 *   GET    /autos/:auto               cabeçalho e linhas
 *   PUT    /autos/:auto               cabeçalho                  (edição, só em rascunho)
 *   POST   /autos/:auto/acrescentar   juntar os propostos soltos (edição, só em rascunho)
 *   DELETE /autos/:auto/itens/:abate  tirar uma linha do auto    (edição, só em rascunho)
 *   POST   /autos/:auto/homologar     abate tudo o que lá está   (administração)
 *   DELETE /autos/:auto               apagar um rascunho         (edição)
 *   GET    /autos/:auto/pdf           o auto no modelo da DMSI, com anexo
 *
 * ⚠️ **O cabeçalho vive na base do módulo e as linhas na base do tipo.** Nos
 * telemóveis são bases diferentes em desenvolvimento, por isso nada aqui faz
 * JOIN entre as duas: lê-se uma, depois a outra. Não é uma consulta que cruze
 * tipos — o cabeçalho é do módulo, como as permissões.
 */

const { poolPromise: poolModulo, sql } = require('../../../db');
const { exigirEdicao, exigirAdmin } = require('./permissoes');
const { limpar, inteiro, data, hoje, actor, falhou } = require('./comum');
const { gerarAutoPdf } = require('./auto_pdf');

/** "02/2023" — como o número aparece no papel. */
function numeroDoAuto(a) {
  return `${String(a.numero).padStart(2, '0')}/${a.ano}`;
}

/**
 * O número que se sugere para um auto novo: o seguinte ao maior do ano, em todas
 * as categorias — a numeração da PM é uma só. É só uma sugestão: quem preenche
 * o auto escreve o número que o papel tiver (decisão de 2026-10-20).
 */
async function numeroSugerido(ano) {
  const pool = await poolModulo;
  const r = await pool.request().input('ano', sql.Int, ano)
    .query('SELECT ISNULL(MAX(numero), 0) + 1 AS n FROM dbo.autos_abate WHERE ano = @ano');
  return r.recordset[0].n;
}

/** Outro auto com este número no mesmo ano? Devolve-o, para o erro dizer de que categoria é. */
async function numeroOcupado(ano, numero, excetoId) {
  const pool = await poolModulo;
  const r = await pool.request().input('ano', sql.Int, ano).input('n', sql.Int, numero)
    .input('id', sql.Int, excetoId || 0)
    .query('SELECT TOP 1 tipo FROM dbo.autos_abate WHERE ano = @ano AND numero = @n AND id <> @id');
  return r.recordset[0] || null;
}

/** "Sim — características" ou "Não": a coluna "Apto para doação" do modelo. */
function aptoTexto(apto, caracteristicas) {
  if (apto === true || apto === 1) return caracteristicas ? `Sim — ${caracteristicas}` : 'Sim';
  if (apto === false || apto === 0) return 'Não';
  return '';
}

/** O que vem no corpo para "apto para doação": sim/não, ou nada. */
function lerApto(v) {
  if (v === true || v === false) return v;
  const s = (limpar(v) || '').toLowerCase();
  if (['sim', 's', '1', 'true'].includes(s)) return true;
  if (['nao', 'não', 'n', '0', 'false'].includes(s)) return false;
  return null;
}

/** O auto de um abate, para o detalhe do equipamento dizer "Auto n.º 02/2023". */
async function autoResumo(autoId) {
  if (!autoId) return null;
  const pool = await poolModulo;
  const r = await pool.request().input('id', sql.Int, autoId)
    .query('SELECT id, ano, numero, data, estado FROM dbo.autos_abate WHERE id = @id');
  const a = r.recordset[0];
  return a ? { ...a, numero_texto: numeroDoAuto(a) } : null;
}

/**
 * cfg = {
 *   tipo: 'radios', nome: 'Rádios',   (o tipo tem de estar no CK_autos_abate_tipo — ver a 008)
 *   pool: <poolPromise do tipo>,
 *   equip: 'dbo.radios', abates: 'dbo.radios_abates', fk: 'radio_id',
 *   atribuicoes: 'dbo.radios_atribuicoes' | null,
 *   descricao, marca, serie, identificacao: expressões SQL sobre o alias `e`,
 *   recalcular: async (pool, id) => {} | null,
 * }
 */
function montarAutos(router, cfg) {
  const t = cfg;

  async function poolTipo(res) {
    const pool = await t.pool;
    if (!pool) res.status(500).json({ error: 'Sem ligação à base de dados.' });
    return pool;
  }

  async function lerAuto(id) {
    const pool = await poolModulo;
    const r = await pool.request().input('id', sql.Int, id).input('tipo', sql.VarChar(20), t.tipo)
      .query('SELECT * FROM dbo.autos_abate WHERE id = @id AND tipo = @tipo');
    return r.recordset[0] || null;
  }

  async function autoOu404(id, res) {
    const a = id === null ? null : await lerAuto(id);
    if (!a) res.status(404).json({ error: 'Auto não encontrado.' });
    return a;
  }

  /** As linhas de um auto, com o que o modelo pede de cada equipamento. */
  async function itensDoAuto(pool, autoId) {
    const r = await pool.request().input('auto', sql.Int, autoId).query(`
      SELECT b.id, b.${t.fk} AS equipamento_id, b.estado, b.motivo, b.apto_doacao, b.caracteristicas, b.obs,
             ${t.descricao} AS descricao, ${t.marca} AS marca, ${t.serie} AS serie,
             ${t.identificacao} AS identificacao
      FROM ${t.abates} b JOIN ${t.equip} e ON e.id = b.${t.fk}
      WHERE b.auto_id = @auto
      ORDER BY ${t.serie}, b.id`);
    return r.recordset;
  }

  // ─── Propor e retirar ─────────────────────────────────────

  router.post('/:id/abate', exigirEdicao, async (req, res) => {
    try {
      const id = inteiro(req.params.id);
      if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });
      const pool = await poolTipo(res);
      if (!pool) return;

      const existe = await pool.request().input('id', sql.Int, id)
        .query(`SELECT 1 AS ok FROM ${t.equip} WHERE id = @id`);
      if (!existe.recordset.length) return res.status(404).json({ error: 'Equipamento não encontrado.' });

      const ja = await pool.request().input('id', sql.Int, id)
        .query(`SELECT TOP 1 estado FROM ${t.abates} WHERE ${t.fk} = @id`);
      if (ja.recordset.length) {
        return res.status(409).json({ error: ja.recordset[0].estado === 'proposto'
          ? 'Já está proposto para abate.' : 'Já está abatido.' });
      }

      const b = req.body || {};
      const motivo = limpar(b.motivo);
      if (!motivo) return res.status(400).json({ error: 'Diz porque vai a abate.' });
      const apto = lerApto(b.apto_doacao);

      await pool.request()
        .input('id', sql.Int, id)
        .input('motivo', sql.NVarChar(200), motivo)
        .input('apto', sql.Bit, apto)
        .input('carac', sql.NVarChar(400), apto ? limpar(b.caracteristicas) : null)
        .input('obs', sql.NVarChar(sql.MAX), limpar(b.obs))
        .input('por', sql.NVarChar(120), actor(req))
        .query(`INSERT INTO ${t.abates} (${t.fk}, estado, motivo, apto_doacao, caracteristicas, obs, registado_por)
                VALUES (@id, 'proposto', @motivo, @apto, @carac, @obs, @por)`);

      if (t.recalcular) await t.recalcular(pool, id);
      res.status(201).json({ ok: true });
    } catch (err) {
      falhou(res, 'propor para abate', err);
    }
  });

  /**
   * Retirar a proposta — ou anular um abate antigo, de antes dos autos.
   * Um abate feito por auto homologado não se desfaz: o papel está assinado.
   */
  router.delete('/:id/abate', exigirEdicao, async (req, res) => {
    try {
      const id = inteiro(req.params.id);
      if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });
      const pool = await poolTipo(res);
      if (!pool) return;

      const r = await pool.request().input('id', sql.Int, id)
        .query(`SELECT TOP 1 id, estado, auto_id FROM ${t.abates} WHERE ${t.fk} = @id`);
      const ab = r.recordset[0];
      if (!ab) return res.status(404).json({ error: 'Não está proposto nem abatido.' });

      if (ab.estado === 'abatido') {
        if (ab.auto_id) {
          const a = await autoResumo(ab.auto_id);
          return res.status(409).json({ error: `Abatido pelo Auto de abate n.º ${a ? a.numero_texto : '?'} — não se anula.` });
        }
        if (!(req.igaUser && req.igaUser.canAdmin)) {
          return res.status(403).json({ error: 'Anular um abate é da administração.' });
        }
      }

      await pool.request().input('ab', sql.Int, ab.id).query(`DELETE FROM ${t.abates} WHERE id = @ab`);
      if (t.recalcular) await t.recalcular(pool, id);
      res.json({ ok: true });
    } catch (err) {
      falhou(res, 'retirar o abate', err);
    }
  });

  // ─── Autos ────────────────────────────────────────────────

  router.get('/autos', async (req, res) => {
    try {
      const pool = await poolTipo(res);
      if (!pool) return;
      const modulo = await poolModulo;
      const [autos, contagens, soltos] = await Promise.all([
        modulo.request().input('tipo', sql.VarChar(20), t.tipo)
          .query('SELECT * FROM dbo.autos_abate WHERE tipo = @tipo ORDER BY ano DESC, numero DESC'),
        pool.request().query(`SELECT auto_id, COUNT(*) AS n FROM ${t.abates} WHERE auto_id IS NOT NULL GROUP BY auto_id`),
        pool.request().query(`SELECT COUNT(*) AS n FROM ${t.abates} WHERE estado = 'proposto' AND auto_id IS NULL`),
      ]);
      const n = new Map(contagens.recordset.map(c => [c.auto_id, c.n]));
      const ano = new Date().getFullYear();
      res.json({
        propostos_soltos: soltos.recordset[0].n,
        proximo: { ano, numero: await numeroSugerido(ano) },
        autos: autos.recordset.map(a => ({ ...a, numero_texto: numeroDoAuto(a), itens: n.get(a.id) || 0 })),
      });
    } catch (err) {
      falhou(res, 'listar os autos de abate', err);
    }
  });

  /**
   * O número é o que vier no formulário — o do papel. Vazio, fica o sugerido. O
   * ano é o da data do auto, e no mesmo ano não há dois autos com o mesmo número,
   * seja de que categoria for.
   */
  router.post('/autos', exigirEdicao, async (req, res) => {
    let criado = null;
    try {
      const b = req.body || {};
      const quando = data(b.data);
      if (!quando) return res.status(400).json({ error: 'Falta a data do auto.' });
      const ano = Number(quando.slice(0, 4));
      const numero = limpar(b.numero) === null ? await numeroSugerido(ano) : inteiro(b.numero);
      if (!numero || numero < 1) return res.status(400).json({ error: 'O n.º do auto tem de ser um número.' });
      const ocupado = await numeroOcupado(ano, numero);
      if (ocupado) {
        return res.status(409).json({ error: `Já existe o Auto de abate n.º ${numeroDoAuto({ ano, numero })} (${ocupado.tipo}).` });
      }
      const pool = await poolTipo(res);
      if (!pool) return;

      const soltos = await pool.request()
        .query(`SELECT COUNT(*) AS n FROM ${t.abates} WHERE estado = 'proposto' AND auto_id IS NULL`);
      if (!soltos.recordset[0].n) {
        return res.status(409).json({ error: `Não há ${t.nome.toLowerCase()} propostos para abate fora de um auto.` });
      }

      const modulo = await poolModulo;
      const r = await modulo.request()
        .input('tipo', sql.VarChar(20), t.tipo)
        .input('ano', sql.Int, ano)
        .input('numero', sql.Int, numero)
        .input('data', sql.Date, quando)
        .input('c1', sql.NVarChar(200), limpar(b.comissao1))
        .input('c2', sql.NVarChar(200), limpar(b.comissao2))
        .input('c3', sql.NVarChar(200), limpar(b.comissao3))
        .input('destino', sql.NVarChar(300), limpar(b.destino))
        .input('valor', sql.NVarChar(300), limpar(b.valor))
        .input('obs', sql.NVarChar(sql.MAX), limpar(b.obs))
        .input('por', sql.NVarChar(120), actor(req))
        .query(`INSERT INTO dbo.autos_abate (tipo, ano, numero, data, comissao1, comissao2, comissao3, destino, valor, obs, registado_por)
                OUTPUT INSERTED.id, INSERTED.ano, INSERTED.numero
                VALUES (@tipo, @ano, @numero, @data, @c1, @c2, @c3, @destino, @valor, @obs, @por)`);
      criado = r.recordset[0];

      await pool.request().input('auto', sql.Int, criado.id)
        .query(`UPDATE ${t.abates} SET auto_id = @auto WHERE estado = 'proposto' AND auto_id IS NULL`);

      res.status(201).json({ id: criado.id, numero_texto: numeroDoAuto(criado) });
    } catch (err) {
      // As linhas estão noutra base: se a segunda escrita falhar, o cabeçalho
      // não pode ficar a ocupar um número sem nada dentro.
      if (criado) {
        try { (await poolModulo).request().input('id', sql.Int, criado.id).query('DELETE FROM dbo.autos_abate WHERE id = @id'); } catch (e) { /* fica no log abaixo */ }
      }
      // Dois a criar o mesmo número ao mesmo tempo: o índice único apanha o segundo.
      if (/UX_autos_abate_numero/.test(err.message)) {
        return res.status(409).json({ error: 'Esse n.º de auto acabou de ser usado. Escolha outro.' });
      }
      falhou(res, 'criar o auto de abate', err);
    }
  });

  router.get('/autos/:auto', async (req, res) => {
    try {
      const a = await autoOu404(inteiro(req.params.auto), res);
      if (!a) return;
      const pool = await poolTipo(res);
      if (!pool) return;
      const itens = await itensDoAuto(pool, a.id);
      res.json({ ...a, numero_texto: numeroDoAuto(a),
        itens: itens.map(i => ({ ...i, apto_texto: aptoTexto(i.apto_doacao, i.caracteristicas) })) });
    } catch (err) {
      falhou(res, 'obter o auto de abate', err);
    }
  });

  router.put('/autos/:auto', exigirEdicao, async (req, res) => {
    try {
      const a = await autoOu404(inteiro(req.params.auto), res);
      if (!a) return;
      if (a.estado !== 'rascunho') return res.status(409).json({ error: 'Um auto homologado já não se altera.' });

      const b = req.body || {};
      const quando = data(b.data) || (a.data instanceof Date ? a.data.toISOString().slice(0, 10) : a.data);
      // O ano é o da data, e o número corrige-se enquanto é rascunho.
      const ano = Number(String(quando).slice(0, 4));
      const numero = limpar(b.numero) === null ? a.numero : inteiro(b.numero);
      if (!numero || numero < 1) return res.status(400).json({ error: 'O n.º do auto tem de ser um número.' });
      const ocupado = await numeroOcupado(ano, numero, a.id);
      if (ocupado) {
        return res.status(409).json({ error: `Já existe o Auto de abate n.º ${numeroDoAuto({ ano, numero })} (${ocupado.tipo}).` });
      }
      await (await poolModulo).request()
        .input('id', sql.Int, a.id)
        .input('ano', sql.Int, ano)
        .input('numero', sql.Int, numero)
        .input('data', sql.Date, quando)
        .input('c1', sql.NVarChar(200), limpar(b.comissao1))
        .input('c2', sql.NVarChar(200), limpar(b.comissao2))
        .input('c3', sql.NVarChar(200), limpar(b.comissao3))
        .input('destino', sql.NVarChar(300), limpar(b.destino))
        .input('valor', sql.NVarChar(300), limpar(b.valor))
        .input('obs', sql.NVarChar(sql.MAX), limpar(b.obs))
        .query(`UPDATE dbo.autos_abate SET ano = @ano, numero = @numero, data = @data,
                  comissao1 = @c1, comissao2 = @c2, comissao3 = @c3,
                  destino = @destino, valor = @valor, obs = @obs WHERE id = @id`);
      res.json({ ok: true });
    } catch (err) {
      falhou(res, 'gravar o auto de abate', err);
    }
  });

  router.post('/autos/:auto/acrescentar', exigirEdicao, async (req, res) => {
    try {
      const a = await autoOu404(inteiro(req.params.auto), res);
      if (!a) return;
      if (a.estado !== 'rascunho') return res.status(409).json({ error: 'Um auto homologado já não se altera.' });
      const pool = await poolTipo(res);
      if (!pool) return;
      const r = await pool.request().input('auto', sql.Int, a.id)
        .query(`UPDATE ${t.abates} SET auto_id = @auto WHERE estado = 'proposto' AND auto_id IS NULL`);
      res.json({ acrescentados: r.rowsAffected[0] });
    } catch (err) {
      falhou(res, 'acrescentar ao auto', err);
    }
  });

  router.delete('/autos/:auto/itens/:abate', exigirEdicao, async (req, res) => {
    try {
      const a = await autoOu404(inteiro(req.params.auto), res);
      if (!a) return;
      if (a.estado !== 'rascunho') return res.status(409).json({ error: 'Um auto homologado já não se altera.' });
      const pool = await poolTipo(res);
      if (!pool) return;
      // Sai do auto mas continua proposto: fica à espera do próximo.
      const r = await pool.request().input('auto', sql.Int, a.id).input('ab', sql.Int, inteiro(req.params.abate))
        .query(`UPDATE ${t.abates} SET auto_id = NULL WHERE id = @ab AND auto_id = @auto AND estado = 'proposto'`);
      if (!r.rowsAffected[0]) return res.status(404).json({ error: 'Essa linha não está neste auto.' });
      res.json({ ok: true });
    } catch (err) {
      falhou(res, 'tirar do auto', err);
    }
  });

  /**
   * Homologar: o auto foi assinado. Tudo o que lá está fica abatido na data do
   * auto, as entregas abertas fecham nessa data, e o estado é recalculado.
   */
  router.post('/autos/:auto/homologar', exigirAdmin, async (req, res) => {
    try {
      const a = await autoOu404(inteiro(req.params.auto), res);
      if (!a) return;
      if (a.estado !== 'rascunho') return res.status(409).json({ error: 'Este auto já está homologado.' });
      const pool = await poolTipo(res);
      if (!pool) return;

      const itens = await itensDoAuto(pool, a.id);
      if (!itens.length) return res.status(409).json({ error: 'O auto não tem nenhum equipamento.' });

      // Numa transação: ou fica tudo abatido, ou nada. Fora dela, uma falha a meio
      // deixava parte do auto abatida, parte não, e o auto ainda por homologar.
      // O `recalcular` recebe a transação no lugar da pool — as duas têm `.request()`.
      const tx = new sql.Transaction(pool);
      await tx.begin();
      try {
        if (t.atribuicoes) {
          await tx.request().input('auto', sql.Int, a.id).input('fim', sql.Date, a.data)
            .query(`UPDATE ${t.atribuicoes} SET data_devolucao = @fim
                    WHERE data_devolucao IS NULL
                      AND ${t.fk} IN (SELECT ${t.fk} FROM ${t.abates} WHERE auto_id = @auto)`);
        }
        await tx.request().input('auto', sql.Int, a.id).input('quando', sql.Date, a.data)
          .query(`UPDATE ${t.abates} SET estado = 'abatido', data_abate = @quando WHERE auto_id = @auto`);
        if (t.recalcular) for (const i of itens) await t.recalcular(tx, i.equipamento_id);
        await tx.commit();
      } catch (e) {
        await tx.rollback().catch(() => {});
        throw e;
      }

      const quandoHomologado = data(req.body && req.body.data_homologacao) || hoje();
      await (await poolModulo).request().input('id', sql.Int, a.id).input('h', sql.Date, quandoHomologado)
        .query(`UPDATE dbo.autos_abate SET estado = 'homologado', data_homologacao = @h WHERE id = @id`);

      console.warn(`[iga/${t.tipo}] Auto de abate ${numeroDoAuto(a)} homologado por ${actor(req)}: ${itens.length} equipamentos.`);
      res.json({ ok: true, abatidos: itens.length });
    } catch (err) {
      falhou(res, 'homologar o auto', err);
    }
  });

  /** Só se apaga um rascunho: um auto homologado é papel assinado. */
  router.delete('/autos/:auto', exigirEdicao, async (req, res) => {
    try {
      const a = await autoOu404(inteiro(req.params.auto), res);
      if (!a) return;
      if (a.estado !== 'rascunho') return res.status(409).json({ error: 'Um auto homologado não se apaga.' });
      const modulo = await poolModulo;
      const pool = await poolTipo(res);
      if (!pool) return;
      await pool.request().input('auto', sql.Int, a.id)
        .query(`UPDATE ${t.abates} SET auto_id = NULL WHERE auto_id = @auto`);
      await modulo.request().input('id', sql.Int, a.id).query('DELETE FROM dbo.autos_abate WHERE id = @id');
      res.json({ ok: true });
    } catch (err) {
      falhou(res, 'apagar o auto', err);
    }
  });

  router.get('/autos/:auto/pdf', async (req, res) => {
    try {
      const a = await autoOu404(inteiro(req.params.auto), res);
      if (!a) return;
      const pool = await poolTipo(res);
      if (!pool) return;
      const itens = await itensDoAuto(pool, a.id);
      const pdf = await gerarAutoPdf({
        numero: a.numero, ano: a.ano, data: a.data, tipo: t.nome,
        comissao: [a.comissao1, a.comissao2, a.comissao3],
        destino: a.destino, valor: a.valor,
        itens: itens.map(i => ({ descricao: i.descricao, apto: aptoTexto(i.apto_doacao, i.caracteristicas),
                                 marca: i.marca, serie: i.serie, qt: 1 })),
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition',
        `inline; filename="auto_abate_${String(a.numero).padStart(2, '0')}_${a.ano}_${t.tipo}.pdf"`);
      res.send(pdf);
    } catch (err) {
      falhou(res, 'gerar o PDF do auto', err);
    }
  });
}

/**
 * O abate de um equipamento, para o detalhe: a linha e, se tiver, o seu auto.
 * `null` quando não está proposto nem abatido.
 */
async function abateDoEquipamento(pool, cfg, id) {
  const r = await pool.request().input('id', sql.Int, id)
    .query(`SELECT TOP 1 * FROM ${cfg.abates} WHERE ${cfg.fk} = @id ORDER BY id DESC`);
  const ab = r.recordset[0];
  if (!ab) return null;
  return { ...ab, auto: await autoResumo(ab.auto_id), apto_texto: aptoTexto(ab.apto_doacao, ab.caracteristicas) };
}

module.exports = { montarAutos, abateDoEquipamento, numeroDoAuto };
