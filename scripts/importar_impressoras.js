'use strict';

/**
 * Importador do `impressoras Konica.xlsx` → base de dados.
 *
 *   npm run importar-impressoras
 *   npm run importar-impressoras -- "C:\caminho\outro.xlsx"
 *
 * Corre as vezes que forem precisas: a máquina é procurada pelo número de série
 * e, na falta dele, pelo host name — não duplica o que já lá está.
 *
 * **Não tem `--limpar`**, como o dos rádios e ao contrário do dos telemóveis.
 * Sincroniza em vez de destruir: uma segunda corrida actualiza o que mudou na
 * folha e acrescenta o que falta, e nunca apaga uma máquina que alguém tenha
 * entretanto criado pelo ecrã. Apagar uma impressora é uma acção da
 * administração, à unidade, com o botão ao lado da linha.
 *
 * **Tira os zeros à esquerda dos IP** (`10.22.129.049` → `10.22.129.49`). A folha
 * escreve-os das duas maneiras e a base guarda-os numa só, que é a que o Windows,
 * o `ping` e o painel da própria impressora mostram — sem isto, a mesma máquina
 * tinha duas escritas possíveis e a procura por "129.49" não encontrava a linha
 * que dizia "129.049". A conversão é do endereço, não do que ele identifica: o
 * `.049` e o `.49` são o mesmo host. Ver `normalizarIP()`.
 *
 * ⚠️ O que este importador NÃO faz, de propósito:
 *
 *  - **Não corrige o host name que não bate certo com o IP.** Em quinze das
 *    dezasseis linhas o host acaba no último octeto do IP; na AADIVPOL o IP diz
 *    `.60` e o host diz `_050`. Os dois entram como estão e a divergência é
 *    contada no resumo — corrigir por dedução era escolher à sorte qual dos dois
 *    valores está certo.
 *  - **Não inventa localizações.** Uma linha sem "Localização Atual" fica sem
 *    morada, à vista no ecrã pelo filtro "sem local".
 */

require('dotenv').config();

const fs = require('fs');
const ExcelJS = require('exceljs');
// Base do módulo — a mesma dos rádios. As impressoras não têm base própria nem
// pool própria; ver a migração 003.
const { poolPromise, sql } = require('../db');

const CAMINHO_OMISSAO = 'C:\\Apps\\impressoras Konica.xlsx';
const CAMINHO_ARG = process.argv.slice(2).find(a => !a.startsWith('--'));

/**
 * As colunas da folha, por ordem. A folha tem cabeçalho na linha 1 e os dados a
 * partir da 2; se um dia a ordem mudar, muda aqui e mais nada.
 */
const COLUNAS = {
  marca: 1,        // Marca
  modelo: 2,       // Modelo
  num_serie: 3,    // Nº Serie
  localizacao: 4,  // Localização Atual
  ip: 5,           // IP
  host_name: 6,    // HOST NAME
};

// ─── Leitura de células ────────────────────────────────────

/**
 * Texto de uma célula, ou null.
 *
 * O espaço duro (`\u00a0`) conta como vazio, pela mesma razão do importador dos
 * telemóveis: é o que sobra de alguém ter limpado uma coluna com a barra de
 * espaços, e sem isto passava por preenchida.
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
  const s = String(v).replace(/\u00a0/g, ' ').trim();
  if (s === '' || s === '#') return null;
  return max ? s.slice(0, max) : s;
}

// ─── Forma canónica do IP ──────────────────────────────────

/**
 * O IP sem os zeros à esquerda de cada octeto: `10.22.129.049` → `10.22.129.49`.
 *
 * Cópia da função com o mesmo nome em `server/routes/iga/impressoras.js`, para o
 * que entra pela importação e o que entra pelo ecrã ficarem escritos da mesma
 * maneira. Os importadores deste repositório não importam dos routers — o dos
 * telemóveis já repete o `texto()` e o `dataISO()` pela mesma razão. **Se uma
 * mudar, muda a outra**; são cinco linhas e a duplicação é conhecida.
 *
 * Só toca em endereços IPv4 bem formados: qualquer outra coisa na célula passa
 * intacta, para o importador não estragar o que não percebe.
 */
function normalizarIP(v) {
  if (!v) return v;
  const s = String(v).trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return s;
  return s.split('.').map(o => String(Number(o))).join('.');
}

// ─── Conferência host name ↔ IP ────────────────────────────

/**
 * O host acaba no último octeto do IP?
 *
 * `10.22.129.246` ↔ `CML182_KO_246` bate; `10.22.129.60` ↔ `CML182_KO_050` não.
 * A comparação é numérica de propósito — `_049` e `.49` são o mesmo número
 * escrito de duas maneiras, e não é isso que aqui se procura.
 *
 * Devolve null quando falta um dos dois valores ou quando o host não acaba em
 * dígitos: sem os dois lados não há divergência que declarar.
 */
function divergeDoIP(ip, host) {
  if (!ip || !host) return null;
  const octeto = /(\d+)\s*$/.exec(ip);
  const sufixo = /(\d+)\s*$/.exec(host);
  if (!octeto || !sufixo) return null;
  return Number(octeto[1]) !== Number(sufixo[1]);
}

// ─── Importação ────────────────────────────────────────────

