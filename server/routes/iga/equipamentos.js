'use strict';

/**
 * Os equipamentos dos tipos criados pelo ecrã.
 *
 * Montado pelo `index.js` em `/eq/:tipo`, dentro do gate de VER. É um router só
 * para todos esses tipos: o `:tipo` é o código (`/eq/coletes`), e o primeiro
 * middleware lê a definição e deixa-a em `req.tipo`. A definição — nome, modo,
 * campos — é do `tipos.js`; as tabelas estão na migração `009`.
 *
 * O que um tipo tem depende do que a administração escolheu ao criá-lo:
 *   modo 'pessoas'  entrega-se a alguém — entregas, como os tablets
 *   modo 'local'    está num sítio — uma coluna, como as impressoras
 *   tem_avarias     regista avarias, e o estado passa por 'avariado'
 * Abates e autos de abate têm todos, pelo `autos.js`.
 *
 * ⚠️ **Os seis tipos feitos à mão não passam por aqui.** Têm os seus ficheiros e
 * as suas tabelas, e este não os conhece.
 *
 * ⚠️ **Os campos do tipo vivem em `valores`, em JSON**, e só este ficheiro os lê
 * e escreve: valida-os contra a definição ao gravar, e devolve-os já como
 * objecto. Nenhuma consulta usa funções de JSON (ver a `009`) — a procura faz
 * LIKE sobre o texto, e a unicidade de um campo confere-se aqui, linha a linha.
 */

const express = require('express');
const router = express.Router({ mergeParams: true });

const { poolPromise, sql } = require('../../../db');
const { exigirEdicao, exigirAdmin } = require('./permissoes');
const { limpar, inteiro, data, hoje, actor, falhou } = require('./comum');
const { montarAutos, abateDoEquipamento } = require('./autos');
const { lerTipo } = require('./tipos');

const ESTADOS = ['disponivel', 'atribuido', 'avariado', 'abatido'];

const COLUNAS = `e.id, e.identificacao, e.marca, e.modelo, e.num_serie, e.localizacao,
  e.valores, e.estado, e.obs, e.criado_em, e.atualizado_em`;

// ─── O tipo do pedido ──────────────────────────────────────

router.use(async (req, res, next) => {
  try {
    const pool = await poolPromise;
    if (!pool) return res.status(500).json({ error: 'Sem ligação à base de dados.' });
    const tipo = await lerTipo(pool, req.params.tipo);
    if (!tipo) return res.status(404).json({ error: 'Tipo de equipamento não encontrado.' });
    req.tipo = tipo;
    req.pool = pool;
    next();
  } catch (err) {
    falhou(res, 'obter o tipo de equipamento', err);
  }
});

/** "o colete", para as mensagens. */
function um(tipo) {
  return tipo.singular.toLowerCase();
}

/** A linha da base com os `valores` já em objecto. */
function paraFora(linha) {
  if (!linha) return linha;
  let valores = {};
  try { valores = linha.valores ? JSON.parse(linha.valores) : {}; } catch (e) { /* fica vazio */ }
  return { ...linha, valores };
}

/** Mesma regra e mesma precedência dos outros tipos: abatido > avariado > atribuído > disponível. */
async function recalcularEstado(pool, id) {
  await pool.request()
    .input('id', sql.Int, id)
    .query(`
      UPDATE dbo.equipamentos
      SET estado = CASE
            WHEN EXISTS (SELECT 1 FROM dbo.equipamentos_abates  WHERE equipamento_id = @id AND estado = 'abatido') THEN 'abatido'
            WHEN EXISTS (SELECT 1 FROM dbo.equipamentos_avarias WHERE equipamento_id = @id AND estado = 'aberta') THEN 'avariado'
            WHEN EXISTS (SELECT 1 FROM dbo.equipamentos_atribuicoes WHERE equipamento_id = @id AND data_devolucao IS NULL) THEN 'atribuido'
            ELSE 'disponivel'
          END,
          atualizado_em = GETDATE()
      WHERE id = @id`);
}

