'use strict';

/**
 * Importador do `Livro 1.xlsx` dos telemóveis → base de dados.
 *
 *   npm run importar-telemoveis
 *   npm run importar-telemoveis -- "C:\caminho\Livro 1.xlsx"
 *   npm run importar-telemoveis -- --limpar
 *
 * Corre as vezes que forem precisas: os aparelhos são procurados pelo número do
 * cartão e, na falta dele, pelo IMEI — não duplica o que já lá está.
 *
 * ⚠️ **A BASE MANDA** (decisão de 2026-09-07, ver `_sincronizacao.js`). Um campo
 * com valor na base não é tocado — credenciais incluídas —; só se preenchem os
 * vazios, e as linhas novas entram por inteiro. Um aparelho que a base tenha
 * entregue a alguém **não muda de mãos pela importação**. O que a folha diz de
 * diferente aparece no resumo, sem ser gravado.
 *
 * ⚠️ **O `--limpar` é a excepção, e apaga tudo.** Continua a existir para quando
 * se quer recomeçar do ficheiro de propósito, mas contraria a regra acima: apaga
 * os 300 aparelhos e com eles as entregas, avarias e abates. Não é para uma
 * corrida de rotina.
 *
 * ⚠️ O que este importador NÃO faz, de propósito:
 *
 *  - **Não completa os PIN nem os PUK.** Na folha são numéricos, portanto o
 *    Excel comeu os zeros à esquerda ("0020" está lá como 20). Guarda-se o que
 *    lá está: um PIN adivinhado tranca o cartão e ao fim de dez tentativas o PUK
 *    também. O ecrã assinala os que têm menos de 4 dígitos.
 *  - **Não completa os IMEI.** A folha só tem os últimos dígitos de cada um.
 *  - **Não limpa a coluna 'Entregue'.** Treze linhas têm lá "ABATE 2023" em vez
 *    de um nome. Essas não geram atribuição — geram abate, e a frase fica como
 *    motivo, à vista.
 *
 * O estado sai de texto livre espalhado por quatro colunas ('Entregue', a
 * segunda 'Data', 'Localização' e 'OBS.'). É leitura por palavras — ver
 * `classificar()` — e o texto original fica sempre guardado em `obs`, para a
 * decisão do importador poder ser conferida e corrigida no ecrã.
 */

require('dotenv').config();

const fs = require('fs');
const ExcelJS = require('exceljs');
// Base própria dos telemóveis — ver `db-telemoveis.js` e a migração 002.
const { poolPromise, sql } = require('../db-telemoveis');
// A regra é a mesma nos quatro importadores: a base manda. Ver o ficheiro.
const { preencherBuracos, divergencias, mostrarDivergencias } = require('./_sincronizacao');

const CAMINHO_OMISSAO = 'C:\\Apps\\telemoveis\\Livro 1.xlsx';
const LIMPAR = process.argv.includes('--limpar');
const CAMINHO_ARG = process.argv.slice(2).find(a => !a.startsWith('--'));

// ─── Leitura de células ────────────────────────────────────

/**
 * Texto de uma célula, ou null.
 *
 * ⚠️ O espaço duro (`\u00a0`) conta como vazio: a folha tem 299 células com um
 * NBSP sozinho — o que sobra de alguém ter limpado a coluna carregando em espaço.
 * Sem isto, 29 matrículas "  " passavam por preenchidas.
 */
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
  const n = Number(s.replace(/[^\d-]/g, ''));
  return Number.isFinite(n) && s.replace(/[^\d-]/g, '') !== '' ? Math.trunc(n) : null;
}

/**
 * Data em ISO, ou null. Aceita o que a folha tem: datas a sério, "30/09/2020",
 * "18-09-2024", ISO — e o número de série do Excel (43840), que aparece nas
 * células onde alguém colou uma data por cima de uma coluna de texto.
 */
