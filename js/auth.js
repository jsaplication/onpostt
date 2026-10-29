'use strict';

/*
 * Autenticação local do demo onpostt.
 *
 * Não existe conta no relay: "entrar" significa desbloquear uma chave privada
 * que fica no navegador. A senha só é usada para cifrar o cofre exportável
 * (PBKDF2 + AES-256-GCM). Para manter a sessão entre fechamentos do navegador,
 * uma chave AES não exportável é guardada no IndexedDB e usada para selar uma
 * cópia local da identidade. Senha e chave privada em texto puro nunca são
 * gravadas em localStorage.
 */
(function (root) {
  var IDENTITY_KEY = 'onpostt.demo.identity';
  var NOTICE_KEY = 'onpostt.auth.notice';
  var DEVICE_REVOKED_KEY = 'onpostt.auth.device-revoked';
  var DB_NAME = 'onpostt-auth';
  var DB_VERSION = 1;
  var STORE_NAME = 'device';
  var DEVICE_ID = 'device';
  var VAULT_FORMAT = 'onpostt.identity.vault';
  var DEVICE_FORMAT = 'onpostt.device.session';
  var VAULT_MIME = 'application/json';
  var KDF_ITERATIONS = 600000;
  var KDF_MIN_ITERATIONS = 100000;
  var KDF_MAX_ITERATIONS = 2000000;
  var REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
  var REMEMBER_DAYS = 30;
  var MAX_VAULT_BYTES = 1024 * 1024;
  var MIN_PASSWORD = 10;
  var MAX_PASSWORD = 256;
  var USERNAME_MIN = 3;
  var USERNAME_MAX = 40;
  var encoder = new TextEncoder();
  var decoder = new TextDecoder();
  var channel = null;

  function getCrypto() {
    return root.crypto || null;
  }

  function subtle() {
    var cryptoObject = getCrypto();
    if (!cryptoObject || !cryptoObject.subtle) {
      throw new Error('WebCrypto indisponível. Use HTTPS ou localhost.');
    }
    return cryptoObject.subtle;
  }

  function randomBytes(length) {
    var cryptoObject = getCrypto();
    if (!cryptoObject || typeof cryptoObject.getRandomValues !== 'function') {
      throw new Error('Gerador criptográfico indisponível.');
    }
    var bytes = new Uint8Array(length);
    cryptoObject.getRandomValues(bytes);
    return bytes;
  }

  function bytesToBase64(bytes) {
    var binary = '';
    var chunkSize = 0x8000;
    for (var index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode.apply(
        null,
        bytes.subarray(index, Math.min(index + chunkSize, bytes.length))
      );
    }
    return root.btoa(binary);
  }

  function base64ToBytes(value) {
    if (typeof value !== 'string' || !value || value.length > MAX_VAULT_BYTES * 2) {
      throw new Error('Base64 inválido no cofre.');
    }
    var binary;
    try {
      binary = root.atob(value);
    } catch (error) {
      throw new Error('Base64 inválido no cofre.');
    }
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function encode(value) {
    return encoder.encode(String(value));
  }

  function decode(value) {
    return decoder.decode(value);
  }

  function normalizePrivateKey(value) {
    if (typeof value !== 'string') return '';
    return value
      .trim()
      .replace(/^0x/i, '')
      .replace(/\s+/g, '')
      .toLowerCase();
  }

  function isValidPrivateKey(privateKey) {
    if (root.onpostt && typeof root.onpostt.isValidPrivateKey === 'function') {
      return root.onpostt.isValidPrivateKey(privateKey);
    }
    return typeof privateKey === 'string' && /^[0-9a-f]{64}$/i.test(privateKey);
  }

  function isValidPublicKey(publicKey) {
    if (root.onpostt && typeof root.onpostt.isValidPublicKey === 'function') {
      return root.onpostt.isValidPublicKey(publicKey);
    }
    return typeof publicKey === 'string' && /^(02|03)[0-9a-f]{64}$/i.test(publicKey);
  }

  function derivePublicKey(privateKey) {
    if (!root.onpostt || typeof root.onpostt.generatePublicKey !== 'function') {
      throw new Error('Biblioteca onpostt não carregou.');
    }
    var publicKey = root.onpostt.generatePublicKey(privateKey);
    return isValidPublicKey(publicKey) ? publicKey : '';
  }

  function normalizeUsername(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
  }

  function validateUsername(value) {
    var username = normalizeUsername(value);
    if (username.length < USERNAME_MIN) {
      throw new Error('O nome de usuário deve ter pelo menos ' + USERNAME_MIN + ' caracteres.');
    }
    if (username.length > USERNAME_MAX) {
      throw new Error('O nome de usuário deve ter no máximo ' + USERNAME_MAX + ' caracteres.');
    }
    if (/[\u0000-\u001F\u007F]/.test(username)) {
      throw new Error('O nome de usuário contém caracteres inválidos.');
    }
    if (/[\/\\?%*:|"<>]/.test(username)) {
      throw new Error('O nome de usuário contém caracteres não permitidos.');
    }
    return username;
  }

  function validatePassword(value) {
    var password = String(value || '');
    if (password.length < MIN_PASSWORD) {
      throw new Error('A senha deve ter pelo menos ' + MIN_PASSWORD + ' caracteres.');
    }
    if (password.length > MAX_PASSWORD) {
      throw new Error('A senha deve ter no máximo ' + MAX_PASSWORD + ' caracteres.');
    }
    return password;
  }

  function defaultUsername(publicKey) {
    var key = typeof publicKey === 'string' ? publicKey : '';
    return 'anon-' + (key.replace(/^0x/, '').slice(0, 4) || '0000');
  }

  function normalizeIdentity(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    var privateKey = normalizePrivateKey(value.privateKey);
    if (!isValidPrivateKey(privateKey)) return null;

    var publicKey;
    try {
      publicKey = derivePublicKey(privateKey);
    } catch (error) {
      return null;
    }
    if (!publicKey) return null;

    if (value.publicKey && String(value.publicKey).toLowerCase() !== publicKey.toLowerCase()) {
      return null;
    }

    var username = typeof value.username === 'string' ? normalizeUsername(value.username) : '';
    if (username && username.length > 0) {
      try {
        username = validateUsername(username);
      } catch (error) {
        return null;
      }
    }

    var createdAt =
      typeof value.createdAt === 'string' && value.createdAt.length <= 40
        ? value.createdAt
        : new Date().toISOString();

    return {
      privateKey: privateKey,
      publicKey: publicKey,
      username: username,
      createdAt: createdAt,
    };
  }

  function setNotice(message) {
    try {
      if (message) root.sessionStorage.setItem(NOTICE_KEY, String(message));
      else root.sessionStorage.removeItem(NOTICE_KEY);
    } catch (error) {
      /* armazenamento indisponível */
    }
  }

  function consumeNotice() {
    try {
      var message = root.sessionStorage.getItem(NOTICE_KEY);
      if (message) root.sessionStorage.removeItem(NOTICE_KEY);
      return message || '';
    } catch (error) {
      return '';
    }
  }

  function markDeviceRevoked() {
    try {
      root.localStorage.setItem(DEVICE_REVOKED_KEY, String(Date.now()));
    } catch (error) {
      /* armazenamento indisponível */
    }
  }

  function clearDeviceRevoked() {
    try {
      root.localStorage.removeItem(DEVICE_REVOKED_KEY);
    } catch (error) {
      /* armazenamento indisponível */
    }
  }

  function isDeviceRevoked() {
    try {
      return Boolean(root.localStorage.getItem(DEVICE_REVOKED_KEY));
    } catch (error) {
      return false;
    }
  }

  function readSession() {
    try {
      var raw = root.sessionStorage.getItem(IDENTITY_KEY);
      if (!raw) return null;
      var identity = normalizeIdentity(JSON.parse(raw));
      if (!identity) {
        root.sessionStorage.removeItem(IDENTITY_KEY);
        return null;
      }
      return identity;
    } catch (error) {
      try {
        root.sessionStorage.removeItem(IDENTITY_KEY);
      } catch (storageError) {
        /* armazenamento indisponível */
      }
      return null;
    }
  }

  function writeSession(identity) {
    var normalized = normalizeIdentity(identity);
    if (!normalized) throw new Error('Identidade inválida.');
    try {
      root.sessionStorage.setItem(IDENTITY_KEY, JSON.stringify(normalized));
    } catch (error) {
      throw new Error('Não foi possível salvar a sessão neste navegador.');
    }
    try {
      root.localStorage.removeItem(IDENTITY_KEY);
    } catch (error) {
      /* armazenamento indisponível */
    }
    return normalized;
  }

  function clearSession() {
    try {
      root.sessionStorage.removeItem(IDENTITY_KEY);
    } catch (error) {
      /* armazenamento indisponível */
    }
    try {
      root.localStorage.removeItem(IDENTITY_KEY);
    } catch (error) {
      /* armazenamento indisponível */
    }
  }

  function openDatabase() {
    return new Promise(function (resolve, reject) {
      if (!root.indexedDB) {
        reject(new Error('IndexedDB indisponível neste navegador.'));
        return;
      }
      var request;
      try {
        request = root.indexedDB.open(DB_NAME, DB_VERSION);
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = function () {
        var database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = function () {
        resolve(request.result);
      };
      request.onerror = function () {
        reject(request.error || new Error('Falha ao abrir o armazenamento local.'));
      };
      request.onblocked = function () {
        reject(new Error('Armazenamento local bloqueado por outra aba.'));
      };
    });
  }

  function withStore(mode, operation) {
    return openDatabase().then(function (database) {
      return new Promise(function (resolve, reject) {
        var transaction;
        try {
          transaction = database.transaction(STORE_NAME, mode);
        } catch (error) {
          database.close();
          reject(error);
          return;
        }
        var store = transaction.objectStore(STORE_NAME);
        var request;
        try {
          request = operation(store);
        } catch (error) {
          database.close();
          reject(error);
          return;
        }
        transaction.oncomplete = function () {
          database.close();
          resolve(request ? request.result : undefined);
        };
        transaction.onerror = function () {
          database.close();
          reject(
            transaction.error ||
              (request && request.error) ||
              new Error('Falha no armazenamento local.')
          );
        };
        transaction.onabort = function () {
          database.close();
          reject(transaction.error || new Error('Operação local cancelada.'));
        };
      });
    });
  }

  function readDeviceRecord() {
    return withStore('readonly', function (store) {
      return store.get(DEVICE_ID);
    }).catch(function () {
      return null;
    });
  }

  function writeDeviceRecord(record) {
    return withStore('readwrite', function (store) {
      return store.put(record);
    });
  }

  function deleteDeviceRecord() {
    return withStore('readwrite', function (store) {
      return store.delete(DEVICE_ID);
    }).catch(function () {
      /* armazenamento indisponível ou já vazio */
    });
  }

  function deviceAad(publicKey, username) {
    return JSON.stringify([DEVICE_FORMAT, String(publicKey || '').toLowerCase(), username || '']);
  }

  function vaultAad(username, publicKey, createdAt) {
    return JSON.stringify([
      VAULT_FORMAT,
      username,
      String(publicKey || '').toLowerCase(),
      createdAt,
    ]);
  }

  async function derivePasswordKey(password, salt, iterations) {
    var webCrypto = subtle();
    var material = await webCrypto.importKey('raw', encode(password), 'PBKDF2', false, [
      'deriveKey',
    ]);
    return webCrypto.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: iterations,
        hash: 'SHA-256',
      },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function saveDevice(identity) {
    var normalized = normalizeIdentity(identity);
    if (!normalized) throw new Error('Identidade inválida.');
    var username = normalized.username || defaultUsername(normalized.publicKey);
    var webCrypto = subtle();
    var key = await webCrypto.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    var iv = randomBytes(12);
    var payload = JSON.stringify({
      privateKey: normalized.privateKey,
      publicKey: normalized.publicKey,
      username: username,
    });
    var ciphertext = await webCrypto.encrypt(
      {
        name: 'AES-GCM',
        iv: iv,
        additionalData: encode(deviceAad(normalized.publicKey, username)),
      },
      key,
      encode(payload)
    );

    var now = Date.now();
    var record = {
      id: DEVICE_ID,
      key: key,
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
      publicKey: normalized.publicKey,
      username: username,
      createdAt: normalized.createdAt,
      expiresAt: now + REMEMBER_MS,
      updatedAt: now,
    };
    await writeDeviceRecord(record);
    clearDeviceRevoked();
    return record;
  }

  async function restoreDevice() {
    if (isDeviceRevoked()) {
      await deleteDeviceRecord();
      return null;
    }

    var record = await readDeviceRecord();
    if (!record || record.revoked || !record.key || !record.publicKey || !record.iv || !record.ciphertext) {
      return null;
    }
    if (record.expiresAt && Number(record.expiresAt) <= Date.now()) {
      await deleteDeviceRecord();
      return null;
    }

    try {
      var webCrypto = subtle();
      var plain = await webCrypto.decrypt(
        {
          name: 'AES-GCM',
          iv: base64ToBytes(record.iv),
          additionalData: encode(
            deviceAad(record.publicKey, typeof record.username === 'string' ? record.username : '')
          ),
        },
        record.key,
        base64ToBytes(record.ciphertext)
      );
      var payload = JSON.parse(decode(plain));
      var identity = normalizeIdentity({
        privateKey: payload.privateKey,
        publicKey: payload.publicKey,
        username: payload.username,
        createdAt: record.createdAt,
      });
      if (!identity) throw new Error('Sessão local inválida.');
      if (identity.publicKey.toLowerCase() !== String(record.publicKey).toLowerCase()) {
        throw new Error('Sessão local não corresponde à chave.');
      }
      if ((identity.username || '') !== (record.username || '')) {
        throw new Error('Sessão local não corresponde ao usuário.');
      }

      record.expiresAt = Date.now() + REMEMBER_MS;
      record.updatedAt = Date.now();
      await writeDeviceRecord(record).catch(function () {
        /* a sessão em memória continua válida */
      });
      return writeSession(identity);
    } catch (error) {
      await deleteDeviceRecord();
      return null;
    }
  }

  async function ensureSession() {
    var identity = readSession();
    if (identity) return identity;
    return restoreDevice();
  }

  async function persistIdentity(identity, remember) {
    var normalized = writeSession(identity);
    var warning = '';

    if (remember) {
      try {
        await saveDevice(normalized);
      } catch (error) {
        markDeviceRevoked();
        warning =
          'A sessão funciona nesta aba, mas não foi possível mantê-la após fechar o navegador.';
        setNotice(warning);
      }
    } else {
      markDeviceRevoked();
      await deleteDeviceRecord();
    }

    return { identity: normalized, remembered: Boolean(remember && !warning), warning: warning };
  }

  async function loginWithIdentity(identity, remember) {
    return persistIdentity(identity, Boolean(remember));
  }

  async function loginWithPrivateKey(privateKey, username, remember) {
    var key = normalizePrivateKey(privateKey);
    if (!isValidPrivateKey(key)) {
      throw new Error('Chave privada inválida. Informe exatamente 64 caracteres hexadecimais.');
    }
    var publicKey = derivePublicKey(key);
    if (!publicKey) throw new Error('Não foi possível derivar a chave pública.');

    var normalizedUsername = '';
    if (normalizeUsername(username)) normalizedUsername = validateUsername(username);

    return persistIdentity(
      {
        privateKey: key,
        publicKey: publicKey,
        username: normalizedUsername,
        createdAt: new Date().toISOString(),
      },
      Boolean(remember)
    );
  }

  function parseVault(value) {
    var vault = value;
    if (typeof value === 'string') {
      try {
        vault = JSON.parse(value);
      } catch (error) {
        throw new Error('Arquivo de cofre inválido: JSON malformado.');
      }
    }
    if (!vault || typeof vault !== 'object' || Array.isArray(vault)) {
      throw new Error('Arquivo de cofre inválido.');
    }
    if (vault.format !== VAULT_FORMAT) {
      throw new Error('Este arquivo não é um cofre de identidade onpostt.');
    }
    if (vault.cipher !== 'AES-256-GCM') {
      throw new Error('Cifra do cofre não suportada.');
    }
    if (!vault.kdf || vault.kdf.name !== 'PBKDF2' || vault.kdf.hash !== 'SHA-256') {
      throw new Error('KDF do cofre não suportada.');
    }

    var iterations = Number(vault.kdf.iterations);
    if (
      !Number.isInteger(iterations) ||
      iterations < KDF_MIN_ITERATIONS ||
      iterations > KDF_MAX_ITERATIONS
    ) {
      throw new Error('Parâmetros de KDF inválidos.');
    }

    var salt = base64ToBytes(vault.kdf.salt);
    if (salt.length !== 16) throw new Error('Salt inválido no cofre.');
    var iv = base64ToBytes(vault.iv);
    if (iv.length !== 12) throw new Error('IV inválido no cofre.');
    var ciphertext = base64ToBytes(vault.ciphertext);
    if (!ciphertext.length || ciphertext.length > MAX_VAULT_BYTES) {
      throw new Error('Cifra inválida no cofre.');
    }

    var publicKey = String(vault.publicKey || '').toLowerCase();
    if (!isValidPublicKey(publicKey)) throw new Error('Chave pública inválida no cofre.');
    var username = validateUsername(vault.username);
    var createdAt =
      typeof vault.createdAt === 'string' && vault.createdAt.length <= 40
        ? vault.createdAt
        : '';

    return {
      format: VAULT_FORMAT,
      username: username,
      publicKey: publicKey,
      createdAt: createdAt,
      iterations: iterations,
      salt: salt,
      iv: iv,
      ciphertext: ciphertext,
    };
  }

  async function decryptParsedVault(vault, password) {
    var pass = String(password || '');
    if (!pass) throw new Error('Informe a senha do cofre.');

    var key = await derivePasswordKey(pass, vault.salt, vault.iterations);
    var plain;
    try {
      plain = await subtle().decrypt(
        {
          name: 'AES-GCM',
          iv: vault.iv,
          additionalData: encode(vaultAad(vault.username, vault.publicKey, vault.createdAt)),
        },
        key,
        vault.ciphertext
      );
    } catch (error) {
      throw new Error('Senha incorreta ou cofre corrompido.');
    }

    var payload;
    try {
      payload = JSON.parse(decode(plain));
    } catch (error) {
      throw new Error('Conteúdo do cofre inválido.');
    }
    if (!payload || typeof payload !== 'object') {
      throw new Error('Conteúdo do cofre inválido.');
    }
    if (
      String(payload.publicKey || '').toLowerCase() !== vault.publicKey ||
      normalizeUsername(payload.username) !== vault.username
    ) {
      throw new Error('O cofre não corresponde aos metadados do arquivo.');
    }

    var identity = normalizeIdentity({
      privateKey: payload.privateKey,
      publicKey: payload.publicKey,
      username: payload.username,
      createdAt: vault.createdAt,
    });
    if (!identity) throw new Error('Chave privada inválida no cofre.');
    return identity;
  }

  async function decryptVault(vaultValue, password) {
    return decryptParsedVault(parseVault(vaultValue), password);
  }

  async function createVault(identity, password) {
    var normalized = normalizeIdentity(identity);
    if (!normalized) throw new Error('Identidade inválida para exportação.');
    var username = validateUsername(normalized.username || defaultUsername(normalized.publicKey));
    var pass = validatePassword(password);
    var salt = randomBytes(16);
    var iterations = KDF_ITERATIONS;
    var iv = randomBytes(12);
    var createdAt = new Date().toISOString();
    var key = await derivePasswordKey(pass, salt, iterations);
    var payload = JSON.stringify({
      privateKey: normalized.privateKey,
      publicKey: normalized.publicKey,
      username: username,
    });
    var ciphertext = await subtle().encrypt(
      {
        name: 'AES-GCM',
        iv: iv,
        additionalData: encode(vaultAad(username, normalized.publicKey, createdAt)),
      },
      key,
      encode(payload)
    );

    return {
      format: VAULT_FORMAT,
      app: 'onpostt-demo',
      username: username,
      publicKey: normalized.publicKey,
      createdAt: createdAt,
      cipher: 'AES-256-GCM',
      kdf: {
        name: 'PBKDF2',
        hash: 'SHA-256',
        iterations: iterations,
        salt: bytesToBase64(salt),
      },
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
      warning: 'Cofre local do onpostt. A senha não está incluída. Não compartilhe.',
    };
  }

  async function readVaultFile(file) {
    if (!file || typeof file.size !== 'number' || file.size <= 0) {
      throw new Error('Selecione um arquivo de cofre.');
    }
    if (file.size > MAX_VAULT_BYTES) {
      throw new Error('Arquivo de cofre muito grande.');
    }
    var text;
    try {
      text = await file.text();
    } catch (error) {
      throw new Error('Não foi possível ler o arquivo.');
    }
    return parseVault(text);
  }

  async function loginWithFile(file, password, remember) {
    var vault = await readVaultFile(file);
    var identity = await decryptParsedVault(vault, password);
    return persistIdentity(identity, Boolean(remember));
  }

  function safeFilename(username) {
    var base = String(username || 'identidade')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
    return base || 'identidade';
  }

  function downloadVault(vault, username) {
    if (!vault || typeof vault !== 'object') throw new Error('Cofre inválido.');
    var blob = new root.Blob([JSON.stringify(vault, null, 2)], { type: VAULT_MIME });
    var url = root.URL.createObjectURL(blob);
    var link = root.document.createElement('a');
    link.href = url;
    link.download = 'onpostt-' + safeFilename(username || vault.username) + '.json';
    root.document.body.appendChild(link);
    link.click();
    link.remove();
    root.setTimeout(function () {
      root.URL.revokeObjectURL(url);
    }, 1000);
  }

  function nextUrl(fallback) {
    var target = fallback || '/';
    try {
      var value = new URLSearchParams(root.location.search).get('next');
      if (
        typeof value === 'string' &&
        value.charAt(0) === '/' &&
        value.charAt(1) !== '/' &&
        value.indexOf('\\') === -1
      ) {
        var path = value.split('?')[0].split('#')[0].toLowerCase();
        var authPaths = [
          '/login',
          '/entrar',
          '/login.html',
          '/cadastro',
          '/registrar',
          '/signup',
          '/cadastro.html',
        ];
        if (authPaths.indexOf(path) === -1) target = value;
      }
    } catch (error) {
      /* query string inválida */
    }
    return target;
  }

  async function redirectIfAuthenticated(target) {
    var identity = await ensureSession();
    if (identity) {
      root.location.replace(target || nextUrl('/'));
      return identity;
    }
    return null;
  }

  function ensureChannel() {
    if (channel || typeof root.BroadcastChannel !== 'function') return;
    try {
      channel = new root.BroadcastChannel('onpostt-auth');
    } catch (error) {
      channel = null;
      return;
    }
    channel.onmessage = function (event) {
      if (!event || !event.data || event.data.type !== 'logout') return;
      clearSession();
      if (event.data.notice) setNotice(event.data.notice);
      try {
        root.dispatchEvent(new root.Event('onpostt:logout'));
      } catch (error) {
        /* navegador sem CustomEvent/Event */
      }
    };
  }

  async function logout(options) {
    markDeviceRevoked();
    clearSession();
    await deleteDeviceRecord();
    if (options && options.notice) setNotice(options.notice);
    ensureChannel();
    if (channel) {
      try {
        channel.postMessage({
          type: 'logout',
          notice: options && options.notice ? options.notice : '',
        });
      } catch (error) {
        /* canal indisponível */
      }
    }
    try {
      root.dispatchEvent(new root.Event('onpostt:logout'));
    } catch (error) {
      /* navegador sem Event */
    }
  }

  ensureChannel();

  root.onposttAuth = {
    MIN_PASSWORD: MIN_PASSWORD,
    MAX_PASSWORD: MAX_PASSWORD,
    USERNAME_MIN: USERNAME_MIN,
    USERNAME_MAX: USERNAME_MAX,
    REMEMBER_DAYS: REMEMBER_DAYS,
    KDF_ITERATIONS: KDF_ITERATIONS,
    normalizePrivateKey: normalizePrivateKey,
    normalizeUsername: normalizeUsername,
    validateUsername: validateUsername,
    validatePassword: validatePassword,
    defaultUsername: defaultUsername,
    normalizeIdentity: normalizeIdentity,
    readSession: readSession,
    ensureSession: ensureSession,
    writeSession: writeSession,
    clearSession: clearSession,
    loginWithIdentity: loginWithIdentity,
    loginWithPrivateKey: loginWithPrivateKey,
    loginWithFile: loginWithFile,
    createVault: createVault,
    decryptVault: decryptVault,
    parseVault: parseVault,
    readVaultFile: readVaultFile,
    downloadVault: downloadVault,
    logout: logout,
    nextUrl: nextUrl,
    redirectIfAuthenticated: redirectIfAuthenticated,
    setNotice: setNotice,
    consumeNotice: consumeNotice,
  };
})(window);
