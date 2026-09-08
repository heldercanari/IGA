'use strict';

/**
 * Importador de `master radios.xlsx` + `atribuidos.xlsx` + `avarias.csv` →
 * base de dados.
 *
 *   npm run importar-radios
 *
 * Substitui por completo o importador anterior (`Radios apanhado.xlsx`, 7
 * folhas, e as fontes que vieram depois — `TEI radios.xlsx`, a folha TEI
 * antiga). Essas fontes deixaram de se usar; ficam só estas três, cada uma com
 * o seu papel:
 *
 *   `master radios.xlsx`  → QUE equipamento existe e como se identifica
 *                            (ALIAS, S/N, TEI, ISSI, Marca, Modelo). É o único
 *                            ficheiro da casa com chaves a sério — 765 valores
 *                            únicos em cada coluna. Fora do repositório
 *                            (`C:\Apps\`), como o `atribuidos.xlsx`.
 *   `atribuidos.xlsx`     → QUEM tem cada rádio agora (email, utilizador,
 *                            matrícula, Nº rádio). Não traz datas — a entrega
 *                            é gravada com `DATA_ATRIBUICAO_PADRAO`, que é
 *                            quando este levantamento foi feito, não quando a
 *                            entrega aconteceu de facto (isso perdeu-se).
 *   `avarias.csv`         → QUE rádios estão à espera de reparação (Obs,
 *                            Avaria, Rádio). ⚠️ Ao contrário das outras duas,
 *                            **vive dentro do repositório** — é para se editar
 *                            à mão e ficar no histórico do git: um rádio que
 *                            saia da lista porque foi reparado, e a linha
 *                            desaparece do ficheiro, fica com a avaria fechada
 *                            sozinho na corrida seguinte (ver `importarAvariasCSV`).
 *
 * Não há abates nestas três fontes. Correr este importador não mexe em
 * `radios_abates` — fica como o ecrã o deixou, até haver ficheiro próprio.
 *
 * Corre as vezes que forem precisas: o equipamento é encontrado pelo alias (a
 * chave do master) e a atribuição por (rádio, matrícula) — não duplica. Ao
 * contrário do importador anterior, este NÃO tem `--limpar`: não apaga nada em
 * bloco.
 *
 * ⚠️ **A BASE MANDA** (decisão de 2026-09-07, ver `_sincronizacao.js`). Mudou o
 * que uma segunda corrida faz:
 *
 *  - **`master radios.xlsx`** já não escreve por cima de nada. Um campo com
 *    valor na base fica como está; só se preenchem os vazios. (Até esta data o
 *    alias, o TIE, o ISSI e a marca eram do ficheiro — o resto já era da base.)
 *  - **`atribuidos.xlsx` deixou de fechar entregas.** Era o "quem tem o quê
 *    agora" e passou a ser uma sugestão: abre entregas só para rádios que a base
 *    tem por entregar, e nunca tira um rádio a quem a base diz que o tem.
 *  - **`avarias.csv` é a excepção, e continua a mandar nas suas avarias.** Não é
 *    um dump de outro sistema: é escrito à mão dentro deste repositório para ser
 *    a interface das avarias, e tirar-lhe uma linha continua a ser a forma de
 *    dizer "reparado". Só mexe nas avarias que ele próprio abriu — as do ecrã
 *    ficam intocadas, como sempre ficaram.
 *
 * O que as folhas dizem de diferente não se perde: aparece no resumo, campo a
 * campo, para se resolver onde manda.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { poolPromise, sql } = require('../db');
// A regra é a mesma nos quatro importadores: a base manda. Ver o ficheiro.
const { divergencias, mostrarDivergencias } = require('./_sincronizacao');

const MASTER = 'C:\\Apps\\master radios.xlsx';
const ATRIBUIDOS = 'C:\\Apps\\atribuidos.xlsx';
const AVARIAS_CSV = path.join(__dirname, '..', 'avarias.csv');

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

    // Traz-se a linha inteira, não só o id: é com ela que se vê onde é que o
    // master discorda da base.
    let linha = null;
    if (alias) {
      const r1 = await pool.request().input('v', sql.NVarChar(60), alias)
        .query('SELECT TOP 1 * FROM dbo.radios WHERE alias_tei = @v');
      if (r1.recordset.length) linha = r1.recordset[0];
    }
    if (!linha && num_serie) {
      const r2 = await pool.request().input('v', sql.NVarChar(60), num_serie)
        .query('SELECT TOP 1 * FROM dbo.radios WHERE num_serie = @v');
      if (r2.recordset.length) linha = r2.recordset[0];
    }
    if (!linha && indicativo) {
      // Cobre o rádio que o atribuidos.xlsx criou em bruto (sem ficha) numa
      // corrida anterior, para o master o vir completar em vez de duplicar —
      // só quando é o único com esse indicativo, como em todo o lado nesta casa.
      const r3 = await pool.request().input('i', sql.NVarChar(20), indicativo)
        .query(`SELECT TOP 1 * FROM dbo.radios WHERE indicativo = @i
                  AND (SELECT COUNT(*) FROM dbo.radios o WHERE o.indicativo = @i) = 1`);
      if (r3.recordset.length) linha = r3.recordset[0];
    }
    const id = linha ? linha.id : null;

    if (id) {
      // A BASE MANDA: o que o master diz de diferente não se grava, aparece no
      // resumo. As chaves são as colunas da base, para a comparação bater certo.
      for (const d of divergencias(linha, {
        alias_tei: alias, tie, radio_id_tei: issi, marca, modelo,
        indicativo, num_serie,
      })) {
        resumo.divergencias.push({ chave: indicativo || alias || num_serie, ...d });
      }

      await pool.request()
        .input('id', sql.Int, id)
        .input('alias', sql.NVarChar(60), alias)
        .input('serie', sql.NVarChar(60), num_serie)
        .input('tie', sql.NVarChar(40), tie)
        .input('issi', sql.Int, issi)
        .input('marca', sql.NVarChar(40), marca)
        .input('modelo', sql.NVarChar(60), modelo)
        .input('ind', sql.NVarChar(20), indicativo)
        // A base primeiro em TODOS os campos: `ISNULL(coluna, @novo)` fica com o
        // que a base tem e só usa o do ficheiro quando ela não tem nada.
        // ⚠️ Até 2026-09-07 o alias, o TIE, o ISSI e a marca estavam ao
        // contrário — `ISNULL(@novo, coluna)` — e o master escrevia por cima do
        // que tivesse sido corrigido no ecrã. Não voltes a inverter a ordem
        // destes argumentos a pensar que é indiferente: não é, é a política.
        .query(`UPDATE dbo.radios SET
                  alias_tei     = ISNULL(alias_tei, @alias),
                  tie           = ISNULL(tie, @tie),
                  radio_id_tei  = ISNULL(radio_id_tei, @issi),
                  marca         = ISNULL(marca, @marca),
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

/**
 * O rádio desse indicativo — do master; se não existir, cria ficha mínima com
 * a proveniência marcada em `obs`, para não se confundir com o que veio do
 * master. Partilhada pelo `atribuidos.xlsx` e pelo `avarias.csv`: as duas
 * fontes referem rádios pelo indicativo, e as duas podem apanhar um que o
 * master ainda não conhece.
 */