/** O equipamento existe NESTE tipo? Devolve a linha ou responde 404. */
async function equipamentoOu404(req, id, res) {
  const r = await req.pool.request().input('id', sql.Int, id).input('tipo', sql.Int, req.tipo.id)
    .query(`SELECT ${COLUNAS} FROM dbo.equipamentos e WHERE e.id = @id AND e.tipo_id = @tipo`);
  const linha = r.recordset[0];
  if (!linha) {
    res.status(404).json({ error: `${req.tipo.singular} não encontrado.` });
    return null;
  }
  return paraFora(linha);
}

/**
 * Os campos do tipo, lidos do corpo e validados contra a definição.
 *
 * `anteriores` são os valores já gravados: um campo que não venha no corpo fica
 * como estava, e as chaves de campos entretanto retirados do tipo não se perdem
 * — voltar a pôr o campo traz os valores de volta. Devolve `{ erro }` ou
 * `{ valores }`.
 */
function lerValores(tipo, corpo, anteriores) {
  const vindos = corpo && typeof corpo === 'object' ? corpo : {};
  const valores = { ...(anteriores || {}) };
  const vazio = v => v === undefined || v === null;
  for (const c of tipo.campos) {
    if (vindos[c.codigo] === undefined) {
      if (c.obrigatorio && vazio(valores[c.codigo])) return { erro: `Falta preencher "${c.rotulo}".` };
      continue;
    }
    const cru = vindos[c.codigo];
    let v = null;
    if (c.tipo_dado === 'numero') {
      const s = limpar(cru);
      if (s !== null) {
        v = Number(String(s).replace(/\s+/g, '').replace(',', '.'));
        if (!Number.isFinite(v)) return { erro: `"${c.rotulo}" tem de ser um número.` };
      }
    } else if (c.tipo_dado === 'data') {
      v = data(cru);
      if (limpar(cru) !== null && !v) return { erro: `"${c.rotulo}" não é uma data válida.` };
    } else if (c.tipo_dado === 'simnao') {
      const s = (limpar(cru) || '').toLowerCase();
      v = cru === true || ['sim', '1', 'true'].includes(s) ? true
        : cru === false || ['nao', 'não', '0', 'false'].includes(s) ? false : null;
    } else if (c.tipo_dado === 'lista') {
      v = limpar(cru);
      if (v !== null && !c.opcoes.includes(v)) return { erro: `"${v}" não é uma opção de "${c.rotulo}".` };
    } else {
      v = limpar(cru);
    }
    if (c.obrigatorio && v === null) return { erro: `Falta preencher "${c.rotulo}".` };
    valores[c.codigo] = v;
  }
  return { valores };
}

/** Outro equipamento do tipo com o mesmo valor num campo marcado como único? */
async function campoRepetido(req, valores, excetoId) {
  const tem = v => v !== null && v !== undefined;
  const unicos = req.tipo.campos.filter(c => c.unico && tem(valores[c.codigo]));
  if (!unicos.length) return null;
  const r = await req.pool.request().input('tipo', sql.Int, req.tipo.id).input('id', sql.Int, excetoId || 0)
    .query('SELECT valores FROM dbo.equipamentos WHERE tipo_id = @tipo AND id <> @id AND valores IS NOT NULL');
  const igual = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  for (const linha of r.recordset) {
    const outros = paraFora(linha).valores;
    const c = unicos.find(u => tem(outros[u.codigo]) && igual(outros[u.codigo], valores[u.codigo]));
    if (c) return c;
  }
  return null;
}

/** Responde 409 se o erro for de um índice único; senão devolve false. */
function duplicado(req, res, err) {
  const m = err && err.message;
  if (/UX_equipamentos_identificacao/.test(m)) {
    res.status(409).json({ error: `Já existe ${um(req.tipo)} com "${req.tipo.rotulo_identificacao}" igual.` });
    return true;
  }
  if (/UX_equipamentos_num_serie/.test(m)) {
    res.status(409).json({ error: 'Já existe um com esse número de série.' });
    return true;
  }
  return false;
}

/** As rotas de um modo que o tipo não tem não existem para ele. */
function soModo(modo) {
  return (req, res, next) => (req.tipo.modo === modo ? next()
    : res.status(404).json({ error: `${req.tipo.nome}: este tipo não se entrega a pessoas.` }));
}

function soComAvarias(req, res, next) {
  return req.tipo.tem_avarias ? next()
    : res.status(404).json({ error: `${req.tipo.nome}: este tipo não regista avarias.` });
}

// ─── Estatísticas ──────────────────────────────────────────

