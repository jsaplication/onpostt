/**
 * onpostt — biblioteca oficial do cliente (navegador e Node).
 *
 * Segurança:
 * - nunca envia `privatekey` ao relay;
 * - um único listener de WebSocket por conexão (dispatcher central);
 * - dedupe por assinatura;
 * - reconexão com backoff e reenvio de assinaturas;
 * - mensagens usam chave efêmera por envio (ECDH + AES-256-GCM).
 *
 * Depende de `elliptic` já carregado em `globalThis.elliptic`.
 */
(function (root, factory) {
  'use strict';
  var library = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = library;
  else root.onpostt = library;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  if (!root.elliptic) {
    throw new Error('onpostt: carregue o elliptic antes da biblioteca.');
  }

  var ec = new root.elliptic.ec('secp256k1');
  var subtle = root.crypto && root.crypto.subtle;
  var encoder = new TextEncoder();
  var decoder = new TextDecoder();

  var MODES_HTTP = [
    'post',
    'follow',
    'block',
    'delete',
    'like',
    'reaction',
    'comment',
    'repost',
    'profile',
    'notification',
    'notification_read',
    'message_read',
  ];
  var MODES_WS = ['message'];

  /* ---------------------------------------------------------------------- */
  /* Utilidades                                                             */
  /* ---------------------------------------------------------------------- */

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function bytesToHex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 1) {
      out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
  }

  function randomNonce() {
    var bytes = new Uint8Array(16);
    if (root.crypto && typeof root.crypto.getRandomValues === 'function') {
      root.crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < bytes.length; i += 1) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }
    return bytesToHex(bytes);
  }

  function hexToBytes(hex) {
    if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
      throw new Error('Hex inválido.');
    }
    var bytes = new Uint8Array(hex.length / 2);
    for (var i = 0; i < bytes.length; i += 1) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  function isValidPrivateKey(privateKey) {
    return typeof privateKey === 'string' && /^[0-9a-f]{64}$/i.test(privateKey);
  }

  function publicKeyOf(privateKey) {
    if (!isValidPrivateKey(privateKey)) throw new Error('Chave privada inválida.');
    var key = ec.keyFromPrivate(privateKey, 'hex');
    return key.getPublic(true, 'hex');
  }

  function isValidPublicKey(publicKey) {
    if (typeof publicKey !== 'string' || ![66, 130].includes(publicKey.length)) return false;
    if (!/^[0-9a-f]+$/i.test(publicKey)) return false;
    try {
      ec.keyFromPublic(publicKey, 'hex');
      return true;
    } catch (error) {
      return false;
    }
  }

  function isValidReaction(value) {
    if (typeof value !== 'string' || !value.trim()) return false;
    if (/[\u0000-\u001F\u007F\u2028\u2029]/.test(value)) return false;
    return Array.from(value).length <= 32;
  }

  function isValidBlockId(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
  }

  function isOpen(socket) {
    return socket && socket.readyState === 1;
  }

  function normalizeHttpUrl(url) {
    if (typeof url !== 'string') return '';
    var value = url.trim().replace(/\/+$/, '');
    if (/^wss:\/\//i.test(value)) return value.replace(/^wss:/i, 'https:');
    if (/^ws:\/\//i.test(value)) return value.replace(/^ws:/i, 'http:');
    if (/^https?:\/\//i.test(value)) return value;
    return '';
  }

  function normalizeWsUrl(url) {
    if (typeof url !== 'string') return '';
    var value = url.trim().replace(/\/+$/, '');
    if (/^https:\/\//i.test(value)) return value.replace(/^https:/i, 'wss:');
    if (/^http:\/\//i.test(value)) return value.replace(/^http:/i, 'ws:');
    if (/^wss?:\/\//i.test(value)) return value;
    return '';
  }

  function unique(list) {
    return list.filter(function (item, index) {
      return item && list.indexOf(item) === index;
    });
  }

  function toArray(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' && value.trim()) return [value.trim()];
    return [];
  }

  async function sha256(message) {
    if (!subtle) throw new Error('WebCrypto indisponível. Use HTTPS ou localhost.');
    var digest = await subtle.digest('SHA-256', encoder.encode(String(message)));
    return bytesToHex(new Uint8Array(digest));
  }

  var READER_PREFIX = 'onpostt-read-v1:';

  /**
   * Gera um token de leitura assinado. O relay usa a pubkey para aplicar as
   * regras de bloqueio sem confiar em um viewer enviado sem prova.
   */
  async function createReaderToken(privateKey) {
    if (!isValidPrivateKey(privateKey)) throw new Error('Chave privada inválida.');
    if (!subtle) throw new Error('WebCrypto indisponível. Use HTTPS ou localhost.');

    var viewer = publicKeyOf(privateKey).toLowerCase();
    var createdAt = Math.floor(Date.now() / 1000);
    var message = READER_PREFIX + viewer + ':' + createdAt;
    var msgHash = await sha256(message);
    var signature = ec.keyFromPrivate(privateKey, 'hex').sign(msgHash).toDER('hex');

    return {
      viewer: viewer,
      created_at: createdAt,
      sig: signature,
    };
  }

  function safeParse(value) {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch (error) {
      return value;
    }
  }

  function queryValue(block, key) {
    if (!block || !Array.isArray(block.query)) return undefined;
    for (var i = 0; i < block.query.length; i += 1) {
      if (Array.isArray(block.query[i]) && block.query[i][0] === key) return block.query[i][1];
    }
    return undefined;
  }

  var TOPIC_RE = /^[a-z0-9](?:[a-z0-9._-]{0,48}[a-z0-9])?$/;
  var TOPIC_CONTROL_RE = /[\u0000-\u001F\u007F\u2028\u2029]/;

  /**
   * Mesmo slug canônico usado pelo relay. O cliente normaliza a entrada do
   * usuário; o relay só aceita o valor já canônico no bloco assinado.
   */
  function normalizeTopic(value) {
    if (typeof value !== 'string' || TOPIC_CONTROL_RE.test(value)) return '';
    var topic = value.trim().toLowerCase();
    if (topic.charAt(0) === '#') topic = topic.slice(1);

    try {
      topic = topic.normalize('NFD').replace(/[\u0300-\u036F]/g, '');
    } catch (error) {
      /* mantém o texto original em motores sem normalize */
    }

    topic = topic
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-._]+|[-._]+$/g, '');

    if (topic.length > 50) topic = topic.slice(0, 50).replace(/[-._]+$/g, '');
    return TOPIC_RE.test(topic) ? topic : '';
  }

  function blockTopics(block) {
    if (!block || block.mode !== 'post') return [];
    var topics = [];
    var seen = Object.create(null);

    function add(value) {
      var topic = normalizeTopic(value);
      if (!topic || seen[topic]) return;
      seen[topic] = true;
      topics.push(topic);
    }

    if (
      block.content &&
      typeof block.content === 'object' &&
      !Array.isArray(block.content) &&
      Array.isArray(block.content.topics)
    ) {
      block.content.topics.forEach(add);
    }

    if (Array.isArray(block.query)) {
      block.query.forEach(function (pair) {
        if (Array.isArray(pair) && pair[0] === 'topic') add(pair[1]);
      });
    }

    return topics;
  }

  function eqHex(a, b) {
    return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  }

  function logicalBlockId(block) {
    if (!block || typeof block.id !== 'string') return '';
    return block.id.replace(/_rcp$/i, '');
  }

  function markTruncated(blocks, truncated) {
    Object.defineProperty(blocks, 'truncated', {
      value: Boolean(truncated),
      enumerable: false,
      configurable: true,
    });
    return blocks;
  }

  function modeOf(block) {
    return block && typeof block.mode === 'string' ? block.mode : '';
  }

  function isForbiddenKey(key) {
    if (typeof key !== 'string') return false;
    var lower = key.toLowerCase();
    return lower === 'privatekey' || ['__proto__', 'constructor', 'prototype'].includes(lower);
  }

  /* ---------------------------------------------------------------------- */
  /* Imagens (navegador)                                                    */
  /* ---------------------------------------------------------------------- */

  function loadImageSource(file) {
    if (typeof root.createImageBitmap === 'function') {
      return root
        .createImageBitmap(file, { imageOrientation: 'from-image' })
        .catch(function () {
          return root.createImageBitmap(file);
        });
    }

    var URLImpl = root.URL;
    var ImageImpl = root.Image;
    if (!URLImpl || typeof URLImpl.createObjectURL !== 'function' || typeof ImageImpl !== 'function') {
      return Promise.reject(new Error('Navegador sem suporte a redimensionamento de imagens.'));
    }

    return new Promise(function (resolve, reject) {
      var url = URLImpl.createObjectURL(file);
      var image = new ImageImpl();
      image.onload = function () {
        URLImpl.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = function () {
        URLImpl.revokeObjectURL(url);
        reject(new Error('Não foi possível abrir a imagem.'));
      };
      image.src = url;
    });
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise(function (resolve, reject) {
      if (typeof canvas.toBlob !== 'function') {
        reject(new Error('Navegador sem suporte a canvas.toBlob.'));
        return;
      }
      try {
        canvas.toBlob(
          function (blob) {
            if (blob) resolve(blob);
            else reject(new Error('Não foi possível converter a imagem.'));
          },
          mime,
          quality
        );
      } catch (error) {
        reject(error);
      }
    });
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var Reader = root.FileReader;
      if (typeof Reader !== 'function') {
        reject(new Error('Navegador sem suporte a FileReader.'));
        return;
      }
      var reader = new Reader();
      reader.onload = function () {
        var result = String(reader.result || '');
        var comma = result.indexOf(',');
        if (comma < 0) {
          reject(new Error('Não foi possível codificar a imagem.'));
          return;
        }
        resolve(result.slice(comma + 1));
      };
      reader.onerror = function () {
        reject(new Error('Não foi possível ler a imagem.'));
      };
      reader.readAsDataURL(blob);
    });
  }

  async function prepareImageFile(file, options) {
    var settings = isPlainObject(options) ? options : {};
    var maxDimension = settings.maxDimension === undefined ? 500 : settings.maxDimension;
    var maxBytes = settings.maxBytes === undefined ? 64 * 1024 : settings.maxBytes;
    var maxSourceBytes =
      settings.maxSourceBytes === undefined ? 12 * 1024 * 1024 : settings.maxSourceBytes;
    var outputMime = settings.mime === undefined ? 'image/jpeg' : settings.mime;

    if (!Number.isInteger(maxDimension) || maxDimension < 16 || maxDimension > 2048) {
      throw new Error('maxDimension deve ser um inteiro entre 16 e 2048.');
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 16 * 1024 * 1024) {
      throw new Error('maxBytes deve ser um inteiro entre 1024 e 16 MiB.');
    }
    if (!Number.isInteger(maxSourceBytes) || maxSourceBytes < 1024) {
      throw new Error('maxSourceBytes inválido.');
    }
    if (outputMime !== 'image/jpeg' && outputMime !== 'image/png') {
      throw new Error('mime de saída deve ser image/jpeg ou image/png.');
    }
    if (!file || typeof file.type !== 'string' || !/^image\/(jpeg|png)$/i.test(file.type)) {
      throw new Error('Escolha uma imagem JPEG ou PNG.');
    }
    if (typeof file.size === 'number' && file.size > maxSourceBytes) {
      throw new Error('A imagem original é grande demais.');
    }
    if (!root.document || typeof root.document.createElement !== 'function') {
      throw new Error('prepareImage exige um navegador com canvas.');
    }

    var source = await loadImageSource(file);
    var sourceWidth = source.width || source.naturalWidth || 0;
    var sourceHeight = source.height || source.naturalHeight || 0;
    if (!sourceWidth || !sourceHeight) {
      if (typeof source.close === 'function') source.close();
      throw new Error('A imagem não tem dimensões válidas.');
    }

    var scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
    var width = Math.max(1, Math.round(sourceWidth * scale));
    var height = Math.max(1, Math.round(sourceHeight * scale));

    var canvas = root.document.createElement('canvas');
    var context = canvas.getContext('2d');
    if (!context) {
      if (typeof source.close === 'function') source.close();
      throw new Error('Navegador sem suporte a canvas 2D.');
    }

    var qualities = [0.82, 0.72, 0.62, 0.52, 0.42, 0.32];
    var blob = null;

    try {
      for (var attempt = 0; attempt < 16 && !blob; attempt += 1) {
        canvas.width = width;
        canvas.height = height;
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(source, 0, 0, width, height);

        for (var i = 0; i < qualities.length; i += 1) {
          var candidate = await canvasToBlob(
            canvas,
            outputMime,
            outputMime === 'image/jpeg' ? qualities[i] : undefined
          );
          if (candidate.size <= maxBytes) {
            blob = candidate;
            break;
          }
        }

        if (!blob) {
          if (width <= 1 && height <= 1) break;
          width = Math.max(1, Math.round(width * 0.75));
          height = Math.max(1, Math.round(height * 0.75));
        }
      }
    } finally {
      if (typeof source.close === 'function') source.close();
    }

    if (!blob) throw new Error('A imagem continua grande demais após a compressão.');

    return {
      mime: outputMime,
      data: await blobToBase64(blob),
      width: width,
      height: height,
      bytes: blob.size,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Filtros                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Valida o filtro e garante que nenhuma chave privada seja enviada ao relay.
   */
  function sanitizeFilter(input) {
    if (!isPlainObject(input)) throw new Error('Filtro deve ser um objeto.');
    var filter = JSON.parse(JSON.stringify(input));

    Object.keys(filter).forEach(function (key) {
      if (isForbiddenKey(key)) {
        throw new Error(
          'Campo reservado "' +
            key +
            '" é proibido em filtros. Derive a pubkey localmente e envie apenas "pubkey".'
        );
      }
    });

    if (Array.isArray(filter.query)) {
      filter.query.forEach(function (pair) {
        if (Array.isArray(pair) && isForbiddenKey(pair[0])) {
          throw new Error('A query do filtro contém uma chave reservada.');
        }
      });
    }

    if (typeof filter.mode !== 'string' || !filter.mode) {
      throw new Error('Filtro precisa de "mode".');
    }

    if (filter.topic !== undefined && filter.topic !== null) {
      if (filter.mode !== 'post') throw new Error('Campo "topic" só é aceito em filtros de post.');
      var topic = normalizeTopic(filter.topic);
      if (!topic) throw new Error('Campo "topic" inválido.');
      filter.topic = topic;
    }

    return filter;
  }

  function matchesFilter(block, filter) {
    if (!block || block.mode !== filter.mode) return false;
    if (filter.id && block.id !== filter.id) return false;
    if (filter.app && block.app !== filter.app) return false;
    if (filter.since !== undefined && block.created_at < filter.since) return false;
    if (filter.until !== undefined && block.created_at > filter.until) return false;

    if (filter.pubkey) {
      if (block.mode === 'message') {
        var from = queryValue(block, 'from');
        var to = queryValue(block, 'to');
        if (!eqHex(from, filter.pubkey) && !eqHex(to, filter.pubkey)) return false;
      } else if (!eqHex(block.pubkey, filter.pubkey)) {
        return false;
      }
    }

    if (filter.topic && blockTopics(block).indexOf(filter.topic) === -1) return false;

    if (Array.isArray(filter.query)) {
      for (var i = 0; i < filter.query.length; i += 1) {
        var pair = filter.query[i];
        if (!Array.isArray(pair) || pair.length !== 2) return false;
        var found = Array.isArray(block.query) && block.query.some(function (candidate) {
          return Array.isArray(candidate) && candidate[0] === pair[0] && candidate[1] === pair[1];
        });
        if (!found) return false;
      }
    }

    return true;
  }

  /* ---------------------------------------------------------------------- */
  /* Criptografia                                                           */
  /* ---------------------------------------------------------------------- */

  async function importAesKey(sharedSecretHex, usage) {
    var digest = await subtle.digest('SHA-256', encoder.encode(sharedSecretHex));
    return subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, [usage]);
  }

  async function encryptFor(publicKeyHex, plaintext, ephemeralKey) {
    var receiverKey = ec.keyFromPublic(publicKeyHex, 'hex');
    var sharedSecret = ephemeralKey.derive(receiverKey.getPublic()).toString(16);
    var aesKey = await importAesKey(sharedSecret, 'encrypt');
    var iv = root.crypto.getRandomValues(new Uint8Array(12));
    var ciphertext = await subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      aesKey,
      encoder.encode(plaintext)
    );

    return {
      ciphertext: bytesToHex(new Uint8Array(ciphertext)),
      iv: bytesToHex(iv),
      senderPubKey: ephemeralKey.getPublic(true, 'hex'),
    };
  }

  /**
   * Cifra uma mensagem para o destinatário e para o remetente.
   *
   * Cada envio usa uma chave efêmera (ECDH + AES-256-GCM). O envelope
   * resultante contém `forRecipient` e `forSender`.
   */
  async function encryptMessage(receiverPubKeyHex, senderPubKeyHex, message) {
    if (!subtle) throw new Error('WebCrypto indisponível.');
    if (typeof message !== 'string') throw new Error('Mensagem deve ser uma string.');

    if (!isValidPublicKey(receiverPubKeyHex)) {
      throw new Error('Chave pública do destinatário inválida.');
    }
    if (!isValidPublicKey(senderPubKeyHex)) {
      throw new Error('Chave pública do remetente inválida.');
    }

    var ephemeral = ec.genKeyPair();
    var payload = {};

    payload.forRecipient = await encryptFor(receiverPubKeyHex, message, ephemeral);
    payload.forSender = await encryptFor(senderPubKeyHex, message, ephemeral);

    return payload;
  }

  async function tryDecryptPart(receiverKey, part) {
    if (!isPlainObject(part)) return null;
    if (typeof part.ciphertext !== 'string' || typeof part.iv !== 'string') return null;
    if (!isValidPublicKey(part.senderPubKey)) return null;

    var senderKey = ec.keyFromPublic(part.senderPubKey, 'hex');
    var sharedSecret = receiverKey.derive(senderKey.getPublic()).toString(16);
    var aesKey = await importAesKey(sharedSecret, 'decrypt');
    var plaintext = await subtle.decrypt(
      { name: 'AES-GCM', iv: hexToBytes(part.iv) },
      aesKey,
      hexToBytes(part.ciphertext)
    );

    return decoder.decode(plaintext);
  }

  function messageContent(block) {
    if (!block) return null;
    return safeParse(block.content);
  }

  async function decryptMessage(privateKeyHex, blocks) {
    if (!isValidPrivateKey(privateKeyHex)) throw new Error('Chave privada inválida.');
    if (!subtle) throw new Error('WebCrypto indisponível.');

    var list = Array.isArray(blocks) ? blocks : [blocks];
    var block = list.find(function (candidate) {
      return candidate && modeOf(candidate) === 'message';
    }) || list[0];

    var content = messageContent(block);
    if (!isPlainObject(content)) throw new Error('Conteúdo cifrado inválido.');

    var receiverKey = ec.keyFromPrivate(privateKeyHex, 'hex');
    var parts = ['forRecipient', 'forSender'];

    for (var i = 0; i < parts.length; i += 1) {
      if (!content[parts[i]]) continue;
      try {
        var result = await tryDecryptPart(receiverKey, content[parts[i]]);
        if (result !== null) return result;
      } catch (error) {
        /* tenta a outra parte */
      }
    }

    throw new Error('Não foi possível descriptografar com esta chave privada.');
  }

  async function decryptMessages(privateKeyHex, blocks) {
    if (!Array.isArray(blocks)) throw new Error('blocks deve ser um array.');
    return Promise.all(
      blocks.map(async function (block) {
        try {
          return await decryptMessage(privateKeyHex, block);
        } catch (error) {
          return null;
        }
      })
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Objeto público                                                         */
  /* ---------------------------------------------------------------------- */

  var onpostt = {
    ec: ec,
    modes_list: MODES_HTTP.slice(),
    modes_sub: MODES_WS.slice(),
    hosts: [],
    sockets: [],
    isConnected: false,
    callbacksQueue: [],
    serverInfo: null,

    _connections: new Map(),
    _subscriptions: new Map(),
    _pending: new Map(),
    _listeners: new Map(),
    _shouldReconnect: true,
    _seq: 0,
    _reader: null,
    _readerReady: Promise.resolve(null),

    /* ---------------------------- eventos ---------------------------- */

    on: function (event, handler) {
      if (typeof handler !== 'function') return function () {};
      if (!this._listeners.has(event)) this._listeners.set(event, new Set());
      this._listeners.get(event).add(handler);
      var self = this;
      return function () {
        self.off(event, handler);
      };
    },

    off: function (event, handler) {
      var set = this._listeners.get(event);
      if (!set) return;
      if (handler) set.delete(handler);
      else set.clear();
    },

    once: function (event, handler) {
      var self = this;
      var unsubscribe = this.on(event, function (payload) {
        unsubscribe();
        handler(payload);
      });
      return unsubscribe;
    },

    emit: function (event, payload) {
      var set = this._listeners.get(event);
      if (!set) return;
      set.forEach(function (handler) {
        try {
          handler(payload);
        } catch (error) {
          if (root.console) root.console.error('[onpostt] listener falhou:', error);
        }
      });
    },

    /* ---------------------------- helpers ---------------------------- */

    sha256: sha256,
    isValidPublicKey: isValidPublicKey,
    isValidPrivateKey: isValidPrivateKey,
    isValidReaction: isValidReaction,
    sanitizeFilter: sanitizeFilter,
    prepareImage: prepareImageFile,
    hexToBytes: hexToBytes,
    buf2hex: function (buffer) {
      return bytesToHex(new Uint8Array(buffer));
    },

    isValidJsonObject: function (value) {
      try {
        JSON.stringify(value);
        return true;
      } catch (error) {
        return false;
      }
    },

    isValidModeList: function (mode) {
      return this.modes_list.includes(mode);
    },

    isValidModeSub: function (mode) {
      return this.modes_sub.includes(mode);
    },

    verificarHost: function (list, type) {
      if (!Array.isArray(list) || typeof type !== 'string') return { host: false, url: '' };
      var prefix = type.toLowerCase() + '://';
      var found = list.find(function (url) {
        return typeof url === 'string' && url.toLowerCase().startsWith(prefix);
      });
      return found ? { host: true, url: found } : { host: false, url: '' };
    },

    convertHostsWS: function (list) {
      return unique(toArray(list).map(normalizeWsUrl));
    },

    convertHostsHTTP: function (list) {
      return unique(toArray(list).map(normalizeHttpUrl));
    },

    /* ---------------------------- chaves ----------------------------- */

    generateKeys: function () {
      var keyPair = ec.genKeyPair();
      return {
        privateKey: keyPair.getPrivate('hex').padStart(64, '0'),
        publicKey: keyPair.getPublic(true, 'hex'),
      };
    },

    generateKeysCustom: async function (input) {
      if (typeof input !== 'string' || !input) throw new Error('Entrada inválida.');
      var counter = 0;
      while (counter < 10) {
        var material = counter === 0 ? input : input + ':' + counter;
        var hashHex = await sha256(material);
        try {
          var keyPair = ec.keyFromPrivate(hashHex, 'hex');
          return {
            privateKey: keyPair.getPrivate('hex').padStart(64, '0'),
            publicKey: keyPair.getPublic(true, 'hex'),
          };
        } catch (error) {
          counter += 1;
        }
      }
      throw new Error('Não foi possível derivar uma chave válida.');
    },

    generatePublicKey: function (privateKey) {
      try {
        return publicKeyOf(privateKey);
      } catch (error) {
        return 'Chave privada inválida.';
      }
    },

    /**
     * Define a chave usada para assinar leituras. Sem ela, as consultas são
     * anônimas: o relay continua funcionando, mas esconde autores que
     * participam de bloqueios ativos.
     *
     * Retorna uma Promise com o token; `list` e `sub` aguardam internamente.
     */
    setReaderKey: function (privateKey) {
      var self = this;

      if (privateKey === undefined || privateKey === null || privateKey === '') {
        this._reader = null;
        this._readerReady = Promise.resolve(null);
        this._resubscribeAll();
        return this._readerReady;
      }

      if (!isValidPrivateKey(privateKey)) {
        throw new Error('Chave privada inválida para leitura.');
      }

      this._reader = null;
      this._readerReady = createReaderToken(privateKey)
        .then(function (token) {
          self._reader = token;
          self._resubscribeAll();
          return token;
        })
        .catch(function (error) {
          self._reader = null;
          self.emit('error', { type: 'reader', error: error });
          return null;
        });

      return this._readerReady;
    },

    getReaderToken: function () {
      return this._reader;
    },

    createReaderToken: createReaderToken,

    verifySignature: async function (publicKeyHex, message, signature) {
      try {
        if (!isValidPublicKey(publicKeyHex)) return false;
        var key = ec.keyFromPublic(publicKeyHex, 'hex');
        var msgHash = await sha256(message);
        return key.verify(msgHash, signature);
      } catch (error) {
        return false;
      }
    },

    /* --------------------------- assinatura -------------------------- */

    /**
     * Assina um bloco. Ordem canônica:
     * pubkey, created_at, mode, query, content, app, [campos extras], id, sig.
     *
     * Erros estruturais retornam uma string e não modificam o bloco.
     */
    signBlock: async function (block, privateKey) {
      if (!isPlainObject(block)) return 'Bloco inválido.';
      if (!isValidPrivateKey(privateKey)) return 'Chave privada inválida.';
      if (Object.keys(block).some(isForbiddenKey)) {
        return 'Bloco contém um campo reservado.';
      }

      var pubkey = publicKeyOf(privateKey);
      var query = Array.isArray(block.query) ? block.query.map(function (pair) {
        return Array.isArray(pair) ? [pair[0], pair[1]] : pair;
      }) : [];
      if (query.some(function (pair) {
        return Array.isArray(pair) && isForbiddenKey(pair[0]);
      })) {
        return 'A query contém uma chave reservada.';
      }
      var content = block.content;

      if (block.mode === 'message') {
        var from = null;
        var to = null;
        query.forEach(function (pair) {
          if (pair[0] === 'from') from = pair[1];
          if (pair[0] === 'to') to = pair[1];
        });
        if (!from || !to) return 'Campos from/to obrigatórios em query.';
        if (!eqHex(from, pubkey)) return 'Campo "from" deve ser igual à pubkey do autor.';
        if (typeof content !== 'string') return 'Conteúdo de mensagem deve ser texto.';

        try {
          var encrypted = await encryptMessage(to, pubkey, content);
          content = JSON.stringify(encrypted);
        } catch (error) {
          return 'Falha ao cifrar mensagem: ' + error.message;
        }
      }

      if (block.mode === 'reaction') {
        var reaction = null;
        query.forEach(function (pair) {
          if (pair[0] === 'reaction') reaction = pair[1];
        });
        if (!isValidReaction(reaction)) {
          return 'Campo "reaction" deve ser um emoji de 1 a 32 caracteres.';
        }
      }

      if (block.mode === 'delete') {
        var target = null;
        query.forEach(function (pair) {
          if (pair[0] === 'block') target = pair[1];
        });
        if (!target) return 'Campo "block" ausente em query.';
        content = 'Block [' + target + '] has been marked as deleted.';
      }

      if (block.mode === 'block') {
        var blocker = null;
        var blocked = null;
        query.forEach(function (pair) {
          if (pair[0] === 'blocker') blocker = pair[1];
          if (pair[0] === 'blocked') blocked = pair[1];
        });
        if (!blocker || !blocked) return 'Campos blocker/blocked obrigatórios em query.';
        if (!eqHex(blocker, pubkey)) return 'Campo "blocker" deve ser igual à pubkey do autor.';
        if (!isValidPublicKey(blocked)) return 'Campo "blocked" deve ser uma pubkey válida.';
        if (eqHex(blocker, blocked)) return 'Um usuário não pode bloquear a si mesmo.';
      }

      if (block.mode === 'notification') {
        var notificationTo = null;
        var notificationTarget = null;
        var notificationInteraction = null;
        var notificationKind = null;
        query.forEach(function (pair) {
          if (pair[0] === 'to') notificationTo = pair[1];
          if (pair[0] === 'block') notificationTarget = pair[1];
          if (pair[0] === 'interaction') notificationInteraction = pair[1];
          if (pair[0] === 'kind') notificationKind = pair[1];
        });

        if (!notificationTo || !notificationTarget || !notificationInteraction || !notificationKind) {
          return 'Notification exige to, block, interaction e kind.';
        }
        if (!['like', 'reaction', 'comment', 'repost', 'follow'].includes(notificationKind)) {
          return 'Campo "kind" inválido para notification.';
        }
        if (eqHex(notificationTo, pubkey)) {
          return 'Não é possível notificar a própria pubkey.';
        }
        if (content !== undefined && content !== null) {
          return 'Notification não aceita content.';
        }
      }

      if (block.mode === 'notification_read') {
        if (!isPlainObject(content)) {
          return 'Confirmação de leitura deve ter conteúdo objeto.';
        }
        var readKeys = Object.keys(content);
        if (readKeys.length !== 1 || readKeys[0] !== 'read') {
          return 'Confirmação de leitura aceita apenas o campo "read".';
        }
        if (!Array.isArray(content.read) || content.read.length === 0) {
          return 'Campo "read" deve ser uma lista não vazia.';
        }
        if (content.read.length > 500) {
          return 'Campo "read" aceita no máximo 500 notificações.';
        }
        var readSeen = {};
        for (var readIndex = 0; readIndex < content.read.length; readIndex += 1) {
          var readId = content.read[readIndex];
          if (!isValidBlockId(readId)) {
            return 'Campo "read" contém um id de notificação inválido.';
          }
          var readKey = readId.toLowerCase();
          if (readSeen[readKey]) {
            return 'Campo "read" contém ids duplicados.';
          }
          readSeen[readKey] = true;
        }
        if (query.length) {
          return 'Confirmação de leitura não aceita query.';
        }
      }

      if (block.mode === 'message_read') {
        if (!isPlainObject(content)) {
          return 'Confirmação de leitura de mensagens deve ter conteúdo objeto.';
        }
        var messageReadKeys = Object.keys(content);
        if (messageReadKeys.length !== 1 || messageReadKeys[0] !== 'read') {
          return 'Confirmação de leitura de mensagens aceita apenas o campo "read".';
        }
        if (!Array.isArray(content.read) || content.read.length === 0) {
          return 'Campo "read" deve ser uma lista não vazia.';
        }
        if (content.read.length > 500) {
          return 'Campo "read" aceita no máximo 500 mensagens.';
        }
        var messageReadSeen = {};
        for (var messageReadIndex = 0; messageReadIndex < content.read.length; messageReadIndex += 1) {
          var messageReadId = content.read[messageReadIndex];
          if (!isValidBlockId(messageReadId)) {
            return 'Campo "read" contém um id de mensagem inválido.';
          }
          var messageReadKey = messageReadId.toLowerCase();
          if (messageReadSeen[messageReadKey]) {
            return 'Campo "read" contém ids duplicados.';
          }
          messageReadSeen[messageReadKey] = true;
        }
        if (query.length) {
          return 'Confirmação de leitura não aceita query.';
        }
      }

      if (['post', 'profile', 'comment', 'notification_read', 'message_read'].includes(block.mode) && (content === undefined || content === null)) {
        return 'Campo "content" ausente.';
      }

      if (block.mode === 'comment' && typeof content !== 'string') {
        return 'Comentário deve ter conteúdo em texto.';
      }

      var ordered = {
        pubkey: pubkey,
        created_at: Math.floor(Date.now() / 1000),
        mode: block.mode,
        query: query,
      };

      if (content !== undefined) ordered.content = content;
      if (block.app !== undefined) ordered.app = block.app;

      if (
        content === undefined &&
        ['like', 'reaction', 'repost', 'follow', 'block'].includes(block.mode) &&
        block.nonce === undefined
      ) {
        ordered.nonce = randomNonce();
      }

      var known = ['pubkey', 'created_at', 'mode', 'query', 'content', 'app', 'id', 'sig'];
      Object.keys(block).forEach(function (key) {
        if (known.includes(key)) return;
        ordered[key] = block[key];
      });

      var id = await sha256(JSON.stringify(ordered));
      ordered.id = id;
      var signedText = JSON.stringify(ordered);

      var keyPair = ec.keyFromPrivate(privateKey, 'hex');
      var msgHash = await sha256(signedText);
      var signature = keyPair.sign(msgHash).toDER('hex');
      ordered.sig = signature;

      var verified = await this.verifySignature(pubkey, signedText, signature);
      if (!verified) return 'Falha na validação da assinatura.';

      Object.keys(block).forEach(function (key) {
        delete block[key];
      });
      Object.assign(block, ordered);
      return block;
    },

    /* --------------------------- transporte -------------------------- */

    connect: function (servers) {
      var input = servers;
      if (Array.isArray(input)) input = { socket: input };
      if (!isPlainObject(input)) input = {};

      if (Object.prototype.hasOwnProperty.call(input, 'privateKey')) {
        this.setReaderKey(input.privateKey);
      }

      var hosts = unique(toArray(input.host || input.hosts).map(normalizeHttpUrl));
      var sockets = unique(toArray(input.socket || input.sockets).map(normalizeWsUrl));

      this.hosts = hosts;
      this._shouldReconnect = true;

      // Fecha conexões antigas, mas mantém assinaturas ativas.
      this._connections.forEach(function (entry) {
        if (entry.timer) clearTimeout(entry.timer);
        try {
          entry.ws.close(1000, 'Reconectando');
        } catch (error) {
          /* ignore */
        }
      });
      this._connections.clear();
      this.sockets = [];
      this.isConnected = false;

      var self = this;
      if (sockets.length === 0) {
        this.isConnected = true;
        this._flushQueue();
        return Promise.resolve(true);
      }

      sockets.forEach(function (url) {
        self._createSocket(url);
      });

      return new Promise(function (resolve) {
        var settled = false;
        var finish = function (value) {
          if (settled) return;
          settled = true;
          resolve(value);
        };

        var unsubscribe = self.on('open', function () {
          unsubscribe();
          finish(true);
        });

        setTimeout(function () {
          unsubscribe();
          finish(self.isConnected);
        }, 10000);
      });
    },

    createConnection: function (url, onConnected) {
      var self = this;
      this.connect({ socket: [url] }).then(function () {
        if (typeof onConnected === 'function') onConnected();
      });
      return self;
    },

    disconnect: function () {
      this._shouldReconnect = false;
      this._connections.forEach(function (entry) {
        if (entry.timer) clearTimeout(entry.timer);
        try {
          entry.ws.close(1000, 'Cliente desconectou');
        } catch (error) {
          /* ignore */
        }
      });
      this._connections.clear();
      this.sockets = [];
      this.isConnected = false;
      this._pending.forEach(function (pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Conexão encerrada.'));
      });
      this._pending.clear();
      this.emit('close', { reason: 'disconnect' });
    },

    _createSocket: function (url) {
      if (!root.WebSocket) {
        this.emit('error', { type: 'socket', message: 'WebSocket indisponível neste ambiente.' });
        return;
      }

      var self = this;
      var entry = { url: url, ws: null, attempts: 0, timer: null };
      this._connections.set(url, entry);

      var ws;
      try {
        ws = new root.WebSocket(url);
      } catch (error) {
        this.emit('error', { type: 'socket', url: url, message: 'Não foi possível abrir o WebSocket.' });
        this._scheduleReconnect(url);
        return;
      }

      entry.ws = ws;

      ws.onopen = function () {
        entry.attempts = 0;
        if (!self.sockets.includes(ws)) self.sockets.push(ws);
        self.isConnected = true;
        self.emit('open', { url: url });
        self._flushQueue();
        self._resubscribeAll();
      };

      ws.onmessage = function (event) {
        self._handleMessage(event.data);
      };

      ws.onerror = function () {
        self.emit('error', {
          type: 'socket',
          url: url,
          message: 'Erro na conexão WebSocket.',
        });
      };

      ws.onclose = function (event) {
        self.sockets = self.sockets.filter(function (candidate) {
          return candidate !== ws;
        });
        self.isConnected = self.sockets.some(isOpen);
        self.emit('close', {
          url: url,
          code: event && event.code,
          reason: event && event.reason,
        });
        if (self._shouldReconnect) self._scheduleReconnect(url);
      };
    },

    _scheduleReconnect: function (url) {
      if (!this._shouldReconnect) return;
      var entry = this._connections.get(url);
      if (!entry || entry.timer) return;

      entry.attempts += 1;
      var delay = Math.min(30000, 1000 * Math.pow(2, Math.min(entry.attempts, 5)));
      delay += Math.floor(Math.random() * 500);

      var self = this;
      entry.timer = setTimeout(function () {
        entry.timer = null;
        if (self._shouldReconnect) self._createSocket(url);
      }, delay);
      this.emit('reconnect', { url: url, delay: delay });
    },

    _flushQueue: function () {
      while (this.callbacksQueue.length > 0) {
        var callback = this.callbacksQueue.shift();
        try {
          callback();
        } catch (error) {
          this.emit('error', { type: 'queue', error: error });
        }
      }
    },

    _resubscribeAll: function () {
      var self = this;
      this._subscriptions.forEach(function (subscription) {
        self._sendSubscription(subscription);
      });
    },

    _sendSubscription: function (subscription) {
      var self = this;
      return this._readerReady
        .then(function (reader) {
          // A assinatura pode ter sido removida enquanto o token era gerado.
          if (!self._subscriptions.has(subscription.id)) return 0;
          var payload = {
            request: 'get_blocks_sub',
            subscription: subscription.id,
            filter: subscription.filter,
          };
          if (reader) payload.reader = reader;
          return self._send(payload);
        })
        .catch(function (error) {
          self.emit('error', { type: 'reader', error: error });
          return 0;
        });
    },

    _send: function (payload) {
      var sent = 0;
      var text = JSON.stringify(payload);
      this.sockets.forEach(function (socket) {
        if (!isOpen(socket)) return;
        try {
          socket.send(text);
          sent += 1;
        } catch (error) {
          /* socket será removido no close */
        }
      });
      return sent;
    },

    _requestOnSocket: function (socket, payload) {
      var self = this;
      var requestId = 'r' + Date.now().toString(36) + '_' + ++this._seq;
      var message = JSON.stringify(Object.assign({}, payload, { requestId: requestId }));

      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
          self._pending.delete(requestId);
          reject(new Error('Tempo esgotado aguardando o relay.'));
        }, 20000);

        self._pending.set(requestId, {
          resolve: resolve,
          reject: reject,
          timer: timer,
        });

        try {
          socket.send(message);
        } catch (error) {
          clearTimeout(timer);
          self._pending.delete(requestId);
          reject(error);
        }
      });
    },

    _handleMessage: function (raw) {
      var data;
      try {
        data = JSON.parse(raw);
      } catch (error) {
        this.emit('error', { type: 'parse', message: 'Resposta inválida do relay.' });
        return;
      }

      if (!isPlainObject(data)) return;
      this.emit('message', data);

      if (data.response === 'hello') {
        this.serverInfo = data;
        this.emit('hello', data);
        return;
      }

      if (data.response === 'pong') {
        if (data.requestId && this._pending.has(data.requestId)) {
          var pong = this._pending.get(data.requestId);
          clearTimeout(pong.timer);
          this._pending.delete(data.requestId);
          pong.resolve(data);
        }
        this.emit('pong', data);
        return;
      }

      if (data.requestId && this._pending.has(data.requestId)) {
        var pending = this._pending.get(data.requestId);
        clearTimeout(pending.timer);
        this._pending.delete(data.requestId);
        pending.resolve(data);
        return;
      }

      if (data.response === 'subscribed' || data.response === 'unsubscribed') {
        this.emit(data.response, data);
        return;
      }

      if (data.response === 'status') {
        this.emit('status', data);
        return;
      }

      if (data.response === 'blocks' && Array.isArray(data.blocks)) {
        this._dispatchBlocks(data);
        return;
      }

      if (data.status === 'erro') {
        this.emit('error', data);
      }
    },

    _dispatchBlocks: function (data) {
      if (!data.subscription) return;
      var known = this._subscriptions.get(data.subscription);
      if (!known) return;
      this._deliver(known, data);
    },

    _deliver: function (subscription, data) {
      var fresh = [];
      var seen = subscription.seen;

      data.blocks.forEach(function (block) {
        if (!block || typeof block.id !== 'string') return;
        if (!matchesFilter(block, subscription.filter)) return;
        if (seen.has(block.id)) return;
        seen.add(block.id);
        fresh.push(block);
      });

      // Limita o cache de dedupe por assinatura.
      if (seen.size > 5000) {
        var drop = seen.values().next().value;
        seen.delete(drop);
      }

      if (fresh.length === 0) return;

      var payload = {
        response: 'blocks',
        subscription: subscription.id,
        blocks: fresh,
        truncated: Boolean(data.truncated),
      };

      try {
        subscription.callback(payload);
      } catch (error) {
        this.emit('error', { type: 'callback', error: error });
      }
      this.emit('blocks', payload);
    },

    /* -------------------------- consulta/lista ----------------------- */

    list: async function (filters, callback) {
      if (typeof filters === 'function') {
        callback = filters;
        filters = {};
      }

      var filter;
      try {
        filter = sanitizeFilter(filters || {});
      } catch (error) {
        var invalid = {
          response: 'blocks',
          blocks: markTruncated([], false),
          truncated: false,
          error: error.message,
        };
        if (typeof callback === 'function') callback(invalid);
        return invalid.blocks;
      }

      var hosts = this.hosts.slice();
      if (hosts.length === 0) {
        var empty = {
          response: 'blocks',
          blocks: markTruncated([], false),
          truncated: false,
        };
        if (typeof callback === 'function') callback(empty);
        return empty.blocks;
      }

      var reader = await this._readerReady;
      var payloadFilter = Object.assign({}, filter);
      delete payloadFilter.reader;
      if (reader) payloadFilter.reader = reader;

      var self = this;
      var responses = await Promise.all(
        hosts.map(async function (host) {
          var controller = new AbortController();
          var timer = setTimeout(function () {
            controller.abort();
          }, 20000);

          try {
            var response = await fetch(host + '/get_blocks_list', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify(payloadFilter),
              credentials: 'omit',
              signal: controller.signal,
            });

            var body = await response.json().catch(function () {
              return null;
            });

            if (!response.ok) {
              var message = body && body.message ? body.message : 'HTTP ' + response.status;
              self.emit('error', { type: 'http', host: host, status: response.status, message: message });
              return { blocks: [], truncated: false };
            }

            return {
              blocks: body && Array.isArray(body.blocks) ? body.blocks : [],
              truncated: Boolean(body && body.truncated),
            };
          } catch (error) {
            self.emit('error', {
              type: 'http',
              host: host,
              message: error.name === 'AbortError' ? 'Tempo esgotado.' : error.message,
            });
            return { blocks: [], truncated: false };
          } finally {
            clearTimeout(timer);
          }
        })
      );

      var map = new Map();
      var truncated = false;
      responses.forEach(function (page) {
        if (page.truncated) truncated = true;
        page.blocks.forEach(function (block) {
          if (!block || typeof block.id !== 'string') return;
          var key = logicalBlockId(block);
          if (!map.has(key)) map.set(key, block);
        });
      });

      var merged = Array.from(map.values()).sort(function (a, b) {
        if (b.created_at !== a.created_at) return b.created_at - a.created_at;
        return String(b.id).localeCompare(String(a.id));
      });
      markTruncated(merged, truncated);

      var payload = { response: 'blocks', blocks: merged, truncated: truncated };
      if (typeof callback === 'function') callback(payload);
      return merged;
    },

    /* --------------------------- assinatura -------------------------- */

    sub: function (filters, callback) {
      if (typeof filters === 'function') {
        callback = filters;
        filters = {};
      }
      if (typeof callback !== 'function') throw new Error('Callback de assinatura obrigatório.');

      var filter;
      try {
        filter = sanitizeFilter(filters || {});
      } catch (error) {
        this.emit('error', { type: 'filter', message: error.message });
        return function () {};
      }

      var id = 'c' + ++this._seq;
      var subscription = {
        id: id,
        filter: filter,
        callback: callback,
        seen: new Set(),
        createdAt: Date.now(),
      };

      this._subscriptions.set(id, subscription);

      if (this.sockets.some(isOpen)) {
        this._sendSubscription(subscription);
      } else if (this._connections.size === 0 && this.hosts.length > 0) {
        // Sem socket configurado não há entrega em tempo real.
        this.emit('error', {
          type: 'subscription',
          message: 'Nenhum WebSocket conectado. Use connect({ socket: [...] }).',
        });
      }

      var self = this;
      var unsubscribe = function () {
        self.unsubscribe(id);
      };
      unsubscribe.subscription = id;
      return unsubscribe;
    },

    unsubscribe: function (subscriptionId) {
      var id = subscriptionId;
      if (typeof subscriptionId === 'function') id = subscriptionId.subscription;
      if (!id || !this._subscriptions.has(id)) return false;

      this._subscriptions.delete(id);
      this._send({ request: 'unsubscribe', subscription: id });
      return true;
    },

    /* ---------------------------- envio ------------------------------ */

    sendBlock: async function (block, callback) {
      var responses = [];
      var respond = function (response) {
        responses.push(response);
        if (typeof callback === 'function') {
          try {
            callback(response);
          } catch (error) {
            this.emit('error', { type: 'callback', error: error });
          }
        }
      }.bind(this);

      if (!isPlainObject(block)) {
        respond({ status: 'erro', message: 'Bloco inválido.' });
        return responses;
      }

      var unsigned = Object.assign({}, block);
      delete unsigned.sig;
      var valid = await this.verifySignature(block.pubkey, JSON.stringify(unsigned), block.sig);
      if (!valid) {
        respond({ status: 'erro', message: 'Assinatura inválida, bloco rejeitado.' });
        return responses;
      }

      var mode = modeOf(block);

      if (this.modes_list.includes(mode)) {
        if (this.hosts.length === 0) {
          respond({ status: 'erro', message: 'Nenhum host HTTP configurado.' });
          return responses;
        }

        var results = await Promise.all(
          this.hosts.map(async (host) => {
            var controller = new AbortController();
            var timer = setTimeout(function () {
              controller.abort();
            }, 20000);

            try {
              var response = await fetch(host + '/save_block', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify(block),
                credentials: 'omit',
                signal: controller.signal,
              });

              var body = await response.json().catch(function () {
                return null;
              });

              if (!body) {
                return {
                  status: 'erro',
                  message: 'Resposta inválida do relay (HTTP ' + response.status + ').',
                  host: host,
                };
              }

              return Object.assign({}, body, { host: host });
            } catch (error) {
              return {
                status: 'erro',
                message: error.name === 'AbortError' ? 'Tempo esgotado.' : error.message,
                host: host,
              };
            } finally {
              clearTimeout(timer);
            }
          })
        );

        results.forEach(respond);
        return responses;
      }

      if (this.modes_sub.includes(mode)) {
        var open = this.sockets.filter(isOpen);
        if (open.length === 0) {
          await this._waitForOpenSocket(10000);
          open = this.sockets.filter(isOpen);
        }

        if (open.length === 0) {
          respond({ status: 'erro', message: 'Nenhum WebSocket conectado.' });
          return responses;
        }

        var settled = await Promise.all(
          open.map(async function (socket) {
            try {
              return await this._requestOnSocket(socket, { request: 'save_block', block: block });
            } catch (error) {
              return { status: 'erro', message: error.message };
            }
          }, this)
        );

        settled.forEach(respond);
        return responses;
      }

      respond({ status: 'erro', message: 'Modo não suportado: ' + mode });
      return responses;
    },

    _waitForOpenSocket: function (timeoutMs) {
      var self = this;
      if (this.sockets.some(isOpen)) return Promise.resolve(true);
      if (this._connections.size === 0) return Promise.resolve(false);

      return new Promise(function (resolve) {
        var settled = false;
        var finish = function (value) {
          if (settled) return;
          settled = true;
          unsubscribe();
          resolve(value);
        };

        var unsubscribe = self.on('open', function () {
          finish(true);
        });

        setTimeout(function () {
          finish(self.sockets.some(isOpen));
        }, timeoutMs);
      });
    },

    /* -------------------------- criptografia ------------------------- */

    encryptMessage: encryptMessage,
    decryptMessage: decryptMessage,
    decryptMessages: decryptMessages,
  };

  return onpostt;
});
