'use strict';

/**
 * Tipos de equipamento criados pelo ecrã — a definição de cada um.
 *
 * Montado pelo `index.js` em `/tipos`, dentro do gate de VER. Ler é de toda a
 * gente (a entrada desenha um cartão por tipo, e a página genérica precisa dos
 * campos); **criar, alterar e apagar é só de `canAdmin`**: um tipo novo muda a
 * aplicação para todos (decisão de 2026-11-10).
 *
 * Aqui vive só a definição — o nome, o modo, os campos. Os equipamentos de cada
 * tipo, com as entregas, as avarias e os abates, estão no `equipamentos.js`. A
 * migração `009` explica as tabelas.
 *
 * ⚠️ **Os seis tipos feitos à mão não passam por aqui** e não aparecem nesta
 * lista: continuam com os seus ficheiros (ver o CLAUDE.md). Os códigos deles
 * estão em `RESERVADOS` para um tipo novo não lhes roubar o nome.
 */

const express = require('express');
const router = express.Router();

const { poolPromise, sql } = require('../../../db');
const { exigirAdmin } = require('./permissoes');
const { limpar, actor, falhou } = require('./comum');

const MODOS = ['pessoas', 'local'];
const TIPOS_DADO = ['texto', 'longo', 'numero', 'data', 'lista', 'simnao'];

/**
 * Os ícones que um tipo pode ter. A lista é fechada porque a entrada desenha os
 * seus ícones à mão (ver o `ICONES` do `iga.html`): um nome que não esteja lá
 * saía sem desenho.
 */
const ICONES = ['box', 'monitor', 'laptop', 'video', 'headphones', 'car', 'key-round', 'shield',
  'flashlight', 'hard-drive', 'plug', 'scan-line', 'megaphone', 'briefcase', 'wrench', 'bike'];

/** Nomes que já são rotas do módulo, ou tipos feitos à mão. */
const RESERVADOS = ['radios', 'telemoveis', 'impressoras', 'maquinas', 'tablets', 'gps',
  'tipos', 'eq', 'permissoes', 'autos', 'iga', 'equipamento', 'equipamentos'];

/** "Coletes balísticos" → "coletesbalisticos": uma palavra só, como os outros códigos. */
function codigoDe(texto, max, separador) {
  return String(texto || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separador)
    .replace(/^_+|_+$/g, '')
    .slice(0, max);
}

/** O primeiro código livre: `base`, `base2`, `base3`… */
function codigoLivre(base, ocupados, max) {
  let codigo = base;
  for (let n = 2; ocupados.has(codigo); n++) {
    const sufixo = String(n);
    codigo = base.slice(0, max - sufixo.length) + sufixo;
  }
  return codigo;
}

function sim(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'sim' || v === 'on';
}

/** A linha da base no formato que os ecrãs recebem. */
function paraFora(t, campos, total) {
  return {
    id: t.id, codigo: t.codigo, nome: t.nome, singular: t.singular, descricao: t.descricao,
    icone: t.icone, modo: t.modo, tem_avarias: !!t.tem_avarias,
    rotulo_identificacao: t.rotulo_identificacao, rotulo_local: t.rotulo_local,
    usa_marca: !!t.usa_marca, usa_modelo: !!t.usa_modelo, usa_serie: !!t.usa_serie,
    equipamentos: total || 0,
    campos: campos.map(c => {
      let opcoes = [];
      try { opcoes = c.opcoes ? JSON.parse(c.opcoes) : []; } catch (e) { /* fica sem opções */ }
      return {
        codigo: c.codigo, rotulo: c.rotulo, tipo_dado: c.tipo_dado, opcoes,
        obrigatorio: !!c.obrigatorio, unico: !!c.unico, na_tabela: !!c.na_tabela,
      };
    }),
  };
}

/** Todos os tipos, ou só o do `codigo`. Usado também pelo `equipamentos.js`. */
async function lerTipos(pool, codigo) {
  const pedido = pool.request();
  let where = '';
  if (codigo) {
    pedido.input('codigo', sql.VarChar(20), codigo);
    where = 'WHERE t.codigo = @codigo';
  }
  const tipos = await pedido.query(`
    SELECT t.*, (SELECT COUNT(*) FROM dbo.equipamentos e WHERE e.tipo_id = t.id) AS total
    FROM dbo.tipos_equipamento t ${where} ORDER BY t.nome`);
  if (!tipos.recordset.length) return [];
  const campos = await pool.request().query('SELECT * FROM dbo.tipos_campos ORDER BY tipo_id, ordem, id');
  return tipos.recordset.map(t => paraFora(t, campos.recordset.filter(c => c.tipo_id === t.id), t.total));
}