/**
 * As parcelas somam ao total nos dois modos: num tipo de 'local' os disponíveis
 * partem-se em com e sem local, e é isso que o cartão da entrada mostra.
 */
router.get('/estatisticas', async (req, res) => {
  try {
    const r = await req.pool.request().input('tipo', sql.Int, req.tipo.id).query(`
      SELECT
        COUNT(*) AS total,
        ISNULL(SUM(CASE WHEN estado = 'atribuido'  THEN 1 ELSE 0 END), 0) AS atribuidos,
        ISNULL(SUM(CASE WHEN estado = 'disponivel' THEN 1 ELSE 0 END), 0) AS disponiveis,
        ISNULL(SUM(CASE WHEN estado = 'avariado'   THEN 1 ELSE 0 END), 0) AS avariados,
        ISNULL(SUM(CASE WHEN estado = 'abatido'    THEN 1 ELSE 0 END), 0) AS abatidos,
        ISNULL(SUM(CASE WHEN estado = 'disponivel' AND localizacao IS NOT NULL THEN 1 ELSE 0 END), 0) AS com_local,
        ISNULL(SUM(CASE WHEN estado = 'disponivel' AND localizacao IS NULL     THEN 1 ELSE 0 END), 0) AS sem_local,
        (SELECT COUNT(*) FROM dbo.equipamentos_abates b JOIN dbo.equipamentos x ON x.id = b.equipamento_id
          WHERE x.tipo_id = @tipo AND b.estado = 'proposto') AS propostos
      FROM dbo.equipamentos WHERE tipo_id = @tipo`);
    res.json(r.recordset[0]);
  } catch (err) {
    falhou(res, 'obter as estatísticas', err);
  }
});

/** GET /eq/:tipo/locais — os locais já usados, para o filtro e o autocompletar. */
router.get('/locais', async (req, res) => {
  try {
    const r = await req.pool.request().input('tipo', sql.Int, req.tipo.id).query(`
      SELECT localizacao, COUNT(*) AS total FROM dbo.equipamentos
      WHERE tipo_id = @tipo AND localizacao IS NOT NULL GROUP BY localizacao ORDER BY localizacao`);
    res.json(r.recordset);
  } catch (err) {
    falhou(res, 'listar os locais', err);
  }
});

// ─── Listagem ──────────────────────────────────────────────

/** GET /eq/:tipo?q=&estado=&local= */
router.get('/', async (req, res) => {
  try {
    const pedido = req.pool.request().input('tipo', sql.Int, req.tipo.id);
    const filtros = ['e.tipo_id = @tipo'];

    const q = limpar(req.query.q);
    if (q) {
      pedido.input('q', sql.NVarChar(200), `%${q}%`);
      filtros.push(`(e.identificacao LIKE @q OR e.marca LIKE @q OR e.modelo LIKE @q OR e.num_serie LIKE @q
                     OR e.localizacao LIKE @q OR e.valores LIKE @q
                     OR a.nome_utilizador LIKE @q OR CAST(a.matricula AS NVARCHAR(20)) LIKE @q)`);
    }
    const estado = limpar(req.query.estado);
    if (estado && ESTADOS.includes(estado)) {
      pedido.input('estado', sql.VarChar(20), estado);
      filtros.push('e.estado = @estado');
    }
    const local = limpar(req.query.local);
    if (local === '--sem--') {
      filtros.push('e.localizacao IS NULL');
    } else if (local) {
      pedido.input('local', sql.NVarChar(120), local);
      filtros.push('e.localizacao = @local');
    }

    // A identificação é texto, mas ordena-se como número quando o é ("9" antes de "10").
    const r = await pedido.query(`
      SELECT TOP 5000 ${COLUNAS},
        a.id AS atribuicao_id, a.matricula, a.nome_utilizador, a.data_entrega,
        av.id AS avaria_id, av.descricao AS avaria_descricao,
        ab.data_abate, ab.motivo AS motivo_abate, ab.estado AS abate_estado
      FROM dbo.equipamentos e
      OUTER APPLY (
        SELECT TOP 1 * FROM dbo.equipamentos_atribuicoes x
        WHERE x.equipamento_id = e.id AND x.data_devolucao IS NULL
        ORDER BY x.data_entrega DESC, x.id DESC) a
      OUTER APPLY (
        SELECT TOP 1 * FROM dbo.equipamentos_avarias x
        WHERE x.equipamento_id = e.id AND x.estado = 'aberta'
        ORDER BY x.id DESC) av
      OUTER APPLY (
        SELECT TOP 1 * FROM dbo.equipamentos_abates x
        WHERE x.equipamento_id = e.id ORDER BY x.id DESC) ab
      WHERE ${filtros.join(' AND ')}
      ORDER BY CASE WHEN TRY_CAST(e.identificacao AS INT) IS NULL THEN 1 ELSE 0 END,
               TRY_CAST(e.identificacao AS INT), e.identificacao, e.id`);

    res.json(r.recordset.map(paraFora));
  } catch (err) {
    falhou(res, 'listar os equipamentos', err);
  }
});

