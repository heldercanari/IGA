'use strict';

/**
 * Importador de `master radios.xlsx` + `atribuidos.xlsx` → base de dados.
 *
 *   npm run importar-radios
 *
 * Substitui por completo o importador anterior (`Radios apanhado.xlsx`, 7
 * folhas, e as fontes que vieram depois — `TEI radios.xlsx`, a folha TEI
 * antiga). Essas fontes deixaram de se usar; ficam só estas duas, cada uma com
 * o seu papel:
 *
 *   `master radios.xlsx`  → QUE equipamento existe e como se identifica
 *                            (ALIAS, S/N, TEI, ISSI, Marca, Modelo). É o único
 *                            ficheiro da casa com chaves a sério — 765 valores
 *                            únicos em cada coluna.
 *   `atribuidos.xlsx`     → QUEM tem cada rádio agora (email, utilizador,
 *                            matrícula, Nº rádio). Não traz datas — a entrega se
 *                            é gravada com `DATA_ATRIBUICAO_PADRAO`, que é
 *                            quando este levantamento foi feito, não quando a
 *                            entrega aconteceu de facto (isso perdeu-se).
 *
 * ⚠️ Não há avarias nem abates nestas duas fontes. Correr este importador não
 * mexe em `radios_avarias` nem `radios_abates` — ficam como o ecrã os deixou,
 * até haver ficheiro próprio para isso.
 *
 * Corre as vezes que forem precisas: o equipamento é encontrado pelo alias (a
 * chave do master) e a atribuição por (rádio, matrícula) — não duplica. Ao
 * contrário do importador anterior, este NÃO tem `--limpar`: não apaga nada em
 * bloco. Uma segunda corrida sincroniza — fecha o que já não bate e abre o que
 * é novo — em vez de destruir e recomeçar.
 */

require('dotenv').config();

const ExcelJS = require('exceljs');
const { poolPromise, sql } = require('../db');

const MASTER = 'C:\\Apps\\master radios.xlsx';
const ATRIBUIDOS = 'C:\\Apps\\atribuidos.xlsx';

/**
 * O `atribuidos.xlsx` não traz datas — só diz quem tem o quê agora. Esta é a
 * data combinada para todas as entregas desta importação (decisão do
 * utilizador, 2026-09-04): representa quando o levantamento foi feito, não uma
 * data de entrega real que o ficheiro simplesmente não tem.
 */
const DATA_ATRIBUICAO_PADRAO = '2025-10-01';

/**
 * Os dois rádios em que o ficheiro tem duas pessoas DIFERENTES a reclamá-los —
 * não é correcção (nomes diferentes, não a mesma pessoa duas vezes) — ficam de
 * fora dos dois lados até se resolver na origem (decisão do utilizador).
 */
const RADIOS_EM_CONFLITO = new Set(['445', '380']);

/**
 * Sara Ferreira (152235) está na folha com "34" — não existe rádio nenhum com
 * esse indicativo no master, e o utilizador confirmou que o valor certo é
 * "834". Mas o 834 já está legitimamente entregue a outra pessoa (Luís
 * Teixeira, 136939), vinda desta mesma folha — ligar lá a Sara também criava
 * um SEGUNDO conflito por cima do primeiro, e não é a este importador que cabe
 * decidir qual dos dois fica. Trata-se como os outros conflitos: fica de fora,
 * visível no resumo, até se resolver na origem.
 */
const MATRICULAS_EM_CONFLITO = new Set([152235]);

// ─── Leitura de células ────────────────────────────────────

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
  const s = (v instanceof Date) ? v.toISOString().slice(0, 10) : String(v).replace(/\u00a0/g, ' ').trim();
  return max ? s.slice(0, max) : s;
}