async function lerTipo(pool, codigo) {
  const codigoLimpo = codigoDe(codigo, 20, '');
  if (!codigoLimpo || codigoLimpo !== codigo) return null;
  return (await lerTipos(pool, codigoLimpo))[0] || null;
}

/**
 * Lê e valida o que o formulário manda. Devolve `{ erro }` ou `{ tipo, campos }`.
 * `existentes` são os campos que o tipo já tem (numa alteração), para os códigos
 * não mudarem: o código é a chave dos valores já gravados.
 */
function lerDefinicao(b, existentes) {
  const nome = limpar(b.nome);
  if (!nome) return { erro: 'Falta o nome do tipo de equipamento.' };
  const modo = limpar(b.modo);
  if (!MODOS.includes(modo)) return { erro: 'Diz se o equipamento se entrega a pessoas ou fica num local.' };

  const tipo = {
    nome: nome.slice(0, 60),
    singular: (limpar(b.singular) || nome).slice(0, 60),
    descricao: limpar(b.descricao) ? limpar(b.descricao).slice(0, 120) : null,
    icone: ICONES.includes(b.icone) ? b.icone : 'box',
    modo,
    tem_avarias: sim(b.tem_avarias),
    rotulo_identificacao: (limpar(b.rotulo_identificacao) || 'Identificação').slice(0, 60),
    rotulo_local: (limpar(b.rotulo_local) || 'Local').slice(0, 60),
    usa_marca: sim(b.usa_marca), usa_modelo: sim(b.usa_modelo), usa_serie: sim(b.usa_serie),
  };

  const conhecidos = new Map((existentes || []).map(c => [c.codigo, c]));
  const ocupados = new Set();
  const campos = [];
  for (const c of Array.isArray(b.campos) ? b.campos : []) {
    const rotulo = limpar(c && c.rotulo);
    if (!rotulo) return { erro: 'Há um campo sem nome.' };
    const antigo = c.codigo && conhecidos.get(c.codigo);
    // O tipo de dado de um campo que já existe não muda: os valores gravados
    // foram validados como o que ele era.
    const tipoDado = antigo ? antigo.tipo_dado : c.tipo_dado;
    if (!TIPOS_DADO.includes(tipoDado)) return { erro: `O campo "${rotulo}" não tem um tipo válido.` };

    let opcoes = null;
    if (tipoDado === 'lista') {
      const lista = (Array.isArray(c.opcoes) ? c.opcoes : String(c.opcoes || '').split(/[\n;]/))
        .map(limpar).filter(Boolean);
      opcoes = [...new Set(lista)];
      if (!opcoes.length) return { erro: `A lista "${rotulo}" não tem opções.` };
    }

    let codigo = antigo ? antigo.codigo : (codigoDe(rotulo, 30, '_') || 'campo');
    if (!antigo && /^[0-9]/.test(codigo)) codigo = `c_${codigo}`.slice(0, 30);
    if (antigo && ocupados.has(codigo)) return { erro: `O campo "${rotulo}" está repetido.` };
    if (!antigo) codigo = codigoLivre(codigo, new Set([...ocupados, ...conhecidos.keys()]), 30);
    ocupados.add(codigo);

    campos.push({
      codigo, novo: !antigo, rotulo: rotulo.slice(0, 60), tipo_dado: tipoDado,
      opcoes: opcoes ? JSON.stringify(opcoes) : null,
      // Um "sim/não" obrigatório não deixava dizer "não", e único não faz sentido.
      obrigatorio: tipoDado !== 'simnao' && sim(c.obrigatorio),
      unico: ['texto', 'numero'].includes(tipoDado) && sim(c.unico),
      na_tabela: tipoDado !== 'longo' && sim(c.na_tabela),
    });
  }
  if (campos.length > 40) return { erro: 'Um tipo leva no máximo 40 campos.' };
  return { tipo, campos };
}

