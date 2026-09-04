'use strict';

/**
 * Importador do `Radios apanhado.xlsx` → base de dados.
 *
 *   npm run importar-radios                    (procura o ficheiro no OneDrive da PM)
 *   npm run importar-radios -- "C:\caminho\Radios apanhado.xlsx"
 *   XLSX_RADIOS="C:\..." npm run importar-radios
 *
 * Corre as vezes que forem precisas: os equipamentos são procurados por número
 * de série e, na falta dele, por indicativo — não duplica o que já lá está. As
 * duas folhas que são fotografias de outro sistema (`TEI` e `Quest`) são
 * substituídas por inteiro a cada corrida, porque uma exportação nova é a
 * verdade nova, não um acrescento à antiga.
 *
 * ⚠️ O que este importador NÃO faz, de propósito:
 *
 *  - **Não inventa números de série.** 93 dos 339 rádios da folha principal não
 *    o têm; ficam com `num_serie` NULL e é assim que devem aparecer no ecrã.
 *  - **Não deduplica indicativos.** 357, 847, 849, 855, 875 e 885 aparecem duas
 *    vezes na origem, com equipamento diferente. São reatribuições reais que
 *    nunca foram fechadas — juntá-las apagava um dos dois rádios.
 *  - **Não lê as três últimas linhas da folha `Radios`.** São notas escritas à
 *    mão ("Existem mais 7 rádios Sepura novos em armazém"), não equipamentos.
 *    Ficam contadas no resumo, em `notas`, para não desaparecerem sem se dar
 *    por isso.
 *  - **Não corrige as linhas com lixo colado à direita.** Três linhas da folha
 *    principal têm uma linha da exportação TEI colada a partir da coluna K; só
 *    se lêem as colunas A..J e o resto é ignorado.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const os = require('os');
const ExcelJS = require('exceljs');
const { poolPromise, sql } = require('../db');

// ─── Encontrar o ficheiro ──────────────────────────────────

const NOME_FICHEIRO = 'Radios apanhado.xlsx';

/**
 * `--limpar` esvazia o parque antes de importar. É para desenvolvimento: numa
 * base a sério apaga o que foi registado pelo ecrã desde a última importação.
 */
const LIMPAR = process.argv.includes('--limpar');
const CAMINHO_ARG = process.argv.slice(2).find(a => !a.startsWith('--'));

/** O ficheiro vive no OneDrive sincronizado da CML, cujo nome tem a autarquia lá dentro. */
function localizarFicheiro() {
  const dado = CAMINHO_ARG || process.env.XLSX_RADIOS;
  if (dado) {
    if (!fs.existsSync(dado)) throw new Error(`Ficheiro não encontrado: ${dado}`);
    return dado;
  }
  const casa = os.homedir();
  const candidatos = fs.readdirSync(casa)
    .filter(n => n.toLowerCase().startsWith('onedrive'))
    .map(n => path.join(casa, n, NOME_FICHEIRO))
    .concat([path.join(casa, NOME_FICHEIRO)]);
  const achado = candidatos.find(p => fs.existsSync(p));
  if (!achado) {
    throw new Error(`Não encontrei o "${NOME_FICHEIRO}". Passa o caminho: npm run importar-radios -- "C:\\caminho\\${NOME_FICHEIRO}"`);
  }
  return achado;
}

// ─── Leitura de células ────────────────────────────────────

/** O valor de uma célula do exceljs em texto simples, ou null. */
function valor(cell) {
  if (!cell) return null;
  let v = cell.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    if (v instanceof Date) return v;
    if (Array.isArray(v.richText)) v = v.richText.map(t => t.text).join('');
    else if (v.text !== undefined) v = v.text;
    else if (v.result !== undefined) v = v.result;      // fórmula com valor em cache
    else if (v.error !== undefined) return null;        // #N/A e companhia
    else return null;
  }
  if (v instanceof Date) return v;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function texto(cell, max) {
  const v = valor(cell);
  if (v === null) return null;
  const s = (v instanceof Date) ? v.toISOString().slice(0, 10) : String(v).trim();
  return max ? s.slice(0, max) : s;
}

