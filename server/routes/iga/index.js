'use strict';

/**
 * Inventário e Gestão de Ativos — o router do módulo.
 *
 * Mount em server/index.js DEPOIS do SSPI:
 *   const igaApi = require('./routes/iga');
 *   app.use('/api/iga', igaApi);
 *
 * Este ficheiro não tem rotas próprias: abre o `/permissoes`, aplica o gate de
 * VER e monta um router por tipo de equipamento. **É aqui que um tipo novo
 * entra** — uma linha, a seguir às outras:
 *
 *   /api/iga/radios      → ./radios.js       (base `RadiosDev`)
 *   /api/iga/telemoveis  → ./telemoveis.js   (base `TelemoveisDev`)
 *   /api/iga/impressoras → ./impressoras.js  (base do módulo — a mesma dos rádios)
 *   /api/iga/maquinas    → ./maquinas.js     (idem — máquinas fotográficas)
 *   /api/iga/tablets     → ./tablets.js      (idem)
 *
 * Cada tipo tem o seu ficheiro; **base própria só quando é preciso**. Os
 * telemóveis têm-na por decisão de desenvolvimento (ver a 002); as impressoras
 * partilham a dos rádios e usam a pool do `db.js`. O que todos partilham são as
 * permissões (grupos `IGA`, `IGA-Consulta` e `IGA-Admin`) e os ajudantes de
 * `comum.js`. Não há rota que cruze dois tipos, e é de propósito: onde as bases
 * são separadas não há JOIN possível entre elas.
 */

const express = require('express');
const router = express.Router();

const { router: permissoesRouter, exigirAcesso } = require('./permissoes');

// ─── /permissoes: aberto, diz ao cliente se ele tem acesso ─
// Fica ANTES do gate de propósito: é o endpoint que os ecrãs consultam para
// saber o que mostrar, e a resposta a quem não tem acesso é `canView: false`,
// não um 403 que o browser não consegue explicar ao utilizador.
router.use('/permissoes', permissoesRouter);

// ─── Gate de VER: tudo o que vem a seguir ──────────────────
router.use(exigirAcesso);

// ─── Um router por tipo de equipamento ─────────────────────
router.use('/radios', require('./radios'));
router.use('/telemoveis', require('./telemoveis'));
router.use('/impressoras', require('./impressoras'));
router.use('/maquinas', require('./maquinas'));
router.use('/tablets', require('./tablets'));

module.exports = router;