function numero(cell) {
  const v = valor(cell);
  if (v === null || v instanceof Date) return null;
  const n = Number(String(v).replace(/[^\d-]/g, ''));
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Um número de série nunca tem espaço a sério. Quando aparece um, é ruído de
 * transcrição — tira-se sempre, para bater certo entre fontes.
 */
function serie(cell, max) {
  const v = texto(cell, max);
  return v ? v.replace(/\s+/g, '') : v;
}

/**
 * Indicativo escondido num alias do TETRA: "LSB PMG842 LX" → "842",
 * "LSB PMG 834 LX" (com espaço) → "834". Só o prefixo PMG conta como
 * indicativo de rádio de mão — PMC/PM2CM/PMV são consolas, despachos e
 * viaturas, e o número que trazem não é um indicativo de agente.
 */
function indicativoDoAlias(alias) {
  if (!alias) return null;
  const m = /\bPMG\s*(\d{1,4})\b/i.exec(String(alias));
  return m ? m[1] : null;
}

/** Todos os números soltos num texto — normalmente um só, às vezes mais do
 *  que um quando o campo é composto ("643 (comando) / 349 (Paços do Concelho)"). */
function numerosDoTexto(bruto) {
  if (!bruto) return [];
  return bruto.match(/\d+/g) || [];
}

// ─── Master: identificação ─────────────────────────────────

/**
 * Encontra ou cria o rádio, e traz a identificação do master para cima dele.
 *
 * A procura é por alias (chave forte do master) e depois por série; só cria de
 * novo se nenhuma bater. O modelo tem duas correcções, confirmadas por quem
 * gere a frota: os 50 Motorola vêm numerados em sequência no ficheiro
 * ("MPX 600", "MPX 601", "MPX 602"…) — é arrastamento de célula do Excel, o
 * modelo é "MPX 600" nos 50; e "SC" sozinho não é modelo nenhum, é a família
 * dos Sepura — gravá-lo apagava um modelo mais específico que já lá estivesse.
 */
async function importarMaster(pool, resumo) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(MASTER);
  const ws = wb.worksheets[0];

  for (let i = 2; i <= ws.rowCount; i++) {
    const r = ws.getRow(i);
    const alias = texto(r.getCell(1), 60);
    const num_serie = serie(r.getCell(2), 60);
    const tie = texto(r.getCell(3), 40);
    const issi = numero(r.getCell(4));
    const marca = texto(r.getCell(5), 40);
    const modeloBruto = texto(r.getCell(6), 60);
    if (!alias && !num_serie) continue;
    resumo.master.lidas++;

    const modelo = (marca === 'Motorola' && /^MPX\s*\d/i.test(modeloBruto || '')) ? 'MPX 600'
                 : (/^SC$/i.test(modeloBruto || '') ? null : modeloBruto);
    const indicativo = indicativoDoAlias(alias);

    let id = null;
    if (alias) {
      const r1 = await pool.request().input('v', sql.NVarChar(60), alias)
        .query('SELECT TOP 1 id FROM dbo.radios WHERE alias_tei = @v');
      if (r1.recordset.length) id = r1.recordset[0].id;
    }
    if (!id && num_serie) {
      const r2 = await pool.request().input('v', sql.NVarChar(60), num_serie)
        .query('SELECT TOP 1 id FROM dbo.radios WHERE num_serie = @v');
      if (r2.recordset.length) id = r2.recordset[0].id;
    }
    if (!id && indicativo) {
      // Cobre o rádio que o atribuidos.xlsx criou em bruto (sem ficha) numa
      // corrida anterior, para o master o vir completar em vez de duplicar —
      // só quando é o único com esse indicativo, como em todo o lado nesta casa.
      const r3 = await pool.request().input('i', sql.NVarChar(20), indicativo)
        .query(`SELECT TOP 1 id FROM dbo.radios WHERE indicativo = @i
                  AND (SELECT COUNT(*) FROM dbo.radios o WHERE o.indicativo = @i) = 1`);
      if (r3.recordset.length) id = r3.recordset[0].id;
    }

    if (id) {
      await pool.request()
        .input('id', sql.Int, id)
        .input('alias', sql.NVarChar(60), alias)
        .input('serie', sql.NVarChar(60), num_serie)
        .input('tie', sql.NVarChar(40), tie)
        .input('issi', sql.Int, issi)
        .input('marca', sql.NVarChar(40), marca)
        .input('modelo', sql.NVarChar(60), modelo)
        .input('ind', sql.NVarChar(20), indicativo)
        .query(`UPDATE dbo.radios SET
                  alias_tei     = ISNULL(@alias, alias_tei),
                  tie           = ISNULL(@tie, tie),
                  radio_id_tei  = ISNULL(@issi, radio_id_tei),
                  marca         = ISNULL(@marca, marca),
                  modelo        = ISNULL(modelo, @modelo),
                  indicativo    = ISNULL(indicativo, @ind),
                  num_serie     = CASE WHEN num_serie IS NULL AND @serie IS NOT NULL
                                        AND NOT EXISTS (SELECT 1 FROM dbo.radios o WHERE o.num_serie = @serie AND o.id <> @id)
                                   THEN @serie ELSE num_serie END,
                  atualizado_em = GETDATE()
                WHERE id = @id`);
      resumo.master.actualizados++;
    } else {
      await pool.request()
        .input('serie', sql.NVarChar(60), num_serie)
        .input('ind', sql.NVarChar(20), indicativo)
        .input('marca', sql.NVarChar(40), marca)
        .input('modelo', sql.NVarChar(60), modelo)
        .input('alias', sql.NVarChar(60), alias)
        .input('issi', sql.Int, issi)
        .input('tie', sql.NVarChar(40), tie)
        .query(`INSERT INTO dbo.radios (num_serie, indicativo, marca, modelo, alias_tei, radio_id_tei, tie)
                VALUES (@serie, @ind, @marca, @modelo, @alias, @issi, @tie)`);
      resumo.master.criados++;
    }
  }
}