// ─── Abates e autos de abate ───────────────────────────────

/**
 * As rotas do `autos.js`, com a configuração do tipo do pedido.
 *
 * Os outros tipos chamam `montarAutos(router, AUTOS)` uma vez, com tabelas
 * fixas. Aqui a tabela é a mesma para todos e o que muda é o `tipo_id`, que só
 * se conhece em cada pedido: monta-se um router pequeno por tipo, guardado em
 * `autosPorTipo`, e o pedido passa por ele. O que não for rota de abate segue
 * para as de baixo — por isso isto fica ACIMA do `/:id`, como nos outros.
 *
 * O `tipo_id` vem da base (é um inteiro), e o nome do tipo vai para o SQL com
 * as plicas dobradas: nada do que o utilizador escreve é concatenado cru.
 */
function configAutos(tipo) {
  const id = Number(tipo.id);
  return {
    tipo: tipo.codigo, nome: tipo.nome,
    pool: poolPromise,
    equip: `(SELECT * FROM dbo.equipamentos WHERE tipo_id = ${id})`,
    abates: 'dbo.equipamentos_abates', fk: 'equipamento_id',
    filtro: ` AND equipamento_id IN (SELECT id FROM dbo.equipamentos WHERE tipo_id = ${id})`,
    atribuicoes: 'dbo.equipamentos_atribuicoes',
    descricao: `CONCAT(N'${tipo.singular.replace(/'/g, "''")}', ' ' + e.modelo)`,
    marca: 'e.marca',
    serie: 'e.num_serie',
    identificacao: 'e.identificacao',
    recalcular: recalcularEstado,
  };
}

const autosPorTipo = new Map();

router.use((req, res, next) => {
  const chave = `${req.tipo.id}|${req.tipo.nome}|${req.tipo.singular}`;
  let sub = autosPorTipo.get(chave);
  if (!sub) {
    sub = express.Router();
    montarAutos(sub, configAutos(req.tipo));
    autosPorTipo.set(chave, sub);
  }
  sub(req, res, next);
});

// ─── Detalhe ───────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });
    const eq = await equipamentoOu404(req, id, res);
    if (!eq) return;

    const [atribuicoes, avarias, abate] = await Promise.all([
      req.pool.request().input('id', sql.Int, id).query(
        `SELECT * FROM dbo.equipamentos_atribuicoes WHERE equipamento_id = @id
         ORDER BY ISNULL(data_entrega, '1900-01-01') DESC, id DESC`),
      req.pool.request().input('id', sql.Int, id).query(
        'SELECT * FROM dbo.equipamentos_avarias WHERE equipamento_id = @id ORDER BY id DESC'),
      abateDoEquipamento(req.pool, configAutos(req.tipo), id),
    ]);

    res.json({ ...eq, atribuicoes: atribuicoes.recordset, avarias: avarias.recordset, abate });
  } catch (err) {
    falhou(res, 'obter o equipamento', err);
  }
});

// ─── Criar e editar ────────────────────────────────────────

/** Os campos base que o tipo usa: o que o tipo não usa não se grava. */
function camposBase(tipo) {
  // Em maiúsculas, como nos tablets: a mesma série das duas maneiras passava o índice único.
  const serie = v => { const s = limpar(v); return s ? s.toUpperCase() : s; };
  return [
    ['identificacao', sql.NVarChar(80), limpar, true],
    ['marca', sql.NVarChar(60), limpar, tipo.usa_marca],
    ['modelo', sql.NVarChar(80), limpar, tipo.usa_modelo],
    ['num_serie', sql.NVarChar(60), serie, tipo.usa_serie],
    ['localizacao', sql.NVarChar(120), limpar, tipo.modo === 'local'],
    ['obs', sql.NVarChar(sql.MAX), limpar, true],
  ].filter(c => c[3]);
}

