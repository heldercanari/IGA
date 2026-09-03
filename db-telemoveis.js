'use strict';

/**
 * Segunda ligação: a base dos telemóveis.
 *
 * O `db.js` é cópia inalterada da intranet e liga a UMA base — a do módulo, que
 * aqui é a `RadiosDev`. Os telemóveis vivem noutra (`TelemoveisDev`), por isso
 * precisam de pool própria; este ficheiro é essa pool e mais nada. Não substitui
 * o `db.js` nem lhe toca.
 *
 * Mesmo servidor e mesmo login do `.env` — só muda o nome da base, em
 * `DB_DATABASE_TELEMOVEIS`. **Se essa variável não existir, cai na base do
 * `DB_DATABASE`**, que é exactamente o que a intranet vai querer: lá os módulos
 * partilham a base e não há segunda base nenhuma. Juntar os dois módulos numa
 * base só é apagar a variável — o SQL das rotas nunca qualifica a base.
 *
 * A API é a do `db.js` de propósito (`{ sql, poolPromise }`), para as rotas dos
 * telemóveis se escreverem exactamente como as dos rádios.
 */

require('dotenv').config();

const sql = require('mssql');
const logger = require('./server/logger');

const DB_SERVER = process.env.DB_SERVER || 'localhost';
const DB_DATABASE = process.env.DB_DATABASE_TELEMOVEIS || process.env.DB_DATABASE;
const DB_USER = process.env.DB_USER;
const DB_PASSWORD = process.env.DB_PASSWORD;
const DB_PORT = process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : undefined;

const config = {
  server: DB_SERVER,
  database: DB_DATABASE,
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true,
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
};

// Porta e nome de instância são mutuamente exclusivos no tedious — a mesma
// armadilha documentada no `.env`. Aqui só se usa porta.
if (DB_PORT) config.port = DB_PORT;

if (DB_USER) {
  config.user = DB_USER;
  config.password = DB_PASSWORD;
} else {
  // Sem utilizador no .env, tenta a autenticação integrada do Windows — o mesmo
  // caminho que o db.js tem e que aqui também não é o que está rodado.
  config.options.trustedConnection = true;
}

const poolPromise = new sql.ConnectionPool(config)
  .connect()
  .then(pool => {
    logger.info(`Ligado à base dos telemóveis: ${DB_DATABASE}`);
    return pool;
  })
  .catch(err => {
    logger.error(`Ligação à base dos telemóveis falhou (${DB_DATABASE}): ${err.message}`);
    return null;   // as rotas respondem 500 com mensagem própria, como no db.js
  });

module.exports = { sql, poolPromise };
