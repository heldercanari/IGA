// server/logger.js — Winston com rotação diária de ficheiros + console.
// Mantém a API original (info/warn/error/debug) para compat com chamadores existentes.

const path = require('path');
const fs = require('fs');
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

const isDev = process.env.NODE_ENV !== 'production';

// Logs de prod -> ./logs/, dev -> ./logs-dev/ (já alinhado com PM2 ecosystem.config.js)
const LOG_DIR = path.resolve(process.cwd(), isDev ? 'logs-dev' : 'logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { /* ignore */ }

const baseFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    if (stack) return `${timestamp} [${level}] ${message}${metaStr}\n${stack}`;
    return `${timestamp} [${level}] ${message}${metaStr}`;
  })
);

const consoleTransport = new winston.transports.Console({
  // PM2 captura stdout/stderr — mantemos a saída
  format: winston.format.combine(
    winston.format.colorize({ all: false }),
    baseFormat
  ),
  // Em prod só info+; em dev tudo
  level: isDev ? 'debug' : 'info'
});

// Rotação diária: 20MB por ficheiro, 14 dias retidos, comprimidos a partir do 2º dia
const fileTransport = new DailyRotateFile({
  filename: path.join(LOG_DIR, 'app-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '14d',
  zippedArchive: true,
  level: 'info',
  format: baseFormat
});

const errorFileTransport = new DailyRotateFile({
  filename: path.join(LOG_DIR, 'error-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '30d',
  zippedArchive: true,
  level: 'error',
  format: baseFormat
});

const winstonLogger = winston.createLogger({
  level: isDev ? 'debug' : 'info',
  format: baseFormat,
  transports: [consoleTransport, fileTransport, errorFileTransport],
  exitOnError: false
});

// API compat com server/logger.js antigo (info/warn/error/debug aceitam várias args)
function joinArgs(args) {
  return args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object') {
      try { return JSON.stringify(a); } catch (e) { return String(a); }
    }
    return String(a);
  }).join(' ');
}

function debug(...args) { winstonLogger.debug(joinArgs(args)); }
function info(...args)  { winstonLogger.info(joinArgs(args)); }
function warn(...args)  { winstonLogger.warn(joinArgs(args)); }
function error(...args) { winstonLogger.error(joinArgs(args)); }

module.exports = { debug, info, warn, error, raw: winstonLogger };
