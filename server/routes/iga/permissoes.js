'use strict';

/**
 * Permissões do Inventário e Gestão de Ativos — SSPI + grupos AD-PM.
 *
 * Valem para o módulo inteiro: são as mesmas para os rádios, os telemóveis e o
 * equipamento que vier a seguir. Quem pode ver rádios pode ver telemóveis.
 *
 * Modelo (espelha `server/routes/correspondencia/permissoes.js`):
 *   VER      → membro activo de 'IGA' OU 'IGA-Consulta' OU 'IGA-Admin'
 *   EDITAR   → membro activo de 'IGA'
 *   ADMIN    → membro activo de 'IGA-Admin'  (importar, abater, apagar)
 *   Admin da consola AD-PM (admin_users.ativo=1) entra em tudo, EXCEPTO na
 *   administração do módulo: essa é só do grupo (ver `canAdmin` abaixo).
 *
 * Username SSPI → mecanográfico via `colaboradores.[user]` (cache 10 min).
 * NUNCA ler `x-remote-user` cru: só `req.user`, que o servidor promove apenas
 * quando o pedido vem de um proxy de confiança.
 *
 *   GET /api/iga/permissoes → o objecto de permissões do request
 *
 * Ao contrário da correspondência, não há filtro de visibilidade por serviço: um
 * rádio não tem destinatário, e quem entra no módulo vê o parque todo. Por isso
 * aqui não existe `chaveServico` nem lista de serviços reservados — se um dia a
 * PM quiser esconder o parque de uma divisão das outras, é uma decisão nova, não
 * um bocado que ficou por copiar.
 */

const express = require('express');
const router = express.Router();
const { poolPromise, sql } = require('../../../db');

const GRUPO_EDITAR = 'IGA';
const GRUPO_CONSULTA = 'IGA-Consulta';
const GRUPO_ADMIN = 'IGA-Admin';
const GRUPOS_ACESSO = [GRUPO_EDITAR, GRUPO_CONSULTA, GRUPO_ADMIN];

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;
const mecCache = new Map(); // usernameNorm -> { mec, nome, expira }

/** Username SSPI do actor (DOMAIN\user → user, sem @dominio), lowercase, ou null. */
function usernameDoRequest(req) {
  let u = req.user || (req.connection && req.connection.user) || '';
  u = String(u || '').trim();
  if (!u) return null;
  u = u.split('\\').pop() || u;
  u = u.split('@')[0];
  return u.trim().toLowerCase() || null;
}

/** Resolve username → { mec, nome } via colaboradores.[user] (cache 10 min). */
async function colaboradorDoUsername(username) {
  if (!username) return { mec: null, nome: null };
  const hit = mecCache.get(username);
  if (hit && hit.expira > Date.now()) return { mec: hit.mec, nome: hit.nome };

  const pool = await poolPromise;
  if (!pool) return { mec: null, nome: null };

  const r = await pool.request()
    .input('u', sql.VarChar(120), username)
    .query(`
      SELECT TOP 1 mecanografico, nome
      FROM colaboradores
      WHERE LOWER([user]) = @u
         OR LOWER(LEFT([user], CASE WHEN CHARINDEX('@', [user]) > 0 THEN CHARINDEX('@', [user]) - 1 ELSE LEN([user]) END)) = @u`);

  const row = r.recordset && r.recordset[0];
  const mec = row ? String(row.mecanografico) : null;
  const nome = row ? (row.nome || null) : null;
  if (mecCache.size >= CACHE_MAX) mecCache.clear();
  // Miss com TTL curto: destrava depressa se o administrador corrigir o [user].
  mecCache.set(username, { mec, nome, expira: Date.now() + (mec ? CACHE_TTL_MS : 30 * 1000) });
  return { mec, nome };
}

