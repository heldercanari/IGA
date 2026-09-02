// Load environment variables first
require('dotenv').config();

const logger = require('./server/logger');

// Allow skipping DB connection during local debug/tests by setting DB_DISABLE=1
if (process.env.DB_DISABLE === '1') {
  logger && logger.info && logger.info('DB connection disabled via DB_DISABLE=1');
  const poolPromise = Promise.resolve(null);
  module.exports = { sql: null, poolPromise, dbType: null };
  return;
}

// Determine database type from environment variable (default: mssql for backward compatibility)
const defaultDbType = process.platform === 'win32' ? 'mssql' : 'mariadb';
const DB_TYPE = (process.env.DB_TYPE || defaultDbType).toLowerCase();
let sql, poolPromise;

// Helper function to convert SQL Server syntax to MySQL/MariaDB
function convertQueryForMySQL(query) {
  let converted = query;
  
  // Convert OUTPUT INSERTED.Id to MySQL pattern (will be handled separately)
  // Convert TOP 1 to LIMIT 1
  converted = converted.replace(/\bTOP\s+(\d+)\b/gi, 'LIMIT $1');
  
  // Remove brackets from column/table names (MySQL uses backticks if needed, but usually not)
  converted = converted.replace(/\[(\w+)\]/g, '`$1`');
  
  // Convert ISNULL to IFNULL
  converted = converted.replace(/\bISNULL\s*\(/gi, 'IFNULL(');
  
  // Convert GETDATE() to NOW()
  converted = converted.replace(/\bGETDATE\s*\(\)/gi, 'NOW()');
  
  // Convert sys.objects checks to INFORMATION_SCHEMA
  converted = converted.replace(/sys\.objects/gi, 'INFORMATION_SCHEMA.TABLES');
  converted = converted.replace(/OBJECT_ID\s*\([^)]+\)/gi, '1');
  
  return converted;
}

