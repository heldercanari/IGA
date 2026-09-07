'use strict';

/**
 * Importador da folha `Kodak PIXPRO` → base de dados.
 *
 *   npm run importar-maquinas
 *   npm run importar-maquinas -- "C:\caminho\outro.xlsx"
 *
 * ⚠️ **O ficheiro tem 27 folhas e só uma interessa.** O `Kodak.xlsx` é o livro
 * geral do NSIC — impressoras, telemóveis, tablets, portáteis, GPS, cofres. Este
 * importador lê a folha `Kodak PIXPRO` **pelo nome**, nunca "a primeira folha":
 * a primeira é a das impressoras Lexmark, e lê-la aqui dava quinze máquinas
 * fotográficas com número de toner. Se a folha for renomeada, o script pára com
 * a lista das que existem em vez de importar a errada.
 *
 * Corre as vezes que forem precisas: a máquina é procurada pelo ID-PM e, na
 * falta dele, pelo número de série. **Não tem `--limpar`**, como o dos rádios e
 * o das impressoras: sincroniza em vez de destruir.
 *
 * **Uniformiza a capacidade** para a forma correcta — `32Gb`, `32GB` e `32 Gb`
 * entram todos como `32 GB`. A folha escreve-a das três maneiras; a base guarda
 * uma, com o `B` de *byte* em maiúscula (o `b` minúsculo é *bit*, e um cartão de
 * "32 Gb" à letra tinha 4 GB) e o espaço que separa o número da unidade. Ver
 * `normalizarCapacidade()`.
 *
 * ⚠️ O que este importador NÃO faz, de propósito:
 *
 *  - **Não inventa datas de entrega.** Dos quatro levantamentos da folha só um
 *    tem data; os outros entram com `data_entrega` a NULL. Ao contrário do
 *    `atribuidos.xlsx` dos rádios, aqui não há sequer um dia de apuramento comum
 *    a que se possa chamar a data.
 *  - **Não arruma a marca.** A coluna diz "Kodak W" e "Kodak R"; o W e o R
 *    distinguem alguma coisa que a folha não explica, e parti-los em marca mais
 *    atributo era inventar o significado de uma letra.
 *  - **Não resolve o username para nome.** A coluna "Levantou" traz
 *    `claudino.antunes`, com a matrícula ao lado; fica como está, e quem quiser
 *    o nome a sério escreve-o pelo ecrã, que tem o autocompletar.
 */

require('dotenv').config();

const fs = require('fs');
const ExcelJS = require('exceljs');
// Base do módulo — a mesma dos rádios e das impressoras. Ver a migração 004.
const { poolPromise, sql } = require('../db');

const CAMINHO_OMISSAO = 'C:\\Apps\\Kodak.xlsx';
const CAMINHO_ARG = process.argv.slice(2).find(a => !a.startsWith('--'));
const FOLHA = process.env.FOLHA_MAQUINAS || 'Kodak PIXPRO';

/**
 * As colunas da folha, por ordem. O cabeçalho está na **linha 2**, não na 1: a
 * 1 é o título "KODAK PIXPRO WPZ2 - 32Gb", esticado por A1:F1. Os dados começam
 * na 3.
 *
 * "Levantou" ocupa duas colunas debaixo de uma célula juntada (G2:H2): o
 * username numa, a matrícula na outra.
 */
const PRIMEIRA_LINHA = 3;
const COLUNAS = {
  pm_id: 1,              // PM-ID        '01 PM'
  marca: 2,              // Marca        'Kodak W' / 'Kodak R'
  modelo: 3,             // Modelo       'PIXPRO WPZ2'
  num_serie: 4,          // N/série      'M061640752'
  cartao_marca: 5,       // Cartão Memoria
  cartao_capacidade: 6,  // Capacidade
  levantou: 7,           // Levantou     username
  matricula: 8,          // Levantou     matrícula
  data: 9,               // Data
};

// ─── Leitura de células ────────────────────────────────────

/** Texto de uma célula, ou null. O espaço duro conta como vazio. */
function texto(cell, max) {
  if (!cell) return null;
  let v = cell.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && !(v instanceof Date)) {
    if (Array.isArray(v.richText)) v = v.richText.map(t => t.text).join('');
    else if (v.text !== undefined) v = v.text;
    else if (v.result !== undefined) v = v.result;
    else return null;
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).replace(/\u00a0/g, ' ').trim();
  if (s === '' || s === '#') return null;
  return max ? s.slice(0, max) : s;
}