router.post('/', exigirEdicao, async (req, res) => {
  try {
    const b = req.body || {};
    if (!limpar(b.identificacao)) {
      return res.status(400).json({ error: `Falta preencher "${req.tipo.rotulo_identificacao}".` });
    }
    const lidos = lerValores(req.tipo, b.valores, null);
    if (lidos.erro) return res.status(400).json({ error: lidos.erro });
    const repetido = await campoRepetido(req, lidos.valores, null);
    if (repetido) return res.status(409).json({ error: `Já existe ${um(req.tipo)} com "${repetido.rotulo}" igual.` });

    const pedido = req.pool.request()
      .input('tipo', sql.Int, req.tipo.id)
      .input('valores', sql.NVarChar(sql.MAX), JSON.stringify(lidos.valores));
    const colunas = ['tipo_id', 'valores'];
    for (const [col, tipoSql, ler] of camposBase(req.tipo)) {
      pedido.input(col, tipoSql, ler(b[col]));
      colunas.push(col);
    }
    const marcas = colunas.map(c => (c === 'tipo_id' ? '@tipo' : `@${c}`));
    const r = await pedido.query(`INSERT INTO dbo.equipamentos (${colunas.join(', ')})
                                  OUTPUT INSERTED.id VALUES (${marcas.join(', ')})`);
    res.status(201).json({ id: r.recordset[0].id });
  } catch (err) {
    if (duplicado(req, res, err)) return;
    falhou(res, 'criar o equipamento', err);
  }
});

/**
 * PUT /eq/:tipo/:id
 *
 * ⚠️ **Grava só os campos que vierem no corpo**, como o das impressoras e o dos
 * GPS: "mudar de local" manda um campo só, e não pode apagar a série e o
 * modelo. Vale também para os `valores`: uma chave que não venha fica como está.
 */
router.put('/:id', exigirEdicao, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });
    const eq = await equipamentoOu404(req, id, res);
    if (!eq) return;

    const b = req.body || {};
    const pedido = req.pool.request().input('id', sql.Int, id);
    const sets = [];
    for (const [col, tipoSql, ler] of camposBase(req.tipo)) {
      if (b[col] === undefined) continue;
      const valor = ler(b[col]);
      if (col === 'identificacao' && !valor) {
        return res.status(400).json({ error: `"${req.tipo.rotulo_identificacao}" não pode ficar vazio.` });
      }
      pedido.input(col, tipoSql, valor);
      sets.push(`${col} = @${col}`);
    }
    if (b.valores !== undefined) {
      const lidos = lerValores(req.tipo, b.valores, eq.valores);
      if (lidos.erro) return res.status(400).json({ error: lidos.erro });
      const repetido = await campoRepetido(req, lidos.valores, id);
      if (repetido) return res.status(409).json({ error: `Já existe ${um(req.tipo)} com "${repetido.rotulo}" igual.` });
      pedido.input('valores', sql.NVarChar(sql.MAX), JSON.stringify(lidos.valores));
      sets.push('valores = @valores');
    }
    if (!sets.length) return res.status(400).json({ error: 'Nada para gravar.' });

    await pedido.query(`UPDATE dbo.equipamentos SET ${sets.join(', ')}, atualizado_em = GETDATE() WHERE id = @id`);
    res.json({ ok: true });
  } catch (err) {
    if (duplicado(req, res, err)) return;
    falhou(res, 'gravar o equipamento', err);
  }
});

router.delete('/:id', exigirAdmin, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });
    if (!await equipamentoOu404(req, id, res)) return;
    // Um equipamento que está num auto de abate é papel: não desaparece.
    const emAuto = await req.pool.request().input('id', sql.Int, id)
      .query('SELECT 1 AS ok FROM dbo.equipamentos_abates WHERE equipamento_id = @id AND auto_id IS NOT NULL');
    if (emAuto.recordset.length) {
      return res.status(409).json({ error: 'Está num auto de abate — não se apaga.' });
    }
    await req.pool.request().input('id', sql.Int, id).query('DELETE FROM dbo.equipamentos WHERE id = @id');
    res.json({ ok: true });
  } catch (err) {
    falhou(res, 'apagar o equipamento', err);
  }
});