// ─── Atribuídos: quem tem o quê ────────────────────────────

/** O rádio desse indicativo — do master; se não existir, cria ficha mínima. */
async function radioDoIndicativo(pool, indicativo, resumo) {
  const achado = await pool.request().input('i', sql.NVarChar(20), indicativo)
    .query('SELECT TOP 1 id FROM dbo.radios WHERE indicativo = @i');
  if (achado.recordset.length) return achado.recordset[0].id;

  const criado = await pool.request()
    .input('ind', sql.NVarChar(20), indicativo)
    .input('obs', sql.NVarChar(sql.MAX), 'Só consta no atribuidos.xlsx; sem ficha no master.')
    .query(`INSERT INTO dbo.radios (indicativo, obs) OUTPUT INSERTED.id VALUES (@ind, @obs)`);
  resumo.atribuidos.radios_criados++;
  return criado.recordset[0].id;
}

/**
 * Sincroniza as entregas de UMA pessoa com o que o ficheiro diz que ela tem
 * agora — em vez de só acrescentar. Fecha o que já não bate (mudou de rádio, ou
 * deixou de o ter) e abre o que falta; o que já está correcto fica intocado.
 * É o que torna uma segunda corrida segura: não duplica, e uma reatribuição
 * futura fecha a entrega antiga sozinha.
 *
 * Normalmente `indicativos` tem um elemento só; o caso composto ("643/349",
 * a mesma pessoa com dois rádios consoante o local) tem dois — os dois ficam
 * simultaneamente entregues, e é por isso que este é o único sítio que trata
 * de MAIS do que uma entrega de cada vez para a mesma pessoa.
 */
async function sincronizarEntregas(pool, pessoa, indicativos, resumo) {
  const idsAlvo = [];
  const vistos = new Set();
  for (const ind of indicativos) {
    const id = await radioDoIndicativo(pool, ind, resumo);
    if (vistos.has(id)) continue;
    vistos.add(id);
    idsAlvo.push(id);
  }
  if (!idsAlvo.length) { resumo.atribuidos.sem_radio++; return; }

  const abertas = await pool.request().input('mat', sql.Int, pessoa.matricula)
    .query('SELECT id, radio_id FROM dbo.radios_atribuicoes WHERE matricula = @mat AND data_devolucao IS NULL');

  for (const a of abertas.recordset) {
    if (idsAlvo.includes(a.radio_id)) continue;
    await pool.request().input('id', sql.Int, a.id).input('fim', sql.Date, DATA_ATRIBUICAO_PADRAO)
      .query('UPDATE dbo.radios_atribuicoes SET data_devolucao = @fim WHERE id = @id');
  }

  const jaTem = new Set(abertas.recordset.filter(a => idsAlvo.includes(a.radio_id)).map(a => a.radio_id));
  for (const radioId of idsAlvo) {
    if (jaTem.has(radioId)) continue;
    await pool.request()
      .input('rid', sql.Int, radioId)
      .input('mat', sql.Int, pessoa.matricula)
      .input('nome', sql.NVarChar(200), pessoa.nome)
      .input('entrega', sql.Date, DATA_ATRIBUICAO_PADRAO)
      .query(`INSERT INTO dbo.radios_atribuicoes (radio_id, matricula, nome_utilizador, data_entrega, registado_por)
              VALUES (@rid, @mat, @nome, @entrega, N'importação')`);
    resumo.atribuidos.atribuicoes++;
  }
}