function entradasDoTipo(pedido, t) {
  return pedido
    .input('nome', sql.NVarChar(60), t.nome)
    .input('singular', sql.NVarChar(60), t.singular)
    .input('descricao', sql.NVarChar(120), t.descricao)
    .input('icone', sql.VarChar(30), t.icone)
    .input('modo', sql.VarChar(10), t.modo)
    .input('avarias', sql.Bit, t.tem_avarias)
    .input('rot_ident', sql.NVarChar(60), t.rotulo_identificacao)
    .input('rot_local', sql.NVarChar(60), t.rotulo_local)
    .input('marca', sql.Bit, t.usa_marca)
    .input('modelo', sql.Bit, t.usa_modelo)
    .input('serie', sql.Bit, t.usa_serie);
}

function entradasDoCampo(pedido, c, ordem) {
  return pedido
    .input('codigo', sql.VarChar(30), c.codigo)
    .input('rotulo', sql.NVarChar(60), c.rotulo)
    .input('dado', sql.VarChar(10), c.tipo_dado)
    .input('opcoes', sql.NVarChar(sql.MAX), c.opcoes)
    .input('obrig', sql.Bit, c.obrigatorio)
    .input('unico', sql.Bit, c.unico)
    .input('tabela', sql.Bit, c.na_tabela)
    .input('ordem', sql.Int, ordem);
}

// ─── Ler ───────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });
    res.json({ tipos: await lerTipos(pool), icones: ICONES });
  } catch (err) {
    falhou(res, 'listar os tipos de equipamento', err);
  }
});

router.get('/:codigo', async (req, res) => {
  try {
    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });
    const tipo = await lerTipo(pool, req.params.codigo);
    if (!tipo) return res.status(404).json({ error: 'Tipo de equipamento não encontrado.' });
    res.json(tipo);
  } catch (err) {
    falhou(res, 'obter o tipo de equipamento', err);
  }
});

// ─── Criar ─────────────────────────────────────────────────

router.post('/', exigirAdmin, async (req, res) => {
  try {
    const def = lerDefinicao(req.body || {});
    if (def.erro) return res.status(400).json({ error: def.erro });

    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });

    const base = codigoDe(def.tipo.nome, 20, '');
    if (!base) return res.status(400).json({ error: 'O nome tem de ter letras ou algarismos.' });
    const usados = await pool.request().query('SELECT codigo FROM dbo.tipos_equipamento');
    const codigo = codigoLivre(base, new Set([...RESERVADOS, ...usados.recordset.map(r => r.codigo)]), 20);

    // O tipo e os campos entram juntos: um tipo a meio era um cartão na entrada
    // com um formulário sem campos.
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const r = await entradasDoTipo(tx.request(), def.tipo)
        .input('codigo', sql.VarChar(20), codigo)
        .input('por', sql.NVarChar(120), actor(req))
        .query(`INSERT INTO dbo.tipos_equipamento
                  (codigo, nome, singular, descricao, icone, modo, tem_avarias,
                   rotulo_identificacao, rotulo_local, usa_marca, usa_modelo, usa_serie, criado_por)
                OUTPUT INSERTED.id
                VALUES (@codigo, @nome, @singular, @descricao, @icone, @modo, @avarias,
                        @rot_ident, @rot_local, @marca, @modelo, @serie, @por)`);
      const id = r.recordset[0].id;
      for (const [i, c] of def.campos.entries()) {
        await entradasDoCampo(tx.request(), c, i).input('tipo', sql.Int, id)
          .query(`INSERT INTO dbo.tipos_campos (tipo_id, codigo, rotulo, tipo_dado, opcoes, obrigatorio, unico, na_tabela, ordem)
                  VALUES (@tipo, @codigo, @rotulo, @dado, @opcoes, @obrig, @unico, @tabela, @ordem)`);
      }
      await tx.commit();
    } catch (e) {
      await tx.rollback().catch(() => {});
      throw e;
    }

    console.warn(`[iga/tipos] Tipo "${codigo}" criado por ${actor(req)}, com ${def.campos.length} campos.`);
    res.status(201).json({ codigo });
  } catch (err) {
    falhou(res, 'criar o tipo de equipamento', err);
  }
});

// ─── Alterar ───────────────────────────────────────────────