// ─── Entregas e devoluções (modo 'pessoas') ────────────────

router.post('/:id/atribuir', soModo('pessoas'), exigirEdicao, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });
    const eq = await equipamentoOu404(req, id, res);
    if (!eq) return;
    if (eq.estado === 'abatido') {
      return res.status(409).json({ error: 'Está abatido — não pode ser entregue.' });
    }
    const proposto = await req.pool.request().input('id', sql.Int, id)
      .query(`SELECT 1 AS ok FROM dbo.equipamentos_abates WHERE equipamento_id = @id AND estado = 'proposto'`);
    if (proposto.recordset.length) {
      return res.status(409).json({ error: 'Está proposto para abate — não pode ser entregue.' });
    }

    const b = req.body || {};
    const nome = limpar(b.nome_utilizador);
    const matricula = inteiro(b.matricula);
    if (!nome && matricula === null) {
      return res.status(400).json({ error: 'É preciso a matrícula ou o nome de quem fica com o equipamento.' });
    }
    const entrega = data(b.data_entrega) || hoje();

    await req.pool.request().input('id', sql.Int, id).input('fim', sql.Date, entrega)
      .query(`UPDATE dbo.equipamentos_atribuicoes SET data_devolucao = @fim
              WHERE equipamento_id = @id AND data_devolucao IS NULL`);

    const r = await req.pool.request()
      .input('eid', sql.Int, id)
      .input('mec', sql.Int, matricula)
      .input('nome', sql.NVarChar(200), nome)
      .input('entrega', sql.Date, entrega)
      .input('obs', sql.NVarChar(sql.MAX), limpar(b.obs))
      .input('por', sql.NVarChar(120), actor(req))
      .query(`INSERT INTO dbo.equipamentos_atribuicoes (equipamento_id, matricula, nome_utilizador, data_entrega, obs, registado_por)
              OUTPUT INSERTED.id
              VALUES (@eid, @mec, @nome, @entrega, @obs, @por)`);

    await recalcularEstado(req.pool, id);
    res.status(201).json({ id: r.recordset[0].id });
  } catch (err) {
    falhou(res, 'registar a entrega', err);
  }
});

router.post('/:id/devolver', soModo('pessoas'), exigirEdicao, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });
    if (!await equipamentoOu404(req, id, res)) return;

    const b = req.body || {};
    const r = await req.pool.request()
      .input('id', sql.Int, id)
      .input('fim', sql.Date, data(b.data_devolucao) || hoje())
      .input('obs', sql.NVarChar(sql.MAX), limpar(b.obs))
      .query(`
        UPDATE dbo.equipamentos_atribuicoes
        SET data_devolucao = @fim,
            obs = CASE WHEN @obs IS NULL THEN obs
                       WHEN obs IS NULL THEN @obs
                       ELSE obs + N' · ' + @obs END
        WHERE equipamento_id = @id AND data_devolucao IS NULL`);

    if (!r.rowsAffected[0]) {
      return res.status(409).json({ error: 'Não está entregue a ninguém.' });
    }
    await recalcularEstado(req.pool, id);
    res.json({ ok: true });
  } catch (err) {
    falhou(res, 'registar a devolução', err);
  }
});

/**
 * PUT /eq/:tipo/atribuicoes/:id — corrigir uma entrega sem a refazer, como nos
 * outros tipos. A entrega tem de ser de um equipamento deste tipo.
 */