function dataISO(valor) {
  if (valor === null || valor === undefined) return null;
  if (valor instanceof Date) return valor.toISOString().slice(0, 10);
  const s = String(valor).trim();
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(s);
  if (m) {
    const dia = Number(m[1]), mes = Number(m[2]);
    if (dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12) {
      return `${m[3]}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
    }
  }
  // Série do Excel: dias desde 1899-12-30. O intervalo aceite vai de 2000 a 2050
  // — fora dele o número é outra coisa qualquer (uma matrícula, um PUK).
  const n = Number(s);
  if (Number.isFinite(n) && n >= 36526 && n <= 54789) {
    return new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);
  }
  return null;
}

/** A data de uma célula, seja ela data, texto ou série. */
function dataDaCelula(cell) {
  if (!cell) return null;
  const v = cell.value;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return dataISO(texto(cell));
}

// ─── Classificação do estado ───────────────────────────────

/** Sem acentos e em minúsculas, para as palavras baterem certo. */
function chave(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

const PALAVRAS_ABATE = /\babat/;                       // abate, abatido, abatida, p/ abater
const PALAVRAS_AVARIA = /avaria|avariad|ecra|ecran|danificad|\binop\b|extravia|partid|nao responde|touch|toutch/;

/**
 * Lê as frases soltas da linha e diz o que fazer com o aparelho.
 *
 * Devolve { motivoAbate, descricaoAvaria, usadas }. É de propósito que o abate
 * ganha à avaria: "abate camera partida" tem as duas palavras e é um abate, não
 * uma avaria por reparar.
 *
 * As frases que falam da avaria ou do abate **vão todas para o motivo**, unidas
 * por ' · ', e ficam marcadas em `usadas` para NÃO se repetirem nas observações
 * do aparelho. Antes apareciam nos dois sítios, e a ficha mostrava a mesma frase
 * duas vezes — uma como nota, outra como avaria.
 */
function classificar(frases) {
  const doAbate = [];
  const daAvaria = [];
  const usadas = new Set();
  for (const f of frases) {
    if (!f) continue;
    const k = chave(f);
    if (PALAVRAS_ABATE.test(k)) { doAbate.push(f); usadas.add(f); continue; }
    if (PALAVRAS_AVARIA.test(k)) { daAvaria.push(f); usadas.add(f); }
  }
  // Sem repetidas: há linhas com a MESMA frase em três colunas ("Entregue ao
  // NSIC… devido a avaria" está na localização, nas observações e na coluna
  // solta), e juntá-las dava um motivo com a frase três vezes, cortado aos 200
  // caracteres a meio da terceira.
  const juntar = lista => {
    const vistas = new Set();
    const unicas = [];
    for (const f of lista) {
      const k = chave(f);
      if (vistas.has(k)) continue;
      vistas.add(k);
      unicas.push(f);
    }
    return unicas.length ? unicas.join(' · ').slice(0, 200) : null;
  };
  return { motivoAbate: juntar(doAbate), descricaoAvaria: juntar(daAvaria), usadas };
}

/** A 'Localização' tanto traz o serviço ("NSIC", "Com. ET") como uma queixa. */
function pareceServico(v) {
  if (!v) return false;
  const k = chave(v);
  return !PALAVRAS_ABATE.test(k) && !PALAVRAS_AVARIA.test(k) && !/^\d/.test(k) && v.length <= 40;
}

// ─── Importação ────────────────────────────────────────────

async function principal() {
  const ficheiro = CAMINHO_ARG || process.env.XLSX_TELEMOVEIS || CAMINHO_OMISSAO;
  if (!fs.existsSync(ficheiro)) throw new Error(`Ficheiro não encontrado: ${ficheiro}`);
  console.log(`A ler ${ficheiro}`);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(ficheiro);
  const ws = wb.worksheets[0];

  const pool = await poolPromise;
  if (!pool) throw new Error('Sem ligação à base de dados — ver o .env.');

  if (LIMPAR) {
    // Atribuições, avarias e abates caem com o aparelho (ON DELETE CASCADE).
    await pool.request().query('DELETE FROM dbo.telemoveis');
    console.log('  (aparelhos apagados antes de importar — --limpar)');
  }

  const resumo = {
    lidas: 0, criados: 0, atualizados: 0, duplicadas_na_folha: 0,
    atribuicoes: 0, avarias: 0, abates: 0, vazias: 0, sem_numero: 0,
    entregas_ignoradas: 0,   // aparelhos que a base já tem entregues a alguém
    divergencias: [],        // onde a folha discorda da base — não gravado
  };

  // Uma linha que casa com um aparelho criado NESTA corrida é uma linha repetida
  // na folha, não uma actualização — a folha tem a linha 124 outra vez na 125,
  // com tudo igual até ao PIN. Sem esta distinção o resumo dizia "atualizados: 1"
  // e ninguém percebia que o ficheiro traz 301 linhas para 300 aparelhos.
  const criadosNestaCorrida = new Set();

  for (let i = 2; i <= ws.rowCount; i++) {
    const r = ws.getRow(i);

    const numero = texto(r.getCell(6), 20);
    const imei1 = texto(r.getCell(4), 30);
    const imei2 = texto(r.getCell(5), 30);
    const utilizador = texto(r.getCell(9), 60);
    if (!numero && !imei1 && !utilizador) { resumo.vazias++; continue; }
    if (!numero) resumo.sem_numero++;

    const entregue = texto(r.getCell(11), 200);
    const matricula = inteiro(r.getCell(12));
    const dataEntrega = dataDaCelula(r.getCell(13)) || dataDaCelula(r.getCell(14));
    const data2Texto = texto(r.getCell(14));
    const localizacao = texto(r.getCell(15), 120);
    const observacoes = texto(r.getCell(16));
    const extra = texto(r.getCell(17));
    const avariasCol = texto(r.getCell(18), 200);

    const { motivoAbate, descricaoAvaria, usadas } =
      classificar([entregue, data2Texto, localizacao, observacoes, avariasCol, extra]);

    // O que sobra depois de a avaria e o abate levarem o que é deles, com a
    // coluna de onde veio. Uma frase que já é o motivo da avaria não se repete
    // aqui: no ecrã apareceria duas vezes na mesma ficha.
    const sobra = v => (v && !usadas.has(v) ? v : null);
    const notas = [
      sobra(data2Texto) && !dataISO(data2Texto) ? `Data: ${data2Texto}` : null,
      sobra(localizacao) && !pareceServico(localizacao) ? `Localização: ${localizacao}` : null,
      sobra(observacoes) ? `Obs: ${observacoes}` : null,
      sobra(avariasCol) ? `Avarias: ${avariasCol}` : null,
      sobra(extra) ? `Inf: ${extra}` : null,
    ].filter(Boolean).join(' · ') || null;

    // Encontrar ou criar o aparelho. Traz-se a linha inteira, não só o id: é com
    // ela que se vê onde é que a folha discorda da base.
    let linha = null;
    for (const [col, val] of [['numero', numero], ['imei1', imei1]]) {
      if (!val || linha) continue;
      const achado = await pool.request().input('v', sql.NVarChar(30), val)
        .query(`SELECT TOP 1 * FROM dbo.telemoveis WHERE ${col} = @v`);
      if (achado.recordset.length) linha = achado.recordset[0];
    }
    let id = linha ? linha.id : null;

    const campos = {
      numero, imei1, imei2,
      marca: texto(r.getCell(2), 40),
      modelo: texto(r.getCell(3), 80),
      pin: texto(r.getCell(7), 20),
      puk: texto(r.getCell(8), 20),
      utilizador,
      palavra_passe: texto(r.getCell(10), 60),
      localizacao: pareceServico(localizacao) ? localizacao : null,
      marcador: texto(r.getCell(1), 10),
      obs: notas,
    };

    if (id) {
      // A BASE MANDA: só se preenchem os campos vazios na base. O que a folha
      // diz de diferente não se grava — vai para o resumo, à vista.
      // ⚠️ As credenciais entram nesta regra como tudo o resto: um PIN corrigido
      // no ecrã não é desfeito pelo que a folha ainda tem.
      for (const d of divergencias(linha, campos)) {
        resumo.divergencias.push({ chave: numero || imei1, ...d });
      }

      const p = pool.request().input('id', sql.Int, id);
      const colunas = [];
      for (const [c, v] of Object.entries(campos)) {
        if (v === null) continue;
        p.input(c, sql.NVarChar(200), v);
        colunas.push(c);
      }
      if (colunas.length) {
        await p.query(`UPDATE dbo.telemoveis SET ${preencherBuracos(colunas).join(', ')},
                       atualizado_em = GETDATE() WHERE id = @id`);
      }
      if (criadosNestaCorrida.has(id)) resumo.duplicadas_na_folha++;
      else resumo.atualizados++;
    } else {
      const ins = await pool.request()
        .input('numero', sql.NVarChar(20), numero)
        .input('imei1', sql.NVarChar(30), imei1)
        .input('imei2', sql.NVarChar(30), imei2)
        .input('marca', sql.NVarChar(40), campos.marca)
        .input('modelo', sql.NVarChar(80), campos.modelo)
        .input('pin', sql.NVarChar(20), campos.pin)
        .input('puk', sql.NVarChar(20), campos.puk)
        .input('utilizador', sql.NVarChar(60), campos.utilizador)
        .input('palavra_passe', sql.NVarChar(60), campos.palavra_passe)
        .input('localizacao', sql.NVarChar(120), campos.localizacao)
        .input('marcador', sql.NVarChar(10), campos.marcador)
        .input('obs', sql.NVarChar(sql.MAX), campos.obs)
        .query(`INSERT INTO dbo.telemoveis
                  (numero, imei1, imei2, marca, modelo, pin, puk, utilizador, palavra_passe, localizacao, marcador, obs)
                OUTPUT INSERTED.id
                VALUES (@numero, @imei1, @imei2, @marca, @modelo, @pin, @puk, @utilizador, @palavra_passe, @localizacao, @marcador, @obs)`);
      id = ins.recordset[0].id;
      criadosNestaCorrida.add(id);
      resumo.criados++;
    }
    resumo.lidas++;

    // Atribuição: só quando 'Entregue' traz mesmo um nome — e **só quando a base
    // tem o aparelho por entregar**. Um telemóvel que a base já dê a alguém não
    // muda de mãos pela importação, nem que a folha diga outro nome: quem tem o
    // quê decide-se no ecrã, e a folha a discordar aparece no resumo.
    const temNome = entregue && !PALAVRAS_ABATE.test(chave(entregue));
    if (temNome) {
      const aberta = await pool.request().input('tid', sql.Int, id)
        .query(`SELECT TOP 1 nome_utilizador, matricula FROM dbo.telemoveis_atribuicoes
                WHERE telemovel_id = @tid AND data_devolucao IS NULL`);
      if (aberta.recordset.length) {
        const naBase = aberta.recordset[0];
        if (String(naBase.nome_utilizador || '').trim() !== String(entregue).trim()) {
          resumo.divergencias.push({
            chave: numero || imei1,
            campo: 'entregue a',
            base: `${naBase.nome_utilizador || '?'} · ${naBase.matricula || '—'}`,
            ficheiro: `${entregue} · ${matricula || '—'}`,
          });
        }
        resumo.entregas_ignoradas++;
      } else {
        await pool.request()
          .input('tid', sql.Int, id)
          .input('mec', sql.Int, matricula)
          .input('nome', sql.NVarChar(200), entregue)
          .input('entrega', sql.Date, dataEntrega)
          .query(`INSERT INTO dbo.telemoveis_atribuicoes (telemovel_id, matricula, nome_utilizador, data_entrega, registado_por)
                  VALUES (@tid, @mec, @nome, @entrega, N'importação')`);
        resumo.atribuicoes++;
      }
    }

    if (descricaoAvaria && !motivoAbate) {
      const ja = await pool.request().input('tid', sql.Int, id)
        .query(`SELECT TOP 1 id FROM dbo.telemoveis_avarias WHERE telemovel_id = @tid AND estado = 'aberta'`);
      if (!ja.recordset.length) {
        await pool.request()
          .input('tid', sql.Int, id)
          .input('desc', sql.NVarChar(200), descricaoAvaria)
          .input('dt', sql.Date, dataISO(descricaoAvaria))
          .query(`INSERT INTO dbo.telemoveis_avarias (telemovel_id, descricao, data_registo, registado_por)
                  VALUES (@tid, @desc, @dt, N'importação')`);
        resumo.avarias++;
      }
    }

    if (motivoAbate) {
      const ja = await pool.request().input('tid', sql.Int, id)
        .query('SELECT TOP 1 id FROM dbo.telemoveis_abates WHERE telemovel_id = @tid');
      if (!ja.recordset.length) {
        await pool.request()
          .input('tid', sql.Int, id)
          .input('motivo', sql.NVarChar(200), motivoAbate)
          .input('dt', sql.Date, dataISO(motivoAbate))
          .query(`INSERT INTO dbo.telemoveis_abates (telemovel_id, motivo, data_abate, registado_por)
                  VALUES (@tid, @motivo, @dt, N'importação')`);
        resumo.abates++;
      }
    }
  }

  // Mesma regra e mesma precedência do módulo dos rádios.
  await pool.request().query(`
    UPDATE dbo.telemoveis
    SET estado = CASE
          WHEN EXISTS (SELECT 1 FROM dbo.telemoveis_abates  a WHERE a.telemovel_id = telemoveis.id) THEN 'abatido'
          WHEN EXISTS (SELECT 1 FROM dbo.telemoveis_avarias v WHERE v.telemovel_id = telemoveis.id AND v.estado = 'aberta') THEN 'avariado'
          WHEN EXISTS (SELECT 1 FROM dbo.telemoveis_atribuicoes t WHERE t.telemovel_id = telemoveis.id AND t.data_devolucao IS NULL) THEN 'atribuido'
          ELSE 'disponivel' END,
        atualizado_em = GETDATE()`);

  await pool.request()
    .input('f', sql.NVarChar(400), ficheiro)
    .input('r', sql.NVarChar(sql.MAX), JSON.stringify(resumo))
    .input('por', sql.NVarChar(120), process.env.USERNAME || 'desconhecido')
    .query('INSERT INTO dbo.telemoveis_importacoes (ficheiro, resumo, executado_por) VALUES (@f, @r, @por)');

  const contagens = await pool.request().query(
    'SELECT estado, COUNT(*) AS total FROM dbo.telemoveis GROUP BY estado ORDER BY estado');

  // No ecrã vai a contagem; a lista inteira fica no `resumo` gravado na tabela
  // das importações, que é onde se vai ver o que discordava naquele dia.
  console.log('\nResumo da importação:');
  console.log(JSON.stringify({ ...resumo, divergencias: resumo.divergencias.length }, null, 2));

  mostrarDivergencias(resumo.divergencias);

  console.log('\nTelemóveis por estado:');
  for (const l of contagens.recordset) console.log(`  ${l.estado.padEnd(12)} ${l.total}`);
}

principal()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('\nImportação falhou:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
