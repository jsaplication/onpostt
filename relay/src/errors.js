'use strict';

class PublicError extends Error {
  constructor(message, { statusCode = 400, code = 'bad_request' } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.expose = true;
  }
}

class ValidationError extends PublicError {
  constructor(message, { code = 'invalid_block' } = {}) {
    super(message, { statusCode: 400, code });
  }
}

class RateLimitError extends PublicError {
  constructor(message = 'Muitas requisições. Tente novamente em instantes.', { retryAfter = 60 } = {}) {
    super(message, { statusCode: 429, code: 'rate_limited' });
    this.retryAfter = retryAfter;
  }
}

class ForbiddenError extends PublicError {
  constructor(message = 'Origem não permitida.') {
    super(message, { statusCode: 403, code: 'forbidden' });
  }
}

function isPublicError(err) {
  return Boolean(err && err.expose === true);
}

function publicMessage(err, fallback = 'Erro interno no servidor.') {
  return isPublicError(err) && err.message ? err.message : fallback;
}

module.exports = {
  PublicError,
  ValidationError,
  RateLimitError,
  ForbiddenError,
  isPublicError,
  publicMessage,
};
