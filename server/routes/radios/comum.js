'use strict';

/**
 * Ajudantes partilhados pelos dois tipos de activo (rádios e telemóveis).
 *
 * Nasceu quando os telemóveis entraram: as duas famílias de rotas fazem a mesma
 * leitura de campos e as mesmas datas, e duas cópias de `data()` divergiam à
 * primeira correcção. O que é próprio de cada tipo — o recálculo do estado, que
 * conhece as tabelas — fica em cada ficheiro de rotas, não aqui.
 */

/** Texto vazio, 'N/A' e espaços em branco guardam-se como NULL. */
function limpar(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return (s === '' || s === 'N/A') ? null : s;
}

/** Inteiro ou NULL — nunca NaN, que o tedious rejeita com uma mensagem opaca. */
function inteiro(v) {
  const s = limpar(v);
  if (s === null) return null;
  const n = Number(String(s).replace(/\s+/g, ''));
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Data ISO (YYYY-MM-DD) ou NULL.
 *
 * O `<input type="date">` do ecrã manda sempre ISO, mas os pedidos da API podem
 * vir de outro lado: aceita-se também `dd/mm/aaaa`, que é como as datas estão
 * escritas nas guias em papel. Qualquer outra coisa fica NULL — melhor um campo
 * vazio à vista do que uma data adivinhada.
 */
function data(v) {
  const s = limpar(v);
  if (s === null) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  return null;
}

/** Hoje em ISO, para os registos que não trazem data. */
function hoje() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** O username de quem está a fazer a operação, para a coluna `registado_por`. */
function actor(req) {
  return (req.radiosUser && req.radiosUser.username) || null;
}

/** Erro 500 uniforme, com o motivo nos logs e não na resposta. */
function falhou(res, contexto, err) {
  console.error(`[radios] ${contexto}:`, err.message);
  res.status(500).json({ error: `Erro ao ${contexto}.` });
}

module.exports = { limpar, inteiro, data, hoje, actor, falhou };