async function principal() {
  const ficheiro = CAMINHO_ARG || process.env.XLSX_IMPRESSORAS || CAMINHO_OMISSAO;
  if (!fs.existsSync(ficheiro)) throw new Error(`Ficheiro não encontrado: ${ficheiro}`);
  console.log(`A ler ${ficheiro}`);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(ficheiro);
  const ws = wb.worksheets[0];

  const pool = await poolPromise;
  if (!pool) throw new Error('Sem ligação à base de dados — ver o .env.');

  const resumo = {
    lidas: 0,
    criadas: 0,
    atualizadas: 0,
    duplicadas_na_folha: 0,
    sem_serie: 0,
    sem_local: 0,
    vazias: 0,
    ips_normalizados: 0,   // linhas cujo IP na folha tinha zeros à esquerda
    host_diverge_do_ip: [],
  };

  // Uma linha que casa com uma máquina criada NESTA corrida é uma linha repetida
  // na folha, não uma actualização. Mesma distinção do importador dos telemóveis,
  // e pela mesma razão: sem ela o resumo diz "atualizadas" e esconde o duplicado.
  const criadasNestaCorrida = new Set();

  for (let i = 2; i <= ws.rowCount; i++) {
    const r = ws.getRow(i);

    const ipCru = texto(r.getCell(COLUNAS.ip), 45);
    const campos = {
      marca: texto(r.getCell(COLUNAS.marca), 40),
      modelo: texto(r.getCell(COLUNAS.modelo), 80),
      num_serie: texto(r.getCell(COLUNAS.num_serie), 40),
      localizacao: texto(r.getCell(COLUNAS.localizacao), 160),
      ip: normalizarIP(ipCru),
      host_name: texto(r.getCell(COLUNAS.host_name), 60),
    };

    if (!campos.num_serie && !campos.host_name && !campos.ip) { resumo.vazias++; continue; }
    if (!campos.num_serie) resumo.sem_serie++;
    if (!campos.localizacao) resumo.sem_local++;
    if (ipCru && campos.ip !== ipCru) resumo.ips_normalizados++;

    if (divergeDoIP(campos.ip, campos.host_name)) {
      resumo.host_diverge_do_ip.push({
        linha: i,
        localizacao: campos.localizacao,
        ip: campos.ip,
        host_name: campos.host_name,
      });
    }

    // Encontrar a máquina: primeiro pela série (a chave do parque), depois pelo
    // host name. Os dois são índices únicos filtrados, portanto no máximo há uma.
    let id = null;
    for (const col of ['num_serie', 'host_name']) {
      if (!campos[col] || id) continue;
      const achado = await pool.request().input('v', sql.NVarChar(60), campos[col])
        .query(`SELECT TOP 1 id FROM dbo.impressoras WHERE ${col} = @v`);
      if (achado.recordset.length) id = achado.recordset[0].id;
    }

    if (id) {
      // Só os valores que a folha traz: uma célula vazia não apaga o que já lá
      // está — pode ter sido preenchido pelo ecrã depois da última exportação.
      const p = pool.request().input('id', sql.Int, id);
      const sets = [];
      for (const [c, v] of Object.entries(campos)) {
        if (v === null) continue;
        p.input(c, sql.NVarChar(160), v);
        sets.push(`${c} = @${c}`);
      }
      if (sets.length) {
        await p.query(`UPDATE dbo.impressoras SET ${sets.join(', ')}, atualizado_em = GETDATE() WHERE id = @id`);
      }
      if (criadasNestaCorrida.has(id)) resumo.duplicadas_na_folha++;
      else resumo.atualizadas++;
    } else {
      const ins = await pool.request()
        .input('marca', sql.NVarChar(40), campos.marca)
        .input('modelo', sql.NVarChar(80), campos.modelo)
        .input('num_serie', sql.NVarChar(40), campos.num_serie)
        .input('localizacao', sql.NVarChar(160), campos.localizacao)
        .input('ip', sql.NVarChar(45), campos.ip)
        .input('host_name', sql.NVarChar(60), campos.host_name)
        .query(`INSERT INTO dbo.impressoras (marca, modelo, num_serie, localizacao, ip, host_name)
                OUTPUT INSERTED.id
                VALUES (@marca, @modelo, @num_serie, @localizacao, @ip, @host_name)`);
      id = ins.recordset[0].id;
      criadasNestaCorrida.add(id);
      resumo.criadas++;
    }
    resumo.lidas++;
  }

  await pool.request()
    .input('f', sql.NVarChar(400), ficheiro)
    .input('r', sql.NVarChar(sql.MAX), JSON.stringify(resumo))
    .input('por', sql.NVarChar(120), process.env.USERNAME || 'desconhecido')
    .query('INSERT INTO dbo.impressoras_importacoes (ficheiro, resumo, executado_por) VALUES (@f, @r, @por)');

  const locais = await pool.request().query(`
    SELECT ISNULL(localizacao, N'(sem local)') AS localizacao, COUNT(*) AS total
    FROM dbo.impressoras GROUP BY localizacao ORDER BY localizacao`);

  console.log('\nResumo da importação:');
  console.log(JSON.stringify(resumo, null, 2));

  if (resumo.host_diverge_do_ip.length) {
    console.log('\n⚠️  Host name não bate certo com o último octeto do IP:');
    for (const d of resumo.host_diverge_do_ip) {
      console.log(`   linha ${d.linha}  ${d.localizacao || '(sem local)'}  IP ${d.ip}  host ${d.host_name}`);
    }
    console.log('   Os dois valores entraram como estão — confirmar no serviço e corrigir pelo ecrã.');
  }

  console.log('\nImpressoras por local:');
  for (const l of locais.recordset) console.log(`  ${String(l.localizacao).padEnd(32)} ${l.total}`);
}

principal()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('\nImportação falhou:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