async function importarAtribuicoes(pool, resumo) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(ATRIBUIDOS);
  const ws = wb.worksheets[0];

  const linhas = [];
  for (let i = 2; i <= ws.rowCount; i++) {
    const r = ws.getRow(i);
    const email = texto(r.getCell(1), 200);
    const nome = texto(r.getCell(2), 200);
    const matricula = numero(r.getCell(3));
    const radioBruto = texto(r.getCell(4), 200);
    if (!email && !nome && !matricula && !radioBruto) continue;
    linhas.push({ linha: i, email, nome, matricula, radioBruto });
  }
  resumo.atribuidos.lidas = linhas.length;

  // Fora os rádios em conflito verdadeiro — as duas pessoas de cada lado —
  // e as pessoas cuja linha, por si só, já leva a um conflito (ver MATRICULAS_EM_CONFLITO).
  const semConflito = linhas.filter(l => {
    const emConflito = numerosDoTexto(l.radioBruto).some(n => RADIOS_EM_CONFLITO.has(n))
      || (l.matricula != null && MATRICULAS_EM_CONFLITO.has(l.matricula));
    if (emConflito) resumo.atribuidos.em_conflito++;
    return !emConflito;
  });

  // "A última linha vale": agrupar por matrícula, o Map guarda só a última
  // escrita — cobre as pessoas que aparecem duas vezes com rádios diferentes.
  const porMatricula = new Map();
  let comMatricula = 0;
  for (const l of semConflito) {
    if (l.matricula == null) continue;
    comMatricula++;
    porMatricula.set(l.matricula, l);
  }
  resumo.atribuidos.duplicadas = comMatricula - porMatricula.size;

  for (const pessoa of porMatricula.values()) {
    const indicativos = numerosDoTexto(pessoa.radioBruto);
    await sincronizarEntregas(pool, pessoa, indicativos, resumo);
  }
}

// ─── Orquestração ──────────────────────────────────────────

async function principal() {
  const pool = await poolPromise;
  if (!pool) throw new Error('Sem ligação à base de dados — ver o .env.');

  const resumo = {
    master: { lidas: 0, criados: 0, actualizados: 0 },
    atribuidos: { lidas: 0, duplicadas: 0, em_conflito: 0, sem_radio: 0, radios_criados: 0, atribuicoes: 0 },
  };

  process.stdout.write('  master radios.xlsx… ');
  await importarMaster(pool, resumo);
  console.log('ok');

  process.stdout.write('  atribuidos.xlsx… ');
  await importarAtribuicoes(pool, resumo);
  console.log('ok');

  // O estado é coluna e não consulta (ver a migração 001); recalcula-se sempre
  // no fim, a partir dos factos. Sem fonte de avarias/abates nestas duas
  // folhas, isto só decide entre atribuído e disponível — mas corre na mesma,
  // para não ficar desalinhado com avarias/abates que o ecrã já tenha registado.
  await pool.request().query(`
    UPDATE dbo.radios
    SET estado = CASE
          WHEN EXISTS (SELECT 1 FROM dbo.radios_abates  a WHERE a.radio_id = radios.id) THEN 'abatido'
          WHEN EXISTS (SELECT 1 FROM dbo.radios_avarias v WHERE v.radio_id = radios.id AND v.estado = 'aberta') THEN 'avariado'
          WHEN EXISTS (SELECT 1 FROM dbo.radios_atribuicoes t WHERE t.radio_id = radios.id AND t.data_devolucao IS NULL) THEN 'atribuido'
          ELSE 'disponivel' END,
        atualizado_em = GETDATE()`);

  const contagens = await pool.request().query(
    'SELECT estado, COUNT(*) AS total FROM dbo.radios GROUP BY estado ORDER BY estado');

  console.log('\nResumo da importação:');
  console.log(JSON.stringify(resumo, null, 2));
  console.log('\nParque por estado:');
  for (const l of contagens.recordset) console.log(`  ${l.estado.padEnd(12)} ${l.total}`);
}

principal()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('\nImportação falhou:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