/** Admin da consola AD-PM (admin_users.ativo = 1), por username. */
async function isConsoleAdmin(pool, username) {
  if (!username) return false;
  const r = await pool.request()
    .input('u', sql.VarChar(120), username)
    .query('SELECT TOP 1 1 AS ok FROM admin_users WHERE LOWER([username]) = @u AND ativo = 1');
  return !!(r.recordset && r.recordset.length);
}

/** Os grupos ACL deste módulo a que o colaborador pertence, numa ida à base. */
async function gruposDoColaborador(pool, mecanografico) {
  const vazio = new Set();
  if (mecanografico == null || mecanografico === '') return vazio;
  const mecNum = Number(mecanografico);
  if (!Number.isFinite(mecNum)) return vazio;

  const r = await pool.request()
    .input('mec', sql.Int, mecNum)
    .query(`
      SELECT g.nome
      FROM grupos g
      INNER JOIN grupo_membros gm ON gm.grupo_id = g.id
      WHERE gm.mecanografico = @mec AND gm.ativo = 1`);

  const acesso = new Set();
  for (const row of r.recordset || []) {
    if (GRUPOS_ACESSO.includes(row.nome)) acesso.add(row.nome);
  }
  return acesso;
}

/**
 * Permissões completas do request.
 * { username, mecanografico, nome, canView, canEdit, canAdmin, isConsola }
 *
 * `isConsola` e `canAdmin` respondem a perguntas diferentes:
 *   isConsola → administrador da consola AD-PM; abre ver e editar.
 *   canAdmin  → importar, abater e apagar. SÓ membro activo de 'IGA-Admin'.
 *               Sem esta separação, desactivar alguém no grupo não tinha efeito
 *               nenhum se essa pessoa fosse administradora da consola.
 */
async function permissoesDoRequest(req) {
  const username = usernameDoRequest(req);
  const out = {
    username,
    mecanografico: null,
    nome: null,
    canView: false,
    canEdit: false,
    canAdmin: false,
    isConsola: false,
  };
  if (!username) return out;

  const pool = await poolPromise;
  if (!pool) return out;

  try {
    out.isConsola = await isConsoleAdmin(pool, username);
    const info = await colaboradorDoUsername(username);
    out.mecanografico = info.mec;
    out.nome = info.nome;

    const acesso = await gruposDoColaborador(pool, info.mec);

    out.canEdit = out.isConsola || acesso.has(GRUPO_EDITAR) || acesso.has(GRUPO_ADMIN);
    out.canView = out.canEdit || acesso.has(GRUPO_CONSULTA);
    out.canAdmin = acesso.has(GRUPO_ADMIN); // só o grupo — sem atalho pela consola
  } catch (err) {
    console.error('[iga/permissoes] resolução falhou:', err.message);
  }
  return out;
}

