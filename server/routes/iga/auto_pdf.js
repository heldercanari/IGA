'use strict';

/**
 * O auto de abate em PDF: a 1.ª página é o próprio modelo da DMSI, as
 * restantes um anexo com a lista completa.
 *
 * O modelo (`server/modelos/auto_abate_CML.pdf`) é um formulário XFA, e um XFA
 * não se preenche de forma fiável por programa: cada leitor desenha-o à sua
 * maneira, e o pdf-lib nem o sabe escrever. Por isso o texto é **desenhado por
 * cima da página**, nas posições dos campos, e o formulário é retirado — sem
 * isso o leitor pintava os campos vazios por cima do que se escreveu. A folha
 * que sai é a da DMSI, só que já preenchida e sem campos.
 *
 * ⚠️ As coordenadas abaixo são as dos campos do modelo de 2026 (pontos PDF, com
 * a origem no canto inferior esquerdo). Se a DMSI mudar o modelo, mudam com ele.
 *
 * A tabela do modelo tem dez linhas. Até dez equipamentos cabem todos na folha;
 * com mais, a folha leva os nove primeiros e a décima linha remete para o
 * anexo, que traz a lista inteira — o mesmo que se fez à mão no 02/2023.
 */

const fs = require('fs');
const path = require('path');
const { PDFDocument, PDFName, StandardFonts, rgb } = require('pdf-lib');

const MODELO = path.join(__dirname, '..', '..', 'modelos', 'auto_abate_CML.pdf');

/** As colunas da tabela do modelo: [x esquerdo, largura]. */
const COLUNAS = {
  descricao: [59, 106],
  apto: [168, 152],
  marca: [322, 84],
  serie: [409, 99],
  qt: [511, 25],
};
/** O y de baixo de cada uma das dez linhas, de cima para baixo; todas com ~18 pt. */
const LINHAS_Y = [458, 436, 415, 397, 376, 355, 333, 312, 291, 270];

const PRETO = rgb(0, 0, 0);

/**
 * As fontes-padrão do PDF só conhecem o WinAnsi. O português cabe lá inteiro,
 * mas aspas tipográficas raras ou emojis não — troca-se o que não cabe, em vez
 * de o pdf-lib rebentar a meio do auto.
 */
function seguro(v) {
  return String(v == null ? '' : v)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7E -ÿ–—…€]/g, '?');
}

/** Corta o texto em linhas que caibam na largura; a última leva reticências se faltar espaço. */
function partir(texto, fonte, tamanho, largura, maxLinhas) {
  const palavras = seguro(texto).split(/\s+/).filter(Boolean);
  const linhas = [];
  let atual = '';
  for (const p of palavras) {
    const tentativa = atual ? `${atual} ${p}` : p;
    if (fonte.widthOfTextAtSize(tentativa, tamanho) <= largura) { atual = tentativa; continue; }
    if (atual) linhas.push(atual);
    atual = p;
  }
  if (atual) linhas.push(atual);
  if (linhas.length > maxLinhas) {
    const ultimas = linhas.slice(maxLinhas - 1).join(' ');
    let corte = ultimas;
    while (corte && fonte.widthOfTextAtSize(corte + '…', tamanho) > largura) corte = corte.slice(0, -1);
    linhas.splice(maxLinhas - 1, linhas.length, corte + '…');
  }
  return linhas.map(l => {
    let s = l;
    while (s.length > 1 && fonte.widthOfTextAtSize(s, tamanho) > largura) s = s.slice(0, -1);
    return s;
  });
}

function escreverCelula(pagina, fonte, texto, coluna, yBaixo, altura, tamanho) {
  const [x, largura] = COLUNAS[coluna];
  const linhas = partir(texto, fonte, tamanho, largura - 4, 2);
  const passo = tamanho + 1.5;
  const topo = yBaixo + altura / 2 + (linhas.length * passo) / 2 - tamanho;
  linhas.forEach((l, i) => pagina.drawText(l, { x: x + 2, y: topo - i * passo, size: tamanho, font: fonte, color: PRETO }));
}

function dataPt(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (isNaN(x)) return '';
  return `${String(x.getUTCDate()).padStart(2, '0')}/${String(x.getUTCMonth() + 1).padStart(2, '0')}/${x.getUTCFullYear()}`;
}

/**
 * gerarAutoPdf({ numero, ano, data, comissao: [3 nomes], destino, valor, tipo, itens })
 *   itens: [{ descricao, apto, marca, serie, qt }]
 * Devolve um Buffer com o PDF.
 */
