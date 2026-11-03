'use strict';

const crypto = require('node:crypto');
const EC = require('elliptic').ec;

const ec = new EC('secp256k1');

const HEX_RE = /^[0-9a-f]+$/i;
const BLOCK_ID_RE = /^[0-9a-f]{64}$/i;

/**
 * SHA-256 em hexadecimal (UTF-8), idêntico ao usado pelo cliente.
 */
function sha256(message) {
  return crypto.createHash('sha256').update(String(message), 'utf8').digest('hex');
}

/**
 * Valida uma chave pública secp256k1 comprimida (66) ou não comprimida (130).
 */
function isValidPublicKey(publicKeyHex) {
  if (typeof publicKeyHex !== 'string') return false;
  if (![66, 130].includes(publicKeyHex.length) || !HEX_RE.test(publicKeyHex)) return false;
  try {
    ec.keyFromPublic(publicKeyHex, 'hex');
    return true;
  } catch {
    return false;
  }
}

/**
 * Valida o formato de uma assinatura DER em hexadecimal.
 * DER de secp256k1 costuma ter 140–146 caracteres; aceitamos uma faixa segura.
 */
function isValidSignature(signature) {
  if (typeof signature !== 'string') return false;
  if (signature.length < 128 || signature.length > 200 || signature.length % 2 !== 0) return false;
  return HEX_RE.test(signature);
}

function isValidBlockId(id) {
  return typeof id === 'string' && BLOCK_ID_RE.test(id);
}

/**
 * Verifica a assinatura de um bloco.
 * A mensagem assinada é exatamente JSON.stringify(bloco sem "sig").
 */
function verifySignature(publicKeyHex, message, signature) {
  try {
    if (!isValidPublicKey(publicKeyHex)) return false;
    if (!isValidSignature(signature)) return false;
    const key = ec.keyFromPublic(publicKeyHex, 'hex');
    const msgHash = sha256(message);
    return key.verify(msgHash, signature);
  } catch {
    return false;
  }
}

/**
 * Calcula o id canônico do bloco: sha256(JSON.stringify(bloco sem id e sem sig)).
 *
 * A ordem das propriedades importa: o protocolo usa a serialização JSON
 * ingênua. Clientes devem criar o bloco sempre na mesma ordem.
 */
function computeBlockId(block) {
  const copy = { ...block };
  delete copy.id;
  delete copy.sig;
  return sha256(JSON.stringify(copy));
}

module.exports = {
  ec,
  sha256,
  verifySignature,
  isValidPublicKey,
  isValidSignature,
  isValidBlockId,
  computeBlockId,
};