function inteiro(cell) {
  const s = texto(cell);
  if (s === null) return null;
  const so = s.replace(/[^\d-]/g, '');
  if (so === '') return null;
  const n = Number(so);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * A capacidade na forma correcta: `32Gb`, `32GB` e `32 Gb` → `32 GB`.
 *
 * `B` maiúsculo porque `B` é *byte* e `b` é *bit*, e espaço entre o número e a
 * unidade, como se escreve uma grandeza. **O número não se toca**, nem a vírgula
 * decimal, e **só se mexe no que se reconhece**: um valor que não seja um número
 * seguido de KB/MB/GB/TB passa intacto.
 *
 * Cópia da função com o mesmo nome em `server/routes/iga/maquinas.js`, para o
 * que vem da folha e o que se escreve no ecrã ficarem iguais — a mesma
 * duplicação conhecida do `normalizarIP()` das impressoras. Se mexeres numa,
 * mexe na outra.
 */
function normalizarCapacidade(v) {
  if (!v) return v;
  const s = String(v).trim();
  const m = /^(\d+(?:[.,]\d+)?)\s*([kmgt])b$/i.exec(s);
  return m ? `${m[1]} ${m[2].toUpperCase()}B` : s;
}

/** A data de uma célula em ISO, ou null. Aceita data a sério, dd/mm/aaaa e ISO. */
function dataDaCelula(cell) {
  if (!cell) return null;
  const v = cell.value;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = texto(cell);
  if (s === null) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  return null;
}

// ─── Importação ────────────────────────────────────────────

async function principal() {
  const ficheiro = CAMINHO_ARG || process.env.XLSX_MAQUINAS || CAMINHO_OMISSAO;
  if (!fs.existsSync(ficheiro)) throw new Error(`Ficheiro não encontrado: ${ficheiro}`);
  console.log(`A ler ${ficheiro}, folha "${FOLHA}"`);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(ficheiro);

  const ws = wb.getWorksheet(FOLHA);
  if (!ws) {
    const nomes = wb.worksheets.map(w => `"${w.name}"`).join(', ');
    throw new Error(`A folha "${FOLHA}" não existe neste ficheiro. Folhas: ${nomes}`);
  }

  const pool = await poolPromise;
  if (!pool) throw new Error('Sem ligação à base de dados — ver o .env.');

  const resumo = {
    lidas: 0,
    criadas: 0,
    atualizadas: 0,
    duplicadas_na_folha: 0,
    entregas: 0,
    entregas_sem_data: 0,
    sem_serie: 0,
    vazias: 0,
    capacidades_arrumadas: 0,   // linhas cuja capacidade a folha escrevia de outra maneira
  };

  const criadasNestaCorrida = new Set();

  for (let i = PRIMEIRA_LINHA; i <= ws.rowCount; i++) {
    const r = ws.getRow(i);

    const capacidadeCrua = texto(r.getCell(COLUNAS.cartao_capacidade), 20);
    const campos = {
      pm_id: texto(r.getCell(COLUNAS.pm_id), 20),
      marca: texto(r.getCell(COLUNAS.marca), 40),
      modelo: texto(r.getCell(COLUNAS.modelo), 80),
      num_serie: texto(r.getCell(COLUNAS.num_serie), 40),
      cartao_marca: texto(r.getCell(COLUNAS.cartao_marca), 40),
      cartao_capacidade: normalizarCapacidade(capacidadeCrua),
    };

    if (!campos.pm_id && !campos.num_serie) { resumo.vazias++; continue; }
    if (!campos.num_serie) resumo.sem_serie++;
    if (capacidadeCrua && campos.cartao_capacidade !== capacidadeCrua) resumo.capacidades_arrumadas++;

    const levantou = texto(r.getCell(COLUNAS.levantou), 200);
    const matricula = inteiro(r.getCell(COLUNAS.matricula));
    const dataEntrega = dataDaCelula(r.getCell(COLUNAS.data));

    // Encontrar a máquina: primeiro pelo ID-PM (a chapa), depois pela série.
    // Os dois são índices únicos filtrados, portanto no máximo há uma.
    let id = null;
    for (const col of ['pm_id', 'num_serie']) {
      if (!campos[col] || id) continue;
      const achado = await pool.request().input('v', sql.NVarChar(40), campos[col])
        .query(`SELECT TOP 1 id FROM dbo.maquinas WHERE ${col} = @v`);
      if (achado.recordset.length) id = achado.recordset[0].id;
    }

    if (id) {
      // Só os valores que a folha traz: uma célula vazia não apaga o que já lá
      // está, que pode ter sido preenchido pelo ecrã depois desta exportação.
      const p = pool.request().input('id', sql.Int, id);
      const sets = [];
      for (const [c, v] of Object.entries(campos)) {
        if (v === null) continue;
        p.input(c, sql.NVarChar(80), v);
        sets.push(`${c} = @${c}`);
      }
      if (sets.length) {
        await p.query(`UPDATE dbo.maquinas SET ${sets.join(', ')}, atualizado_em = GETDATE() WHERE id = @id`);
      }
      if (criadasNestaCorrida.has(id)) resumo.duplicadas_na_folha++;
      else resumo.atualizadas++;
    } else {
      const ins = await pool.request()
        .input('pm_id', sql.NVarChar(20), campos.pm_id)
        .input('marca', sql.NVarChar(40), campos.marca)
        .input('modelo', sql.NVarChar(80), campos.modelo)
        .input('num_serie', sql.NVarChar(40), campos.num_serie)
        .input('cartao_marca', sql.NVarChar(40), campos.cartao_marca)
        .input('cartao_capacidade', sql.NVarChar(20), campos.cartao_capacidade)
        .query(`INSERT INTO dbo.maquinas (pm_id, marca, modelo, num_serie, cartao_marca, cartao_capacidade)
                OUTPUT INSERTED.id
                VALUES (@pm_id, @marca, @modelo, @num_serie, @cartao_marca, @cartao_capacidade)`);
      id = ins.recordset[0].id;
      criadasNestaCorrida.add(id);
      resumo.criadas++;
    }
    resumo.lidas++;

    // A entrega. Procurada por (máquina, quem), como nos outros importadores:
    // uma segunda corrida reconhece a que já lá está em vez de a repetir.
    if (!levantou && matricula === null) continue;

    const p = pool.request().input('mid', sql.Int, id);
    const condicoes = ['maquina_id = @mid', 'data_devolucao IS NULL'];
    if (matricula !== null) { p.input('mec', sql.Int, matricula); condicoes.push('matricula = @mec'); }
    else { p.input('nome', sql.NVarChar(200), levantou); condicoes.push('nome_utilizador = @nome'); }

    const ja = await p.query(`SELECT TOP 1 id FROM dbo.maquinas_atribuicoes WHERE ${condicoes.join(' AND ')}`);
    if (ja.recordset.length) continue;

    await pool.request()
      .input('mid', sql.Int, id)
      .input('mec', sql.Int, matricula)
      .input('nome', sql.NVarChar(200), levantou)
      .input('entrega', sql.Date, dataEntrega)
      .query(`INSERT INTO dbo.maquinas_atribuicoes (maquina_id, matricula, nome_utilizador, data_entrega, registado_por)
              VALUES (@mid, @mec, @nome, @entrega, N'importação')`);
    resumo.entregas++;
    if (!dataEntrega) resumo.entregas_sem_data++;
  }

  await pool.request()
    .input('f', sql.NVarChar(400), ficheiro)
    .input('folha', sql.NVarChar(120), FOLHA)
    .input('r', sql.NVarChar(sql.MAX), JSON.stringify(resumo))
    .input('por', sql.NVarChar(120), process.env.USERNAME || 'desconhecido')
    .query(`INSERT INTO dbo.maquinas_importacoes (ficheiro, folha, resumo, executado_por)
            VALUES (@f, @folha, @r, @por)`);

  const estado = await pool.request().query(`
    SELECT
      (SELECT COUNT(*) FROM dbo.maquinas) AS total,
      (SELECT COUNT(DISTINCT maquina_id) FROM dbo.maquinas_atribuicoes WHERE data_devolucao IS NULL) AS entregues`);

  console.log('\nResumo da importação:');
  console.log(JSON.stringify(resumo, null, 2));

  if (resumo.entregas_sem_data) {
    console.log(`\n⚠️  ${resumo.entregas_sem_data} levantamento(s) sem data na folha — entraram com a data vazia.`);
    console.log('   A folha só datou um deles; o resto ficou por saber e não se inventa.');
  }

  const { total, entregues } = estado.recordset[0];
  console.log(`\nMáquinas: ${total} · entregues ${entregues} · disponíveis ${total - entregues}`);
}

principal()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('\nImportação falhou:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
