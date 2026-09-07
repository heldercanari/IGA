'use strict';

/**
 * A regra de sincronização dos importadores: **a base de dados manda.**
 *
 * Decisão de 2026-09-07. Até aqui os ficheiros de origem ganhavam: uma célula
 * preenchida escrevia por cima do que estivesse na base, viesse de onde viesse.
 * Isso apagava em silêncio o que tinha sido corrigido pelo ecrã — foi o que
 * aconteceu com o IP da impressora da AADIVPOL, corrigido à mão e desfeito pela
 * importação seguinte.
 *
 * A regra passa a ser:
 *
 *  - **Um campo que já tem valor na base não se toca**, diga o ficheiro o que
 *    disser. Na prática: `SET coluna = ISNULL(coluna, @novo)`.
 *  - **Um campo vazio na base é preenchido pelo ficheiro.** Encher um buraco não
 *    é contrariar a base; é dar-lhe o que ela não tinha.
 *  - **Uma linha que não existe entra por inteiro.** Trazer equipamento novo
 *    continua a ser para o que os importadores servem.
 *  - **Equipamento com uma entrega em aberto na base não muda de mãos pela
 *    importação.** Quem tem o quê decide-se no ecrã.
 *
 * O que o ficheiro diz e a base contradiz **não se perde: aparece no resumo**,
 * campo a campo. Sem isso a nova regra tornava os importadores mudos e as folhas
 * afastavam-se da base sem ninguém dar por nada.
 *
 * ⚠️ **Este ficheiro é partilhado pelos quatro importadores, e é de propósito.**
 * Os importadores desta casa repetem os ajudantes pequenos (`texto()`,
 * `dataISO()`) em vez de os importarem uns dos outros — mas isto não é um
 * ajudante, é a política. Se cada um tivesse a sua cópia, bastava uma divergir
 * para deixar de haver política nenhuma.
 */

/**
 * O `SET` de um `UPDATE` que só preenche buracos.
 *
 * Recebe os nomes das colunas e devolve `col = ISNULL(col, @col)` para cada
 * uma — o `ISNULL` do SQL Server fica com o primeiro argumento não nulo, e o
 * primeiro é o que a base já tem.
 */
function preencherBuracos(colunas) {
  return colunas.map(c => `${c} = ISNULL(${c}, @${c})`);
}

/**
 * Onde é que o ficheiro discorda da base.
 *
 * Só conta os campos em que a base tem um valor **e ele é outro** — um campo
 * vazio na base não é divergência, é um buraco que a importação preenche. A
 * comparação é por texto e sem espaços à volta: o que se quer apanhar é
 * "10.22.129.60" contra "10.22.129.50", não `30` contra `'30'`.
 *
 * Devolve uma lista de `{ campo, base, ficheiro }`, vazia quando estão de acordo.
 */
function divergencias(linhaBase, campos) {
  const fora = [];
  if (!linhaBase) return fora;
  for (const [campo, doFicheiro] of Object.entries(campos)) {
    if (doFicheiro === null || doFicheiro === undefined || doFicheiro === '') continue;
    const naBase = linhaBase[campo];
    if (naBase === null || naBase === undefined || naBase === '') continue;
    if (String(naBase).trim() === String(doFicheiro).trim()) continue;
    fora.push({ campo, base: naBase, ficheiro: doFicheiro });
  }
  return fora;
}

/**
 * Escreve o bloco das divergências no fim de uma importação.
 *
 * `chave` é o que identifica a linha para quem lê — o indicativo de um rádio, o
 * ID-PM de uma máquina. Mostra as primeiras `limite` e diz quantas ficaram por
 * mostrar: um ficheiro muito afastado da base dava centenas de linhas e não é o
 * ecrã de um importador que as resolve.
 */
function mostrarDivergencias(lista, limite) {
  if (!lista || !lista.length) return;
  const max = limite || 20;
  console.log(`\n⚠️  ${lista.length} campo(s) em que o ficheiro diz outra coisa que a base:`);
  console.log('   (a base manda — nada disto foi gravado)');
  for (const d of lista.slice(0, max)) {
    console.log(`   ${String(d.chave || '?').padEnd(16)} ${String(d.campo).padEnd(20)} base: ${String(d.base).padEnd(24)} ficheiro: ${d.ficheiro}`);
  }
  if (lista.length > max) console.log(`   … e mais ${lista.length - max}.`);
  console.log('   Resolve-se onde manda: pelo ecrã, se a base é que está errada;');
  console.log('   na folha de origem, se é ela que está desactualizada.');
}

module.exports = { preencherBuracos, divergencias, mostrarDivergencias };