function numero(cell) {
  const v = valor(cell);
  if (v === null || v instanceof Date) return null;
  const n = Number(String(v).replace(/[^\d-]/g, ''));
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

const MESES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/**
 * Data em ISO, ou null.
 *
 * A folha principal traz datas a sério (o Excel guarda-as como número); a folha
 * `Quest` traz 374 das 400 em texto "17-Oct-25", que é o que o Forms exportou.
 * As duas passam por aqui. O que não se conseguir ler fica null — e na
 * conferência guarda-se também o texto cru ao lado.
 */
function dataISO(cell) {
  const v = valor(cell);
  if (v === null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/.exec(s);          // 17-Oct-25
  if (m) {
    const mes = MESES[m[2].toLowerCase()];
    if (mes) return `20${m[3]}-${String(mes).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  m = /^(\d{1,2})[/](\d{1,2})[/](\d{4})$/.exec(s);          // 17/10/2025
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

/**
 * Indicativo escondido num alias do TETRA.
 *   "LSB PMG317 LX" → "317"     "LSB PMG 776 LX" → "776"     "303" → "303"
 *   "LSB PM2CM LX", "LSB PMC01 LX", "P- Programação" → null
 *
 * Só se aceita o prefixo PMG (rádios de agente) e o número puro. `PM551` e
 * `PMC01` são consolas e viaturas: o número que lá está não é um indicativo de
 * rádio de mão e cruzá-lo com a folha principal dava pares errados.
 */
function indicativoDoAlias(aliasOuNumero) {
  if (!aliasOuNumero) return null;
  const s = String(aliasOuNumero).trim();
  if (/^\d{1,4}$/.test(s)) return s;
  const m = /\bPMG\s*(\d{1,4})\b/i.exec(s);
  return m ? m[1] : null;
}

/**
 * Série e indicativo de uma linha, já normalizados — e a nota, quando a linha
 * afinal não é um equipamento.
 *
 * Duas armadilhas do ficheiro passam por aqui:
 *
 *  - **As linhas de nota estão em células unidas** (`A339:I339` e companhia), e
 *    o leitor devolve o MESMO texto em todas as colunas da união. Sem este
 *    filtro, "Existem mais 7 rádios Secura 2120 sem número" entrava como um
 *    rádio cujo indicativo, marca, modelo E nome de utilizador eram essa frase
 *    — foi exactamente o que aconteceu na primeira importação. As frases ficam
 *    em `resumo.notas`, que é impresso no fim: são 39 rádios em armazém que o
 *    ficheiro conta mas não lista, e alguém tem de os registar um a um.
 *
 *  - **Há uma linha cujo indicativo é o alias do sistema** ('LSB PMG452 LX'),
 *    da vez em que alguém colou uma linha da exportação TEI por cima. O alias
 *    diz o indicativo lá dentro, portanto lê-se de lá.
 *
 * Uma série a sério não tem espaços nem passa de 24 caracteres — é o que
 * distingue `3PN601013G4M87P` de uma frase.
 */
function identidade(linha, colSerie, colIndicativo) {
  const serieBruta = texto(linha.getCell(colSerie));
  const indBruto = texto(linha.getCell(colIndicativo));
  const indicativo = indicativoDoAlias(indBruto);
  const num_serie = (serieBruta && !/\s/.test(serieBruta) && serieBruta.length <= 24) ? serieBruta : null;
  if (indicativo || num_serie) return { num_serie, indicativo, nota: null };
  const frase = [serieBruta, indBruto].find(v => v && v.length > 20 && /\s/.test(v));
  return { num_serie: null, indicativo: null, nota: frase || null };
}

// ─── Escrita ───────────────────────────────────────────────

/**
 * Encontra ou cria o rádio. A série manda; o indicativo é o plano B.
 * Devolve { id, criado }.
 */
async function garantirRadio(pool, { num_serie, indicativo, marca, modelo, alias_tei, radio_id_tei, tie, obs }) {
  if (num_serie) {
    const r = await pool.request().input('s', sql.NVarChar(60), num_serie)
      .query('SELECT TOP 1 id FROM dbo.radios WHERE num_serie = @s');
    if (r.recordset.length) {
      await completarRadio(pool, r.recordset[0].id, { indicativo, marca, modelo, alias_tei, radio_id_tei, tie, obs });
      return { id: r.recordset[0].id, criado: false };
    }
  }
  if (indicativo) {
    // Sem série, o indicativo identifica — mas só quando o registo existente
    // também não tem série. Casar com um que já tem série colava dois
    // equipamentos diferentes que por acaso partilham o número.
    const r = await pool.request().input('i', sql.NVarChar(20), indicativo)
      .query('SELECT TOP 1 id FROM dbo.radios WHERE indicativo = @i AND num_serie IS NULL ORDER BY id');
    if (r.recordset.length) {
      await completarRadio(pool, r.recordset[0].id, { num_serie, marca, modelo, alias_tei, radio_id_tei, tie, obs });
      return { id: r.recordset[0].id, criado: false };
    }
  }

  const r = await pool.request()
    .input('num_serie', sql.NVarChar(60), num_serie || null)
    .input('indicativo', sql.NVarChar(20), indicativo || null)
    .input('marca', sql.NVarChar(40), marca || null)
    .input('modelo', sql.NVarChar(60), modelo || null)
    .input('alias_tei', sql.NVarChar(60), alias_tei || null)
    .input('radio_id_tei', sql.Int, radio_id_tei ?? null)
    .input('tie', sql.NVarChar(40), tie || null)
    .input('obs', sql.NVarChar(sql.MAX), obs || null)
    .query(`INSERT INTO dbo.radios (num_serie, indicativo, marca, modelo, alias_tei, radio_id_tei, tie, obs)
            OUTPUT INSERTED.id
            VALUES (@num_serie, @indicativo, @marca, @modelo, @alias_tei, @radio_id_tei, @tie, @obs)`);
  return { id: r.recordset[0].id, criado: true };
}

/**
 * Preenche os campos que estiverem vazios, sem nunca escrever por cima do que
 * já lá está: numa segunda corrida, o que foi corrigido no ecrã fica.
 * A série é a excepção vigiada — só entra se mais nenhum rádio a tiver, senão
 * o índice único rejeitava a linha toda.
 */
async function completarRadio(pool, id, campos) {
  const p = pool.request().input('id', sql.Int, id);
  const sets = [];
  for (const [col, tipo, v] of [
    ['indicativo', sql.NVarChar(20), campos.indicativo],
    ['marca', sql.NVarChar(40), campos.marca],
    ['modelo', sql.NVarChar(60), campos.modelo],
    ['alias_tei', sql.NVarChar(60), campos.alias_tei],
    ['radio_id_tei', sql.Int, campos.radio_id_tei],
    ['tie', sql.NVarChar(40), campos.tie],
    ['obs', sql.NVarChar(sql.MAX), campos.obs],
  ]) {
    if (v === null || v === undefined || v === '') continue;
    p.input(col, tipo, v);
    sets.push(`${col} = ISNULL(${col}, @${col})`);
  }
  if (campos.num_serie) {
    p.input('num_serie', sql.NVarChar(60), campos.num_serie);
    sets.push(`num_serie = CASE WHEN num_serie IS NULL
                                 AND NOT EXISTS (SELECT 1 FROM dbo.radios o WHERE o.num_serie = @num_serie)
                            THEN @num_serie ELSE num_serie END`);
  }
  if (!sets.length) return;
  await p.query(`UPDATE dbo.radios SET ${sets.join(', ')}, atualizado_em = GETDATE() WHERE id = @id`);
}

// ─── Folhas ────────────────────────────────────────────────

/** Folha `Radios` — o parque e quem o tem. */
async function importarParque(pool, ws, resumo) {
  for (let i = 2; i <= ws.rowCount; i++) {
    const r = ws.getRow(i);
    const { num_serie, indicativo, nota } = identidade(r, 1, 2);
    if (nota) { resumo.notas.push(nota); continue; }
    if (!num_serie && !indicativo) { resumo.parque.vazias++; continue; }

    const marca = texto(r.getCell(3), 40);
    const modelo = texto(r.getCell(4), 60);
    const matricula = numero(r.getCell(5));
    const nome = texto(r.getCell(6), 200);
    const entrega = dataISO(r.getCell(7));
    const devolucao = dataISO(r.getCell(8));
    let guia = texto(r.getCell(9), 60);
    const obs = texto(r.getCell(10));

    // 'Yes' na coluna da guia é salpico da linha TEI colada à direita (ver o
    // cabeçalho): a coluna só tem 'Guia' ou vazio.
    if (guia && guia.toLowerCase() === 'yes') guia = null;

    const { id, criado } = await garantirRadio(pool, { num_serie, indicativo, marca, modelo, obs });
    resumo.parque.lidas++;
    if (criado) resumo.parque.criados++;

    if (matricula === null && !nome) continue;

    const jaTem = await pool.request()
      .input('rid', sql.Int, id).input('mec', sql.Int, matricula).input('nome', sql.NVarChar(200), nome)
      .query(`SELECT TOP 1 id FROM dbo.radios_atribuicoes
              WHERE radio_id = @rid
                AND (matricula = @mec OR (matricula IS NULL AND @mec IS NULL))
                AND (nome_utilizador = @nome OR (nome_utilizador IS NULL AND @nome IS NULL))`);
    if (jaTem.recordset.length) continue;

    await pool.request()
      .input('rid', sql.Int, id)
      .input('mec', sql.Int, matricula)
      .input('nome', sql.NVarChar(200), nome)
      .input('entrega', sql.Date, entrega)
      .input('devolucao', sql.Date, devolucao)
      .input('guia', sql.NVarChar(60), guia)
      .input('obs', sql.NVarChar(sql.MAX), obs)
      .query(`INSERT INTO dbo.radios_atribuicoes (radio_id, matricula, nome_utilizador, data_entrega, data_devolucao, guia, obs, registado_por)
              VALUES (@rid, @mec, @nome, @entrega, @devolucao, @guia, @obs, N'importação')`);
    resumo.parque.atribuicoes++;
  }
}

/** Folha `Motorola` — os MXP600 novos, com série e TIE, ainda sem indicativo. */
async function importarMotorola(pool, ws, resumo) {
  for (let i = 2; i <= ws.rowCount; i++) {
    const r = ws.getRow(i);
    const marca = texto(r.getCell(1), 40);
    const modelo = texto(r.getCell(2), 60);
    const num_serie = texto(r.getCell(3), 60);
    const tie = texto(r.getCell(4), 40);
    if (!num_serie) continue;
    const { criado } = await garantirRadio(pool, { num_serie, marca: marca || 'Motorola', modelo, tie });
    resumo.motorola.lidas++;
    if (criado) resumo.motorola.criados++;
  }
}

/**
 * Folha `TEI` — a exportação da consola do sistema TETRA.
 * Substituída por inteiro: é uma fotografia, não um diário.
 */
async function importarSistema(pool, ws, resumo) {
  await pool.request().query('DELETE FROM dbo.radios_sistema');
  for (let i = 2; i <= ws.rowCount; i++) {
    const r = ws.getRow(i);
    const alias = texto(r.getCell(1), 60);
    const num_serie = texto(r.getCell(3), 60);
    if (!alias && !num_serie) continue;
    await pool.request()
      .input('alias', sql.NVarChar(60), alias)
      .input('indicativo', sql.NVarChar(20), indicativoDoAlias(alias))
      .input('grupo', sql.NVarChar(60), texto(r.getCell(2), 60))
      .input('serie', sql.NVarChar(60), num_serie)
      .input('rid', sql.Int, numero(r.getCell(4)))
      .input('talkgroup', sql.NVarChar(60), texto(r.getCell(25), 60))
      .input('perfil', sql.NVarChar(60), texto(r.getCell(13), 60))
      .input('interconnect', sql.NVarChar(40), texto(r.getCell(15), 40))
      .input('duplex', sql.VarChar(5), texto(r.getCell(11), 5))
      .input('escuta', sql.VarChar(5), texto(r.getCell(26), 5))
      .input('pstn', sql.VarChar(5), texto(r.getCell(30), 5))
      .query(`INSERT INTO dbo.radios_sistema
                (alias, indicativo, security_group, num_serie, radio_id, talkgroup,
                 perfil_capacidades, interconnect, full_duplex, escuta_ambiente, acesso_pstn)
              VALUES (@alias, @indicativo, @grupo, @serie, @rid, @talkgroup,
                      @perfil, @interconnect, @duplex, @escuta, @pstn)`);
    resumo.sistema.lidas++;
  }

  // ── O sistema entra todo no parque ─────────────────────
  // O alias é a coluna principal do parque, portanto nenhum equipamento
  // programado no TETRA pode ficar de fora. São três passos, e a ordem importa:
  // ligar pela série, ligar pelo indicativo, e só depois criar o que sobrar —
  // ao contrário, criavam-se duplicados de rádios que já lá estavam.

  // 1. Pela série, que é a chave forte: identifica o aparelho sem ambiguidade.
  const porSerie = await pool.request().query(`
    UPDATE r SET r.alias_tei = ISNULL(r.alias_tei, s.alias),
                 r.radio_id_tei = ISNULL(r.radio_id_tei, s.radio_id),
                 r.atualizado_em = GETDATE()
    FROM dbo.radios r
    INNER JOIN dbo.radios_sistema s ON s.num_serie = r.num_serie
    WHERE r.num_serie IS NOT NULL AND (r.alias_tei IS NULL OR r.radio_id_tei IS NULL)`);
  resumo.sistema.ligados_por_serie = porSerie.rowsAffected[0];

  // 2. Pelo indicativo, para os 132 rádios que não têm série e por isso o passo
  //    anterior não apanha. Só quando o indicativo é ÚNICO dos dois lados: no
  //    parque há indicativos repetidos (reatribuições nunca fechadas) e ligar um
  //    alias a dois rádios diferentes era inventar. A série do sistema também
  //    desce, mas só se mais nenhum rádio a tiver — senão viola o índice único.
  const porIndicativo = await pool.request().query(`
    WITH sis AS (
      SELECT indicativo, MIN(alias) AS alias, MIN(radio_id) AS radio_id, MIN(num_serie) AS num_serie
      FROM dbo.radios_sistema WHERE indicativo IS NOT NULL
      GROUP BY indicativo HAVING COUNT(*) = 1
    ),
    par AS (
      SELECT indicativo FROM dbo.radios WHERE indicativo IS NOT NULL
      GROUP BY indicativo HAVING COUNT(*) = 1
    )
    UPDATE r SET r.alias_tei    = ISNULL(r.alias_tei, sis.alias),
                 r.radio_id_tei = ISNULL(r.radio_id_tei, sis.radio_id),
                 r.num_serie    = CASE WHEN r.num_serie IS NULL
                                        AND NOT EXISTS (SELECT 1 FROM dbo.radios o WHERE o.num_serie = sis.num_serie)
                                   THEN sis.num_serie ELSE r.num_serie END,
                 r.atualizado_em = GETDATE()
    FROM dbo.radios r
    INNER JOIN par ON par.indicativo = r.indicativo
    INNER JOIN sis ON sis.indicativo = r.indicativo
    WHERE r.alias_tei IS NULL`);
  resumo.sistema.ligados_por_indicativo = porIndicativo.rowsAffected[0];

  // 3. O que continua a não constar entra como equipamento novo. Vem sem marca
  //    nem modelo — a exportação do TETRA não os traz —, e leva a proveniência
  //    em `obs` para não se confundir com o que veio do ficheiro do parque.
  //    Nem todos são rádios de mão: os alias sem indicativo (PMC01, PM2CM,
  //    PM551) são consolas, despachos e viaturas.
  const criados = await pool.request().query(`
    INSERT INTO dbo.radios (num_serie, indicativo, alias_tei, radio_id_tei, obs)
    SELECT s.num_serie, s.indicativo, s.alias, s.radio_id,
           N'Veio do registo TETRA; não constava do ficheiro do parque.'
    FROM dbo.radios_sistema s
    WHERE NOT EXISTS (SELECT 1 FROM dbo.radios r WHERE r.num_serie = s.num_serie)
      AND NOT EXISTS (SELECT 1 FROM dbo.radios r WHERE r.alias_tei = s.alias)`);
  resumo.sistema.criados_no_parque = criados.rowsAffected[0];
}

/**
 * Folhas `Radios Avariados` + `Folha1` — a mesma lista vista de dois lados.
 * A primeira identifica por indicativo; a segunda traz o número de série e o
 * alias do sistema para os mesmos equipamentos. Lêem-se as duas: o que a
 * segunda acrescenta é a série que faltava.
 */
async function importarAvarias(pool, wsAvariados, wsFolha1, resumo) {
  const porIndicativo = new Map();

  if (wsFolha1) {
    for (let i = 2; i <= wsFolha1.rowCount; i++) {
      const r = wsFolha1.getRow(i);
      const alias = texto(r.getCell(1), 60);
      const num_serie = texto(r.getCell(3), 60);
      const ind = indicativoDoAlias(alias);
      if (!ind || !num_serie) continue;   // legenda ('P- Programação') e '?' caem aqui
      porIndicativo.set(ind, {
        num_serie,
        alias_tei: /PMG/i.test(alias) ? alias : null,
        marca: texto(r.getCell(4), 40),
        ordem: texto(r.getCell(6), 10),
        localizacao: texto(r.getCell(7), 60),
        tipo: texto(r.getCell(8), 120),
      });
      resumo.folha1.lidas++;
    }
  }

  for (let i = 2; i <= wsAvariados.rowCount; i++) {
    const r = wsAvariados.getRow(i);
    const { num_serie, indicativo, nota } = identidade(r, 1, 2);
    if (nota) { resumo.notas.push(nota); continue; }
    if (!indicativo) continue;
    const extra = porIndicativo.get(indicativo) || {};

    const { id } = await garantirRadio(pool, {
      num_serie: num_serie || extra.num_serie || null,
      indicativo,
      marca: texto(r.getCell(3), 40) || extra.marca || null,
      modelo: texto(r.getCell(4), 60),
      alias_tei: extra.alias_tei || null,
    });
    resumo.avariados.lidas++;

    const tipo = texto(r.getCell(11), 120) || extra.tipo || null;
    const ordem = texto(r.getCell(9), 10) || extra.ordem || null;
    const local = texto(r.getCell(10), 60) || extra.localizacao || 'Aguarda Reparação';

    const aberta = await pool.request().input('rid', sql.Int, id)
      .query(`SELECT TOP 1 id FROM dbo.radios_avarias WHERE radio_id = @rid AND estado = 'aberta'`);
    if (aberta.recordset.length) continue;

    await pool.request()
      .input('rid', sql.Int, id)
      .input('tipo', sql.NVarChar(120), tipo)
      .input('ordem', sql.VarChar(10), ordem ? ordem.toUpperCase() : null)
      .input('local', sql.NVarChar(60), local)
      .query(`INSERT INTO dbo.radios_avarias (radio_id, tipo_avaria, ordem, localizacao, estado, registado_por)
              VALUES (@rid, @tipo, @ordem, @local, 'aberta', N'importação')`);
    resumo.avariados.avarias++;
  }
}

/** Folha `Radios - Abate`. */
async function importarAbates(pool, ws, resumo) {
  for (let i = 2; i <= ws.rowCount; i++) {
    const r = ws.getRow(i);
    const { num_serie, indicativo, nota } = identidade(r, 1, 2);
    if (nota) { resumo.notas.push(nota); continue; }
    if (!indicativo) continue;
    const { id } = await garantirRadio(pool, {
      num_serie,
      indicativo,
      marca: texto(r.getCell(3), 40),
      modelo: texto(r.getCell(4), 60),
    });
    resumo.abates.lidas++;

    const ja = await pool.request().input('rid', sql.Int, id)
      .query('SELECT TOP 1 id FROM dbo.radios_abates WHERE radio_id = @rid');
    if (ja.recordset.length) continue;

    await pool.request()
      .input('rid', sql.Int, id)
      .input('motivo', sql.NVarChar(200), texto(r.getCell(10), 200))
      .query(`INSERT INTO dbo.radios_abates (radio_id, motivo, registado_por)
              VALUES (@rid, @motivo, N'importação')`);
    resumo.abates.abatidos++;
  }
}

/** Folha `Quest` — as respostas ao questionário. Substituída por inteiro. */
async function importarConferencia(pool, ws, resumo) {
  await pool.request().query('DELETE FROM dbo.radios_conferencia');
  for (let i = 2; i <= ws.rowCount; i++) {
    const r = ws.getRow(i);
    const nome = texto(r.getCell(5), 200);
    const matricula = numero(r.getCell(6));
    if (!nome && matricula === null) continue;

    // "SIM" / "NÃO" / "Não" na origem — sem acentos nem maiúsculas à sorte.
    const bruto = texto(r.getCell(7), 10);
    const tem = bruto ? (bruto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().startsWith('S') ? 'SIM' : 'NAO') : null;

    await pool.request()
      .input('origem', sql.Int, numero(r.getCell(1)))
      .input('dt', sql.Date, dataISO(r.getCell(3)) || dataISO(r.getCell(2)))
      .input('dtxt', sql.NVarChar(40), texto(r.getCell(3), 40) || texto(r.getCell(2), 40))
      .input('email', sql.NVarChar(200), texto(r.getCell(4), 200))
      .input('nome', sql.NVarChar(200), nome)
      .input('mec', sql.Int, matricula)
      .input('tem', sql.VarChar(10), tem)
      .input('ind', sql.NVarChar(20), texto(r.getCell(8), 20))
      .input('bat', sql.Int, numero(r.getCell(9)))
      .input('obs', sql.NVarChar(sql.MAX), texto(r.getCell(10)))
      .query(`INSERT INTO dbo.radios_conferencia
                (origem_id, data_resposta, data_resposta_texto, email, nome, matricula, tem_radio, indicativo_declarado, baterias, obs)
              VALUES (@origem, @dt, @dtxt, @email, @nome, @mec, @tem, @ind, @bat, @obs)`);
    resumo.conferencia.lidas++;
  }
}

// ─── Orquestração ──────────────────────────────────────────

async function principal() {
  const ficheiro = localizarFicheiro();
  console.log(`A ler ${ficheiro}`);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(ficheiro);

  const folha = nome => {
    const ws = wb.getWorksheet(nome);
    if (!ws) console.warn(`  ⚠ folha "${nome}" não existe neste ficheiro — ignorada`);
    return ws;
  };

  const pool = await poolPromise;
  if (!pool) throw new Error('Sem ligação à base de dados — ver o .env.');

  if (LIMPAR) {
    // As atribuições, avarias e abates caem com o rádio (ON DELETE CASCADE).
    // O registo de importações não se limpa: é o histórico de quem correu isto.
    await pool.request().query('DELETE FROM dbo.radios');
    await pool.request().query('DELETE FROM dbo.radios_sistema');
    await pool.request().query('DELETE FROM dbo.radios_conferencia');
    console.log('  (parque esvaziado antes de importar — --limpar)');
  }

  const resumo = {
    parque: { lidas: 0, criados: 0, atribuicoes: 0, vazias: 0 },
    motorola: { lidas: 0, criados: 0 },
    sistema: { lidas: 0, ligados_por_serie: 0, ligados_por_indicativo: 0, criados_no_parque: 0 },
    avariados: { lidas: 0, avarias: 0 },
    folha1: { lidas: 0 },
    abates: { lidas: 0, abatidos: 0 },
    conferencia: { lidas: 0 },
    notas: [],
  };

  // ⚠️ A ORDEM IMPORTA, e o `TEI` é o ÚLTIMO de propósito.
  //
  // As folhas do parque, dos abates e dos avariados encontram o equipamento pelo
  // `garantirRadio()`, que sem número de série procura pelo indicativo **entre
  // os rádios que também não têm série**. O TEI preenche séries (passo 2 da
  // ligação), portanto se corresse antes tirava esses rádios do alcance dessa
  // procura: o `garantirRadio` deixava de os encontrar e criava duplicados —
  // aconteceu, e custou 52 indicativos repetidos, 27 avarias e 14 abates falsos.
  //
  // Correndo no fim, o TEI é a última palavra: liga o que existe e cria o que
  // falta, e já ninguém procura equipamento depois dele.
  const ordem = [
    ['Radios', ws => importarParque(pool, ws, resumo)],
    ['Motorola', ws => importarMotorola(pool, ws, resumo)],
    ['Radios - Abate', ws => importarAbates(pool, ws, resumo)],
    ['Quest', ws => importarConferencia(pool, ws, resumo)],
  ];
  for (const [nome, fn] of ordem) {
    const ws = folha(nome);
    if (!ws) continue;
    process.stdout.write(`  ${nome}… `);
    await fn(ws);
    console.log('ok');
  }

  const wsAvariados = folha('Radios Avariados');
  if (wsAvariados) {
    process.stdout.write('  Radios Avariados + Folha1… ');
    await importarAvarias(pool, wsAvariados, folha('Folha1'), resumo);
    console.log('ok');
  }

  // Por último o TEI — ver a nota na `ordem` acima. Depois daqui já ninguém
  // procura equipamento pelo indicativo.
  const wsSistema = folha('TEI');
  if (wsSistema) {
    process.stdout.write('  TEI… ');
    await importarSistema(pool, wsSistema, resumo);
    console.log('ok');
  }

  // O estado é coluna (ver migração 001) e quem o escreve são as rotas; numa
  // importação em massa vale a pena fazê-lo de uma vez só, com a mesma regra.
  await pool.request().query(`
    UPDATE dbo.radios
    SET estado = CASE
          WHEN EXISTS (SELECT 1 FROM dbo.radios_abates  a WHERE a.radio_id = radios.id) THEN 'abatido'
          WHEN EXISTS (SELECT 1 FROM dbo.radios_avarias v WHERE v.radio_id = radios.id AND v.estado = 'aberta') THEN 'avariado'
          WHEN EXISTS (SELECT 1 FROM dbo.radios_atribuicoes t WHERE t.radio_id = radios.id AND t.data_devolucao IS NULL) THEN 'atribuido'
          ELSE 'disponivel' END,
        atualizado_em = GETDATE()`);

  await pool.request()
    .input('f', sql.NVarChar(400), ficheiro)
    .input('r', sql.NVarChar(sql.MAX), JSON.stringify(resumo))
    .input('por', sql.NVarChar(120), process.env.USERNAME || 'desconhecido')
    .query('INSERT INTO dbo.radios_importacoes (ficheiro, resumo, executado_por) VALUES (@f, @r, @por)');

  const contagens = await pool.request().query(`
    SELECT estado, COUNT(*) AS total FROM dbo.radios GROUP BY estado ORDER BY estado`);

  console.log('\nResumo da importação:');
  console.log(JSON.stringify(resumo, null, 2));
  console.log('\nParque por estado:');
  for (const l of contagens.recordset) console.log(`  ${l.estado.padEnd(12)} ${l.total}`);
  if (resumo.notas.length) {
    console.log('\nNotas da folha que NÃO são equipamentos (ficam por registar):');
    for (const n of resumo.notas) console.log(`  · ${n}`);
  }
}

principal()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('\nImportação falhou:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