if (DB_TYPE === 'mysql' || DB_TYPE === 'mariadb') {
  // MariaDB/MySQL connection using mysql2
  const mysql = require('mysql2/promise');
  
  const DB_SERVER = process.env.DB_SERVER || 'localhost';
  const DB_DATABASE = process.env.DB_DATABASE || 'IntranetBD';
  const DB_USER = process.env.DB_USER || 'root';
  const DB_PASSWORD = process.env.DB_PASSWORD || '';
  const DB_PORT = parseInt(process.env.DB_PORT || '3306', 10);

  const config = {
    host: DB_SERVER,
    database: DB_DATABASE,
    user: DB_USER,
    password: DB_PASSWORD,
    port: DB_PORT,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
  };

  // Create connection pool for MariaDB/MySQL
  const pool = mysql.createPool(config);
  
  // Test connection and create promise
  poolPromise = pool.getConnection()
    .then(connection => {
      logger.info('Connected to MariaDB/MySQL');
      connection.release(); // Release test connection back to pool
      return pool;
    })
    .catch(err => {
      logger.error('MariaDB/MySQL Connection Failed! Bad Config: ', err);
      return null;
    });

  // Create sql type definitions compatible with mssql API
  sql = {
    Int: function(val) { return { type: 'INT', value: val }; },
    NVarChar: function(length) {
      if (length === sql.MAX) {
        return function(val) { return { type: 'TEXT', value: val }; };
      }
      return function(val) { return { type: 'VARCHAR', value: val, length: length }; };
    },
    VarChar: function(length) {
      if (length === sql.MAX) {
        return function(val) { return { type: 'TEXT', value: val }; };
      }
      return function(val) { return { type: 'VARCHAR', value: val, length: length }; };
    },
    DateTime: function(val) { return { type: 'DATETIME', value: val }; },
    Bit: function(val) { return { type: 'TINYINT', value: val ? 1 : 0 }; },
    MAX: -1 // Constant for MAX length
  };

  // Wrap pool to provide mssql-like interface
  pool.request = function() {
    const self = this;
    const params = {};
    let lastInsertIdQuery = null;
    
    return {
      input: function(name, type, value) {
        // Handle type functions (like sql.Int(value) or sql.NVarChar(255)(value))
        if (typeof type === 'function') {
          params[name] = type(value);
        } else if (type && typeof type === 'object' && type.value !== undefined) {
          params[name] = type;
        } else {
          params[name] = { value: value };
        }
        return this;
      },
      query: async function(queryString) {
        // Check if query uses OUTPUT INSERTED.Id pattern
        const hasOutputInserted = /OUTPUT\s+INSERTED\.(\w+)/i.test(queryString);
        let insertedColumn = null;
        
        if (hasOutputInserted) {
          const match = queryString.match(/OUTPUT\s+INSERTED\.(\w+)/i);
          insertedColumn = match ? match[1] : 'Id';
          // Remove OUTPUT clause for MySQL
          queryString = queryString.replace(/OUTPUT\s+INSERTED\.\w+/i, '');
        }
        
        // Convert SQL Server syntax to MySQL
        let processedQuery = convertQueryForMySQL(queryString);
        
        // Convert @paramName to ? placeholders and build values array
        const values = [];
        processedQuery = processedQuery.replace(/@(\w+)/g, (match, paramName) => {
          if (params[paramName] !== undefined) {
            const param = params[paramName];
            values.push(param.value !== undefined ? param.value : param);
            return '?';
          }
          return match;
        });
        
        try {
          const [rows, fields] = await pool.execute(processedQuery, values);
          const affected = (rows && typeof rows.affectedRows === 'number') ? rows.affectedRows : 0;
          
          // If this was an INSERT with OUTPUT, get the last insert ID
          if (hasOutputInserted && /^\s*INSERT\s+INTO/i.test(queryString)) {
            const [idRows] = await pool.execute('SELECT LAST_INSERT_ID() AS ' + insertedColumn);
            if (idRows && idRows.length > 0) {
              return { 
                recordset: [idRows[0]],
                rowsAffected: [affected]
              };
            }
          }
          
          return { 
            recordset: Array.isArray(rows) ? rows : (rows ? [rows] : []),
            rowsAffected: [affected]
          };
        } catch (err) {
          throw err;
        }
      }
    };
  };

  // getPool: MariaDB pool is always available (connection pooling is built-in)
  function getPool() { return poolPromise; }

  module.exports = { sql, poolPromise, getPool, dbType: DB_TYPE, pool };
} else {
  // SQL Server connection using mssql (default)
  sql = require('mssql');
  
  const DB_SERVER = process.env.DB_SERVER || 'localhost';
  const DB_PORT = process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : undefined;
  const DB_DATABASE = process.env.DB_DATABASE || 'IntranetBD';
  const DB_USER = process.env.DB_USER;
  const DB_PASSWORD = process.env.DB_PASSWORD;

  // Parse server and instance if provided as server\instance
  let parsedServer = DB_SERVER;
  let instanceName = undefined;
  
  // Convert . to localhost
  if (parsedServer === '.') {
    parsedServer = 'localhost';
  }
  
  if (DB_SERVER && DB_SERVER.includes('\\')) {
    const parts = DB_SERVER.split('\\');
    parsedServer = parts[0];
    instanceName = parts[1];
    
    // Convert . to localhost
    if (parsedServer === '.') {
      parsedServer = 'localhost';
    }
    
    logger.info('Parsed server:', parsedServer, 'instance:', instanceName);
  }
  
  // Build connection config
  const serverConfig = {
    server: parsedServer,
    port: DB_PORT ? parseInt(DB_PORT, 10) : undefined,
    options: {
      instanceName: instanceName,
      trustServerCertificate: true,
      encrypt: false,
      enableArithAbort: true,
      connectTimeout: 30000
    },
    requestTimeout: 60000
  };
  
  logger.info('Connection Config:', {
    server: serverConfig.server,
    port: serverConfig.port,
    instanceName: serverConfig.options.instanceName,
    database: DB_DATABASE
  });

  const config = {
    ...serverConfig,
    database: DB_DATABASE,
    pool: {
      max: 30,
      min: 2,
      idleTimeoutMillis: 30000,
      acquireTimeoutMillis: 15000
    }
  };

  // Debug: log the configuration
  logger.info('SQL Server Connection Config:', JSON.stringify({
    server: config.server,
    port: config.port,
    database: config.database
  }, null, 2));

  // If user/password specified, use SQL authentication; otherwise Windows auth
  if (DB_USER && DB_PASSWORD) {
    // SQL Server authentication
    config.user = DB_USER;
    config.password = DB_PASSWORD;
    logger.info(`Using SQL Server Authentication - User: ${DB_USER}`);
  } else {
    // Use Kerberos for Windows authentication (better compatibility)
    config.authentication = {
      type: 'default'
    };
    logger.info('Using default Windows Authentication (Kerberos/SPNEGO)');
  }

  // Create the pool but handle connection failures gracefully so requiring this
  // module doesn't cause an unhandled rejection or crash during development.
  let _pool = null;
  let _connectingPromise = null;

  function connectPool() {
    if (_connectingPromise) return _connectingPromise;
    _connectingPromise = new sql.ConnectionPool(config)
      .connect()
      .then(pool => {
        logger.info('Connected to SQL Server');
        _pool = pool;
        _connectingPromise = null;
        // Invalidate cached pool on fatal errors so the next getPool() reconnects
        try {
          pool.on('error', (err) => {
            logger.warn && logger.warn('[db] Pool error — invalidating cached pool:', err && err.message);
            if (_pool === pool) _pool = null;
          });
        } catch (_) { /* ignore */ }
        return pool;
      })
      .catch(err => {
        logger.error('Database Connection Failed! Bad Config: ', err);
        _pool = null;
        _connectingPromise = null;
        return null;
      });
    return _connectingPromise;
  }

  // getPool: returns a connected pool, reconnecting if necessary
  function getPool() {
    if (_pool && _pool.connected) return Promise.resolve(_pool);
    return connectPool();
  }

  // Fire-and-forget initial connection for warm-up and startup logging
  connectPool();

  // poolPromise is a thenable that always delegates to getPool() — so callers
  // that do `await poolPromise` get a fresh reconnection attempt on each await
  // instead of being stuck with a null from the initial connection failure.
  poolPromise = {
    then: (onFulfilled, onRejected) => getPool().then(onFulfilled, onRejected),
    catch: (onRejected) => getPool().catch(onRejected),
    finally: (onFinally) => getPool().finally(onFinally)
  };

  module.exports = { sql, poolPromise, getPool, dbType: DB_TYPE };
}