/** Escapa para o template abaixo, que é uma string e não um motor de templates. */
function escHtml(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 401/403 negociado: JSON para /api e Accept:json; página institucional caso contrário. */
function negar(req, res, status, message) {
  const wantsJson = String(req.originalUrl || '').startsWith('/api/')
    || String(req.headers.accept || '').includes('application/json');
  if (wantsJson) {
    return res.status(status).json({
      error: message,
      codigo: status === 403 ? 'IGA_SEM_ACESSO' : 'IGA_NAO_AUTENTICADO',
    });
  }
  const titulo = status === 401 ? 'Não autenticado' : 'Acesso reservado';
  // Esta é a página que quem não tem acesso vê de verdade — o `iga.html` nem
  // chega a ser servido. A conta vai nela porque é a primeira coisa que o NSIC
  // pergunta, e é a única que a pessoa não sabe de cor.
  const conta = req.igaUser && req.igaUser.username;
  const blocoConta = conta
    ? `<p class="conta">Indique esta conta ao pedir o acesso:<br><code>${escHtml(conta)}</code></p>`
    : '';
  res.status(status).type('html').send(`<!DOCTYPE html><html lang="pt"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${titulo} · IGA</title>
<style>body{font-family:'Hanken Grotesk',system-ui,Arial,sans-serif;background:#f1f5f9;color:#1e293b;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.box{background:#fff;border:1px solid #e2e8f0;padding:40px 48px;border-radius:16px;max-width:460px;text-align:center;box-shadow:0 20px 40px rgba(15,23,42,.08)}h1{font-size:22px;margin:0 0 12px;color:#0f172a}p{color:#475569;line-height:1.55;margin:0 0 18px}a{color:#2563eb;text-decoration:none;font-weight:700}.conta{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:10px;padding:12px 16px;font-size:13px}.conta code{display:block;margin-top:6px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:15px;font-weight:700;color:#0f172a;user-select:all}</style></head>
<body><div class="box"><h1>${titulo}</h1><p>${escHtml(message)}</p>${blocoConta}<a href="/index2.html">← Voltar à Intranet</a></div></body></html>`);
}

/** Resolve as permissões uma vez por pedido e guarda-as em req.igaUser. */
async function permissoesDoPedido(req, res) {
  if (req.igaUser) return req.igaUser;
  try {
    req.igaUser = await permissoesDoRequest(req);
  } catch (err) {
    console.error('[iga/permissoes] middleware falhou:', err.message);
    negar(req, res, 500, 'Erro ao verificar permissões.');
    return null;
  }
  return req.igaUser;
}

/** Middleware VER — 401 se não autenticado, 403 sem acesso. Popula req.igaUser. */
async function exigirAcesso(req, res, next) {
  const p = await permissoesDoPedido(req, res);
  if (!p) return;
  if (!p.username) return negar(req, res, 401, 'Não foi possível identificar o utilizador. '
    + 'Volte a carregar a página; se o problema se mantiver, contacte o NSIC.');
  if (!p.canView) {
    return negar(req, res, 403, 'O acesso ao Inventário e Gestão de Ativos é dado por grupo. '
      + 'Solicite ao NSIC a inclusão no grupo "IGA" (registo e consulta) '
      + 'ou "IGA-Consulta" (apenas consulta).');
  }
  next();
}

/**
 * Middleware EDITAR — aplicado por-rota em TODAS as mutações.
 * Reusa req.igaUser (o gate de VER corre sempre antes, a nível de router).
 */
async function exigirEdicao(req, res, next) {
  const p = await permissoesDoPedido(req, res);
  if (!p) return;
  if (!p.username) return negar(req, res, 401, 'Não foi possível identificar o utilizador. '
    + 'Volte a carregar a página; se o problema se mantiver, contacte o NSIC.');
  if (!p.canEdit) {
    return negar(req, res, 403, 'O seu acesso ao inventário é apenas de consulta. '
      + 'Para registar ou alterar equipamento, solicite ao NSIC a inclusão no grupo "IGA".');
  }
  next();
}

/**
 * Middleware ADMIN — importação, abate e remoção de registos.
 * Testa `canAdmin`, não `isConsola`: a filiação activa em 'IGA-Admin' é a
 * única chave.
 */
async function exigirAdmin(req, res, next) {
  const p = await permissoesDoPedido(req, res);
  if (!p) return;
  if (!p.username) return negar(req, res, 401, 'Não foi possível identificar o utilizador. '
    + 'Volte a carregar a página; se o problema se mantiver, contacte o NSIC.');
  if (!p.canAdmin) {
    return negar(req, res, 403, 'Esta operação é reservada ao grupo "IGA-Admin". '
      + 'Solicite o acesso ao NSIC.');
  }
  next();
}

router.get('/', async (req, res) => {
  try {
    res.json(await permissoesDoRequest(req));
  } catch (err) {
    console.error('[iga/permissoes] GET falhou:', err.message);
    res.status(500).json({ error: 'Erro ao obter permissões' });
  }
});

module.exports = {
  router,
  exigirAcesso,
  exigirEdicao,
  exigirAdmin,
  permissoesDoRequest,
  usernameDoRequest,
  GRUPO_EDITAR,
  GRUPO_CONSULTA,
  GRUPO_ADMIN,
};