router.put('/atribuicoes/:id', soModo('pessoas'), exigirEdicao, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });

    const atual = await req.pool.request().input('id', sql.Int, id).input('tipo', sql.Int, req.tipo.id)
      .query(`SELECT a.* FROM dbo.equipamentos_atribuicoes a
              JOIN dbo.equipamentos e ON e.id = a.equipamento_id
              WHERE a.id = @id AND e.tipo_id = @tipo`);
    const a = atual.recordset[0];
    if (!a) return res.status(404).json({ error: 'Entrega não encontrada.' });

    const b = req.body || {};
    const vem = campo => b[campo] !== undefined;
    const nome = vem('nome_utilizador') ? limpar(b.nome_utilizador) : a.nome_utilizador;
    const matricula = vem('matricula') ? inteiro(b.matricula) : a.matricula;
    if (!nome && matricula === null) {
      return res.status(400).json({ error: 'É preciso a matrícula ou o nome de quem tem o equipamento.' });
    }
    let devolucao = a.data_devolucao;
    if (a.data_devolucao && vem('data_devolucao')) {
      devolucao = data(b.data_devolucao);
      if (!devolucao) return res.status(400).json({ error: 'A data de devolução não pode ficar vazia numa entrega devolvida.' });
    }

    await req.pool.request()
      .input('id', sql.Int, id)
      .input('mec', sql.Int, matricula)
      .input('nome', sql.NVarChar(200), nome)
      .input('entrega', sql.Date, vem('data_entrega') ? data(b.data_entrega) : a.data_entrega)
      .input('devolucao', sql.Date, devolucao)
      .input('obs', sql.NVarChar(sql.MAX), vem('obs') ? limpar(b.obs) : a.obs)
      .query(`UPDATE dbo.equipamentos_atribuicoes
              SET matricula = @mec, nome_utilizador = @nome, data_entrega = @entrega,
                  data_devolucao = @devolucao, obs = @obs
              WHERE id = @id`);
    res.json({ ok: true, equipamento_id: a.equipamento_id });
  } catch (err) {
    falhou(res, 'corrigir a entrega', err);
  }
});

// ─── Avarias (só nos tipos que as registam) ────────────────

router.post('/avarias/:id/reparar', soComAvarias, exigirEdicao, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });

    const b = req.body || {};
    const estado = limpar(b.estado) === 'irreparavel' ? 'irreparavel' : 'reparada';

    const r = await req.pool.request()
      .input('id', sql.Int, id)
      .input('tipo', sql.Int, req.tipo.id)
      .input('estado', sql.VarChar(20), estado)
      .input('fim', sql.Date, data(b.data_reparacao) || hoje())
      .input('obs', sql.NVarChar(sql.MAX), limpar(b.obs))
      .query(`
        UPDATE dbo.equipamentos_avarias
        SET estado = @estado, data_reparacao = @fim,
            obs = CASE WHEN @obs IS NULL THEN obs
                       WHEN obs IS NULL THEN @obs
                       ELSE obs + N' · ' + @obs END
        OUTPUT INSERTED.equipamento_id
        WHERE id = @id AND estado = 'aberta'
          AND equipamento_id IN (SELECT id FROM dbo.equipamentos WHERE tipo_id = @tipo)`);

    const linha = r.recordset && r.recordset[0];
    if (!linha) return res.status(409).json({ error: 'Avaria não encontrada ou já fechada.' });

    await recalcularEstado(req.pool, linha.equipamento_id);
    res.json({ ok: true, equipamento_id: linha.equipamento_id });
  } catch (err) {
    falhou(res, 'fechar a avaria', err);
  }
});

router.post('/:id/avarias', soComAvarias, exigirEdicao, async (req, res) => {
  try {
    const id = inteiro(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador inválido.' });
    const eq = await equipamentoOu404(req, id, res);
    if (!eq) return;
    if (eq.estado === 'abatido') {
      return res.status(409).json({ error: 'Está abatido — não faz sentido registar avarias.' });
    }

    const b = req.body || {};
    const descricao = limpar(b.descricao);
    if (!descricao) return res.status(400).json({ error: 'Diz o que tem a avaria.' });

    const r = await req.pool.request()
      .input('eid', sql.Int, id)
      .input('desc', sql.NVarChar(200), descricao)
      .input('registo', sql.Date, data(b.data_registo) || hoje())
      .input('obs', sql.NVarChar(sql.MAX), limpar(b.obs))
      .input('por', sql.NVarChar(120), actor(req))
      .query(`INSERT INTO dbo.equipamentos_avarias (equipamento_id, descricao, data_registo, obs, registado_por)
              OUTPUT INSERTED.id
              VALUES (@eid, @desc, @registo, @obs, @por)`);

    await recalcularEstado(req.pool, id);
    res.status(201).json({ id: r.recordset[0].id });
  } catch (err) {
    falhou(res, 'registar a avaria', err);
  }
});

module.exports = router;