async function gerarAutoPdf(auto) {
  const doc = await PDFDocument.load(fs.readFileSync(MODELO), { ignoreEncryption: true });
  // Sem o formulário: ver o comentário do topo.
  doc.catalog.delete(PDFName.of('AcroForm'));
  const folha = doc.getPage(0);
  folha.node.delete(PDFName.of('Annots'));

  const normal = await doc.embedFont(StandardFonts.Helvetica);
  const negrito = await doc.embedFont(StandardFonts.HelveticaBold);
  const numero = `${String(auto.numero).padStart(2, '0')}/${auto.ano}`;
  const itens = auto.itens || [];
  const comAnexo = itens.length > LINHAS_Y.length;
  const paginasAnexo = comAnexo ? Math.ceil(itens.length / 38) : 0;
  const totalPaginas = 1 + paginasAnexo;

  // ── Cabeçalho ──
  folha.drawText(numero, { x: 160, y: 615, size: 12, font: negrito, color: PRETO });
  folha.drawText(dataPt(auto.data), { x: 82, y: 590, size: 10, font: normal, color: PRETO });

  // A comissão começa no fim da linha do "reuniu a Comissão constituída por" e
  // continua nas três linhas de baixo, como se escreve à mão no modelo.
  const nomes = (auto.comissao || []).filter(Boolean);
  const textoComissao = nomes.length > 1
    ? `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}` : (nomes[0] || '');
  // Palavra a palavra: a primeira linha leva as que couberem nos 195 pt do fim
  // da linha; o resto passa às de baixo. Partir por caracteres cortava nomes.
  const palavras = seguro(textoComissao).split(/\s+/).filter(Boolean);
  let primeira = '';
  while (palavras.length && normal.widthOfTextAtSize(primeira ? `${primeira} ${palavras[0]}` : palavras[0], 10) <= 195) {
    primeira = primeira ? `${primeira} ${palavras.shift()}` : palavras.shift();
  }
  folha.drawText(primeira, { x: 341, y: 590, size: 10, font: normal, color: PRETO });
  partir(palavras.join(' '), normal, 10, 472, 3)
    .forEach((l, i) => folha.drawText(l, { x: 62, y: 570 - i * 19.5, size: 10, font: normal, color: PRETO }));

  // ── Tabela ──
  const naFolha = comAnexo ? itens.slice(0, LINHAS_Y.length - 1) : itens;
  naFolha.forEach((it, i) => {
    const y = LINHAS_Y[i];
    escreverCelula(folha, normal, it.descricao, 'descricao', y, 18, 7.5);
    escreverCelula(folha, normal, it.apto, 'apto', y, 18, 7.5);
    escreverCelula(folha, normal, it.marca, 'marca', y, 18, 7.5);
    escreverCelula(folha, normal, it.serie, 'serie', y, 18, 7.5);
    escreverCelula(folha, normal, String(it.qt || 1), 'qt', y, 18, 7.5);
  });
  if (comAnexo) {
    const y = LINHAS_Y[LINHAS_Y.length - 1];
    const faltam = itens.length - naFolha.length;
    // Cada pedaço na sua coluna: um texto só atravessava as divisórias da tabela.
    escreverCelula(folha, negrito, 'Restantes em anexo', 'descricao', y, 18, 7.5);
    escreverCelula(folha, negrito, `Mais ${faltam} — lista completa dos ${itens.length} no anexo`, 'apto', y, 18, 7.5);
    escreverCelula(folha, normal, String(faltam), 'qt', y, 18, 7.5);
  }

  // ── Valor e destino ──
  const valor = auto.valor || (comAnexo ? `Em anexo a lista dos ${itens.length} equipamentos.` : '');
  partir(valor, normal, 9.5, 412, 1).forEach(l => folha.drawText(l, { x: 121, y: 244, size: 9.5, font: normal, color: PRETO }));
  partir(auto.destino || '', negrito, 10, 470, 2)
    .forEach((l, i) => folha.drawText(l, { x: 63, y: 191 - i * 12, size: 10, font: negrito, color: PRETO }));

  // O "Pág. 1/1" está impresso no modelo: tapa-se e escreve-se o verdadeiro.
  folha.drawRectangle({ x: 505, y: 22, width: 40, height: 14, color: rgb(1, 1, 1) });
  folha.drawText(`Pág. 1/${totalPaginas}`, { x: 508, y: 26, size: 8, font: normal, color: PRETO });

  // ── Anexo ──
  if (comAnexo) {
    const POR_PAGINA = 38;
    const cab = ['N.º', 'DESCRIÇÃO', 'APTO PARA DOAÇÃO', 'MARCA', 'N.º SÉRIE', 'Qt.'];
    const xs = [50, 72, 192, 330, 418, 525];
    const larg = [20, 118, 136, 86, 105, 20];
    for (let p = 0; p < paginasAnexo; p++) {
      const pg = doc.addPage([595.276, 841.89]);
      pg.drawText(seguro(`Anexo ao Auto de abate n.º ${numero}`), { x: 50, y: 790, size: 13, font: negrito, color: PRETO });
      pg.drawText(seguro(`${auto.tipo || ''} · ${itens.length} equipamentos · ${dataPt(auto.data)}`),
        { x: 50, y: 773, size: 9, font: normal, color: PRETO });
      let y = 745;
      pg.drawRectangle({ x: 48, y: y - 4, width: 499, height: 16, color: rgb(0.9, 0.9, 0.9) });
      cab.forEach((c, i) => pg.drawText(seguro(c), { x: xs[i], y, size: 7.5, font: negrito, color: PRETO }));
      y -= 18;
      itens.slice(p * POR_PAGINA, (p + 1) * POR_PAGINA).forEach((it, k) => {
        const n = p * POR_PAGINA + k + 1;
        const valores = [String(n), it.descricao, it.apto, it.marca, it.serie, String(it.qt || 1)];
        valores.forEach((v, i) => {
          const l = partir(v, normal, 7.5, larg[i], 1)[0] || '';
          pg.drawText(l, { x: xs[i], y, size: 7.5, font: normal, color: PRETO });
        });
        pg.drawLine({ start: { x: 48, y: y - 5 }, end: { x: 547, y: y - 5 }, thickness: 0.3, color: rgb(0.7, 0.7, 0.7) });
        y -= 18;
      });
      pg.drawText(`Pág. ${p + 2}/${totalPaginas}`, { x: 508, y: 26, size: 8, font: normal, color: PRETO });
    }
  }

  return Buffer.from(await doc.save());
}

module.exports = { gerarAutoPdf };