/**
 * PUT /tipos/:codigo
 *
 * O código não muda (está nos URL e nos autos de abate). O modo e as avarias só
 * mudam enquanto o tipo não tem equipamento: depois disso há entregas ou locais
 * gravados que deixavam de ter ecrã. Os campos vêm todos: o que não vier é
 * retirado — os valores já gravados ficam na base, só deixam de se ver.
 */
router.put('/:codigo', exigirAdmin, async (req, res) => {
  try {
    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });
    const atual = await lerTipo(pool, req.params.codigo);
    if (!atual) return res.status(404).json({ error: 'Tipo de equipamento não encontrado.' });

    const def = lerDefinicao(req.body || {}, atual.campos);
    if (def.erro) return res.status(400).json({ error: def.erro });
    if (atual.equipamentos && (def.tipo.modo !== atual.modo || def.tipo.tem_avarias !== atual.tem_avarias)) {
      return res.status(409).json({ error: 'Este tipo já tem equipamento: o modo de uso e as avarias já não se alteram.' });
    }

    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      await entradasDoTipo(tx.request(), def.tipo).input('id', sql.Int, atual.id)
        .query(`UPDATE dbo.tipos_equipamento
                SET nome = @nome, singular = @singular, descricao = @descricao, icone = @icone,
                    modo = @modo, tem_avarias = @avarias, rotulo_identificacao = @rot_ident,
                    rotulo_local = @rot_local, usa_marca = @marca, usa_modelo = @modelo, usa_serie = @serie
                WHERE id = @id`);
      const ficam = new Set(def.campos.map(c => c.codigo));
      for (const c of atual.campos.filter(x => !ficam.has(x.codigo))) {
        await tx.request().input('tipo', sql.Int, atual.id).input('codigo', sql.VarChar(30), c.codigo)
          .query('DELETE FROM dbo.tipos_campos WHERE tipo_id = @tipo AND codigo = @codigo');
      }
      for (const [i, c] of def.campos.entries()) {
        const pedido = entradasDoCampo(tx.request(), c, i).input('tipo', sql.Int, atual.id);
        await pedido.query(c.novo
          ? `INSERT INTO dbo.tipos_campos (tipo_id, codigo, rotulo, tipo_dado, opcoes, obrigatorio, unico, na_tabela, ordem)
             VALUES (@tipo, @codigo, @rotulo, @dado, @opcoes, @obrig, @unico, @tabela, @ordem)`
          : `UPDATE dbo.tipos_campos
             SET rotulo = @rotulo, opcoes = @opcoes, obrigatorio = @obrig, unico = @unico,
                 na_tabela = @tabela, ordem = @ordem
             WHERE tipo_id = @tipo AND codigo = @codigo`);
      }
      await tx.commit();
    } catch (e) {
      await tx.rollback().catch(() => {});
      throw e;
    }

    console.warn(`[iga/tipos] Tipo "${atual.codigo}" alterado por ${actor(req)}.`);
    res.json({ ok: true });
  } catch (err) {
    falhou(res, 'gravar o tipo de equipamento', err);
  }
});

// ─── Apagar ────────────────────────────────────────────────

/** Só um tipo vazio: com equipamento ou com autos de abate, fica. */
router.delete('/:codigo', exigirAdmin, async (req, res) => {
  try {
    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });
    const tipo = await lerTipo(pool, req.params.codigo);
    if (!tipo) return res.status(404).json({ error: 'Tipo de equipamento não encontrado.' });
    if (tipo.equipamentos) {
      return res.status(409).json({ error: `Este tipo tem ${tipo.equipamentos} equipamento(s): não se apaga.` });
    }
    const autos = await pool.request().input('tipo', sql.VarChar(20), tipo.codigo)
      .query('SELECT COUNT(*) AS n FROM dbo.autos_abate WHERE tipo = @tipo');
    if (autos.recordset[0].n) {
      return res.status(409).json({ error: 'Este tipo tem autos de abate: não se apaga.' });
    }
    await pool.request().input('id', sql.Int, tipo.id).query('DELETE FROM dbo.tipos_equipamento WHERE id = @id');
    console.warn(`[iga/tipos] Tipo "${tipo.codigo}" apagado por ${actor(req)}.`);
    res.json({ ok: true });
  } catch (err) {
    falhou(res, 'apagar o tipo de equipamento', err);
  }
});

module.exports = { router, lerTipo };
