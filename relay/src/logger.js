'use strict';

const fs = require('node:fs');
const path = require('node:path');
const winston = require('winston');
const config = require('./config');

const transports = [];
let fileLogging = false;

if (config.log.toFile) {
  try {
    fs.mkdirSync(config.log.dir, { recursive: true });
    fileLogging = true;
  } catch (err) {
    // Logs em arquivo são opcionais; o console continua funcionando.
    console.warn(`[onpostt] Não foi possível criar o diretório de logs: ${err.message}`);
  }
}

const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

if (fileLogging) {
  transports.push(
    new winston.transports.File({
      filename: path.join(config.log.dir, 'error.log'),
      level: 'error',
      format: fileFormat,
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }),
    new winston.transports.File({
      filename: path.join(config.log.dir, 'combined.log'),
      format: fileFormat,
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    })
  );
}

const consoleFormat = config.isProduction
  ? winston.format.combine(winston.format.timestamp(), winston.format.errors({ stack: true }), winston.format.json())
  : winston.format.combine(
      winston.format.colorize({ all: false }),
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
        return `${timestamp} ${level}: ${message}${extra}`;
      })
    );

transports.push(new winston.transports.Console({ format: consoleFormat }));

const logger = winston.createLogger({
  level: config.log.level,
  defaultMeta: { service: 'onpostt-relay' },
  transports,
  exitOnError: false,
});

/**
 * Metadados seguros de erro: nunca inclui corpo de bloco, chaves ou senhas.
 */
function errorMeta(err) {
  if (!err) return {};
  return {
    error: {
      name: err.name,
      message: err.message,
      code: err.code,
      ...(config.isProduction ? {} : { stack: err.stack }),
    },
  };
}

module.exports = logger;
module.exports.errorMeta = errorMeta;
module.exports.fileLogging = fileLogging;