async function radioDoIndicativo(pool, indicativo, origem) {
  const achado = await pool.request().input('i', sql.NVarChar(20), indicativo)
    .query('SELECT TOP 1 id FROM dbo.radios WHERE indicativo = @i');
  if (achado.recordset.length) return { id: achado.recordset[0].id, criado: false };

  const criado = await pool.request()
    .input('ind', sql.NVarChar(20), indicativo)
    .input('obs', sql.NVarChar(sql.MAX), `Só consta no ${origem}; sem ficha no master.`)
    .query(`INSERT INTO dbo.radios (indicativo, obs) OUTPUT INSERTED.id VALUES (@ind, @obs)`);
  return { id: criado.recordset[0].id, criado: true };
}

// ─── Atribuídos: quem tem o quê ────────────────────────────

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
    const { id, criado } = await radioDoIndicativo(pool, ind, 'atribuidos.xlsx');
    if (criado) resumo.atribuidos.radios_criados++;
    if (vistos.has(id)) continue;
    vistos.add(id);
    idsAlvo.push(id);
  }
  if (!idsAlvo.length) { resumo.atribuidos.sem_radio++; return; }

  // A BASE MANDA (2026-09-07). Antes, esta função fechava as entregas abertas
  // desta pessoa que o ficheiro já não mencionava — o `atribuidos.xlsx` era o
  // "quem tem o quê agora". Deixou de ser: quem tem o quê decide-se no ecrã, e
  // uma devolução por engano no ficheiro não pode fechar uma entrega real.
  // A importação passa a abrir entregas **só para rádios que a base tem por
  // entregar**; o resto fica como está e a discordância vai para o resumo.
  for (const radioId of idsAlvo) {
    const aberta = await pool.request().input('rid', sql.Int, radioId)
      .query(`SELECT TOP 1 matricula, nome_utilizador FROM dbo.radios_atribuicoes
              WHERE radio_id = @rid AND data_devolucao IS NULL`);

    if (aberta.recordset.length) {
      const naBase = aberta.recordset[0];
      if (naBase.matricula !== pessoa.matricula) {
        resumo.divergencias.push({
          chave: `rádio #${radioId}`,
          campo: 'entregue a',
          base: `${naBase.nome_utilizador || '?'} · ${naBase.matricula || '—'}`,
          ficheiro: `${pessoa.nome || '?'} · ${pessoa.matricula || '—'}`,
        });
      }
      resumo.atribuidos.entregas_ignoradas++;
      continue;
    }

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

// ─── Avarias: quem está à espera de reparação ──────────────

/**
 * Um `;`-CSV lido à mão, sem biblioteca — o ficheiro é pequeno (dezenas de
 * linhas) e não tem valores com `;` ou `"` lá dentro; trazer uma dependência
 * para isto era mais código do que o problema.
 */
function lerCSV(caminho) {
  let texto = fs.readFileSync(caminho, 'utf8');
  if (texto.charCodeAt(0) === 0xFEFF) texto = texto.slice(1); // BOM
  const linhas = texto.split(/\r?\n/).filter(l => l.trim() !== '');
  const cabecalho = linhas[0].split(';').map(c => c.trim());
  return linhas.slice(1).map(l => {
    const valores = l.split(';');
    const linha = {};
    cabecalho.forEach((c, i) => { linha[c] = (valores[i] || '').trim() || null; });
    return linha;
  });
}

/**
 * `avarias.csv` → `radios_avarias`, com a mesma filosofia de sincronização das
 * entregas: o ficheiro é o estado actual, não um diário. Um rádio com avaria
 * aberta DAQUI que já não aparece no ficheiro foi reparado — fecha-se sozinho.
 *
 * ⚠️ Só mexe nas avarias que ELA PRÓPRIA abriu (`registado_por = 'importação'`
 * — ver `PROVENIENCIA`). Uma avaria que alguém registe pelo ecrã não tem essa
 * marca e este importador nunca lhe toca, nem para a fechar nem para a repetir.
 * Sem essa distinção, uma corrida fechava avarias reais só por não constarem
 * desta lista, que é sobre um sítio de reparação só (RSB), não sobre o parque
 * inteiro.
 *
 * Um rádio só tem UMA avaria "desta fonte" aberta de cada vez: se a linha
 * mudar de descrição entre duas versões do ficheiro (o mesmo rádio, problema
 * diferente), actualiza-se a avaria existente em vez de abrir uma segunda —
 * ao contrário das entregas, aqui não há um "caso composto" a prever.
 */
const PROVENIENCIA = 'importação';

async function importarAvariasCSV(pool, resumo) {
  if (!fs.existsSync(AVARIAS_CSV)) {
    console.warn(`  ⚠ ${AVARIAS_CSV} não encontrado — avarias ficam como estavam`);
    return;
  }
  const linhas = lerCSV(AVARIAS_CSV)
    .filter(l => l['Rádio'])
    .map(l => ({
      indicativo: l['Rádio'],
      tipo_avaria: l['Avaria'],
      ordem: /prog/i.test(l['Avaria'] || '') ? 'P' : '*',
      localizacao: l['Obs'],
    }));
  resumo.avarias_csv.lidas = linhas.length;

  // O alvo: um indicativo pode repetir-se no ficheiro (o mesmo rádio avariou
  // outra vez antes de se fechar a linha anterior) — fica só a última.
  const porIndicativo = new Map();
  for (const l of linhas) porIndicativo.set(l.indicativo, l);

  const idsAlvo = new Set();
  for (const l of porIndicativo.values()) {
    const { id, criado } = await radioDoIndicativo(pool, l.indicativo, 'avarias.csv');
    if (criado) resumo.avarias_csv.radios_criados++;
    idsAlvo.add(id);

    const abertaDaqui = await pool.request().input('rid', sql.Int, id).input('prov', sql.NVarChar(120), PROVENIENCIA)
      .query(`SELECT TOP 1 id, tipo_avaria, ordem, localizacao FROM dbo.radios_avarias
              WHERE radio_id = @rid AND estado = 'aberta' AND registado_por = @prov`);
    const existente = abertaDaqui.recordset[0];

    if (!existente) {
      await pool.request()
        .input('rid', sql.Int, id)
        .input('tipo', sql.NVarChar(120), l.tipo_avaria)
        .input('ordem', sql.VarChar(10), l.ordem)
        .input('local', sql.NVarChar(60), l.localizacao)
        .input('prov', sql.NVarChar(120), PROVENIENCIA)
        .query(`INSERT INTO dbo.radios_avarias (radio_id, tipo_avaria, ordem, localizacao, estado, registado_por)
                VALUES (@rid, @tipo, @ordem, @local, 'aberta', @prov)`);
      resumo.avarias_csv.abertas++;
    } else if (existente.tipo_avaria !== l.tipo_avaria || existente.ordem !== l.ordem || existente.localizacao !== l.localizacao) {
      await pool.request()
        .input('id', sql.Int, existente.id)
        .input('tipo', sql.NVarChar(120), l.tipo_avaria)
        .input('ordem', sql.VarChar(10), l.ordem)
        .input('local', sql.NVarChar(60), l.localizacao)
        .query('UPDATE dbo.radios_avarias SET tipo_avaria = @tipo, ordem = @ordem, localizacao = @local WHERE id = @id');
      resumo.avarias_csv.actualizadas++;
    }
  }

  // O que a fonte tinha aberto e já não está na lista foi reparado.
  const abertasAntes = await pool.request().input('prov', sql.NVarChar(120), PROVENIENCIA)
    .query(`SELECT id, radio_id FROM dbo.radios_avarias WHERE estado = 'aberta' AND registado_por = @prov`);
  for (const a of abertasAntes.recordset) {
    if (idsAlvo.has(a.radio_id)) continue;
    await pool.request().input('id', sql.Int, a.id)
      .query(`UPDATE dbo.radios_avarias SET estado = 'reparada', data_reparacao = GETDATE() WHERE id = @id`);
    resumo.avarias_csv.reparadas++;
  }
}

// ─── Orquestração ──────────────────────────────────────────

async function principal() {
  const pool = await poolPromise;
  if (!pool) throw new Error('Sem ligação à base de dados — ver o .env.');

  const resumo = {
    master: { lidas: 0, criados: 0, actualizados: 0 },
    atribuidos: { lidas: 0, duplicadas: 0, em_conflito: 0, sem_radio: 0, radios_criados: 0, atribuicoes: 0, entregas_ignoradas: 0 },
    avarias_csv: { lidas: 0, radios_criados: 0, abertas: 0, actualizadas: 0, reparadas: 0 },
    divergencias: [],   // onde as folhas discordam da base — não gravado
  };

  process.stdout.write('  master radios.xlsx… ');
  await importarMaster(pool, resumo);
  console.log('ok');

  process.stdout.write('  atribuidos.xlsx… ');
  await importarAtribuicoes(pool, resumo);
  console.log('ok');

  process.stdout.write('  avarias.csv… ');
  await importarAvariasCSV(pool, resumo);
  console.log('ok');

  // O estado é coluna e não consulta (ver a migração 001); recalcula-se sempre
  // no fim, a partir dos factos. Não há fonte de abates nestas três fontes —
  // mas corre na mesma, para não ficar desalinhado com abates que o ecrã já
  // tenha registado.
  await pool.request().query(`
    UPDATE dbo.radios
    SET estado = CASE
          WHEN EXISTS (SELECT 1 FROM dbo.radios_abates  a WHERE a.radio_id = radios.id) THEN 'abatido'
          WHEN EXISTS (SELECT 1 FROM dbo.radios_avarias v WHERE v.radio_id = radios.id AND v.estado = 'aberta') THEN 'avariado'
          WHEN EXISTS (SELECT 1 FROM dbo.radios_atribuicoes t WHERE t.radio_id = radios.id AND t.data_devolucao IS NULL) THEN 'atribuido'
          ELSE 'disponivel' END,
        atualizado_em = GETDATE()`);

  // A corrida fica registada, como nos outros três importadores. A tabela existe
  // desde a migração 001 e o `/estatisticas` já a lia — só ninguém lá escrevia,
  // e por isso `ultima_importacao` era null nos rádios e só nos rádios. São três
  // ficheiros e a coluna é uma: vão os três nomes, que é o que se quer ler no
  // dia em que se for perceber donde saiu uma linha.
  await pool.request()
    .input('f', sql.NVarChar(400), [MASTER, ATRIBUIDOS, AVARIAS_CSV].map(f => path.basename(f)).join(' + '))
    .input('r', sql.NVarChar(sql.MAX), JSON.stringify(resumo))
    .input('por', sql.NVarChar(120), process.env.USERNAME || 'desconhecido')
    .query('INSERT INTO dbo.radios_importacoes (ficheiro, resumo, executado_por) VALUES (@f, @r, @por)');

  const contagens = await pool.request().query(
    'SELECT estado, COUNT(*) AS total FROM dbo.radios GROUP BY estado ORDER BY estado');

  // No ecrã vai a contagem; a lista inteira é longa de mais para o terminal
  // quando as folhas se afastam da base.
  console.log('\nResumo da importação:');
  console.log(JSON.stringify({ ...resumo, divergencias: resumo.divergencias.length }, null, 2));

  mostrarDivergencias(resumo.divergencias);

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
