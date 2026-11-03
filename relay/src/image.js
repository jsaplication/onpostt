'use strict';

/**
 * Validação de imagens embutidas no `content` de um post.
 *
 * O relay nunca confia nas dimensões declaradas pelo cliente. A imagem é
 * decodificada, o tipo real é detectado pelos bytes e as dimensões são lidas
 * diretamente do cabeçalho PNG/JPEG.
 */

const config = require('./config');

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png']);
const IMAGE_KEYS = new Set(['mime', 'data', 'width', 'height']);
const CONTENT_KEYS = new Set(['text', 'image', 'topics']);
const PROFILE_KEYS = new Set(['name', 'bio', 'image']);
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function fail(error, code = 'invalid_image') {
  return { error, code };
}

function base64Limit() {
  return Math.ceil(config.limits.maxImageBytes / 3) * 4;
}

function readPng(bytes) {
  if (bytes.length < 33) return null;
  if (
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a
  ) {
    return null;
  }
  if (bytes.readUInt32BE(8) !== 13) return null;
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return null;

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height) return null;
  return { mime: 'image/png', width, height };
}

function readJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let offset = 2;
  while (offset < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;

    const marker = bytes[offset];
    offset += 1;

    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xda) break;

    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;

    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isStartOfFrame) {
      if (length < 7) return null;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (!width || !height) return null;
      return { mime: 'image/jpeg', width, height };
    }

    offset += length;
  }

  return null;
}

function detectImage(bytes) {
  return readPng(bytes) || readJpeg(bytes);
}

/**
 * Valida o objeto `{ mime, data, width, height }` de uma imagem.
 * Retorna `null` quando o objeto é válido.
 *
 * @returns {{error: string, code: string}|null}
 */
function validateImageObject(image) {
  if (!isPlainObject(image)) return fail('Campo "image" inválido.', 'invalid_image');

  for (const key of Object.keys(image)) {
    if (!IMAGE_KEYS.has(key)) {
      return fail('Objeto "image" contém campos não suportados.', 'invalid_image');
    }
  }

  if (typeof image.mime !== 'string' || !IMAGE_MIMES.has(image.mime)) {
    return fail('Imagem deve ser image/jpeg ou image/png.', 'invalid_image');
  }
  if (typeof image.data !== 'string' || !image.data.length) {
    return fail('Campo "image.data" é obrigatório.', 'invalid_image');
  }
  if (image.data.length > base64Limit()) {
    return fail(
      `Imagem excede ${config.limits.maxImageBytes} bytes após decodificação.`,
      'image_too_large'
    );
  }
  if (image.data.length % 4 !== 0 || !BASE64_RE.test(image.data)) {
    return fail('Campo "image.data" não é base64 canônico.', 'invalid_image');
  }

  let bytes;
  try {
    bytes = Buffer.from(image.data, 'base64');
  } catch {
    return fail('Não foi possível decodificar a imagem.', 'invalid_image');
  }
  if (bytes.length > config.limits.maxImageBytes) {
    return fail(
      `Imagem excede ${config.limits.maxImageBytes} bytes após decodificação.`,
      'image_too_large'
    );
  }
  if (bytes.toString('base64') !== image.data) {
    return fail('Campo "image.data" não é base64 canônico.', 'invalid_image');
  }

  const detected = detectImage(bytes);
  if (!detected || detected.mime !== image.mime) {
    return fail('Bytes da imagem não correspondem ao tipo declarado.', 'invalid_image');
  }

  if (
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width <= 0 ||
    image.height <= 0
  ) {
    return fail('Dimensões da imagem inválidas.', 'invalid_image_dimensions');
  }
  if (
    image.width > config.limits.maxImageDimension ||
    image.height > config.limits.maxImageDimension ||
    detected.width > config.limits.maxImageDimension ||
    detected.height > config.limits.maxImageDimension
  ) {
    return fail(
      `Imagem excede ${config.limits.maxImageDimension}px em qualquer dimensão.`,
      'invalid_image_dimensions'
    );
  }
  if (image.width !== detected.width || image.height !== detected.height) {
    return fail('Dimensões declaradas não conferem com a imagem.', 'invalid_image_dimensions');
  }

  return null;
}

/**
 * Valida o formato de post `{ text?, image: { mime, data, width, height } }`.
 * Retorna `null` quando o conteúdo não é uma imagem.
 *
 * @returns {{error: string, code: string}|null}
 */
function validateImageContent(content) {
  if (!isPlainObject(content) || content.image === undefined) return null;

  for (const key of Object.keys(content)) {
    if (!CONTENT_KEYS.has(key)) {
      return fail('Conteúdo com imagem aceita apenas "text", "image" e "topics".', 'invalid_image');
    }
  }

  if (content.text !== undefined && typeof content.text !== 'string') {
    return fail('Campo "text" da imagem deve ser texto.', 'invalid_image');
  }
  if (
    typeof content.text === 'string' &&
    Buffer.byteLength(content.text, 'utf8') > config.limits.maxContentSize
  ) {
    return fail(`Legenda da imagem excede ${config.limits.maxContentSize} bytes.`, 'content_too_large');
  }

  return validateImageObject(content.image);
}

/**
 * Valida o conteúdo de perfil com foto:
 * `{ name, bio, image: { mime, data, width, height } }`.
 * Retorna `null` quando o conteúdo não contém imagem.
 *
 * @returns {{error: string, code: string}|null}
 */
function validateProfileContent(content) {
  if (!isPlainObject(content) || content.image === undefined) return null;

  for (const key of Object.keys(content)) {
    if (!PROFILE_KEYS.has(key)) {
      return fail('Perfil com foto aceita apenas "name", "bio" e "image".', 'invalid_profile');
    }
  }

  for (const field of ['name', 'bio']) {
    const value = content[field];
    if (value !== undefined && typeof value !== 'string') {
      return fail(`Campo "${field}" do perfil deve ser texto.`, 'invalid_profile');
    }
    if (
      typeof value === 'string' &&
      Buffer.byteLength(value, 'utf8') > config.limits.maxContentSize
    ) {
      return fail(`Campo "${field}" do perfil é muito grande.`, 'content_too_large');
    }
  }

  return validateImageObject(content.image);
}

module.exports = {
  IMAGE_MIMES,
  validateImageContent,
  validateProfileContent,
  validateImageObject,
  detectImage,
};
