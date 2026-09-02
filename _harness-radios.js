/**
 * Harness do módulo de Rádios — só para verificação local.
 * Serve `public/` e monta o router com um utilizador injectado, no lugar do SSPI.
 *
 *   npm run harness
 *   ATOR=andreia.r.goncalves npm run harness
 *
 * ATOR escolhe quem se está a fingir. O gate lê o username, resolve-o para
 * mecanográfico em `colaboradores.[user]` e vai aos grupos:
 *   helder.canarias      → escrita + administração (importar, abater, apagar)
 *   andreia.r.goncalves  → escrita, sem administração
 *   sem.acesso           → 403 na página e na API
 *
 * Estes utilizadores vêm de `migrations/000_seed_local.sql`. Na intranet a
 * sério não há harness nenhum: a identidade vem do Windows (SSPI) e o router é
 * montado pelo `server/index.js`.
 */
const path = require('path');
const express = require('express');
const router = require('./server/routes/radios');
const { exigirAcesso } = require('./server/routes/radios/permissoes');

const ATOR = process.env.ATOR || 'helder.canarias';
const PORTA = parseInt(process.env.HARNESS_PORT || '3943', 10);

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = `PM\\${ATOR}`; next(); });

// Mesma ordem do server/index.js: a página é gated, os assets são públicos.
app.use('/api/radios', router);
app.get(['/radios.html', '/radios', '/'], exigirAcesso, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'radios.html'));
});
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORTA, () => {
  console.log(`[harness radios] http://localhost:${PORTA}/radios.html  (actor: ${ATOR}, BD: ${process.env.DB_DATABASE || 'do .env'})`);
});
