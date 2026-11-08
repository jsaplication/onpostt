/*!
 * onpostt · configuração dos relays
 *
 * Ponto único de configuração do front.
 *
 * 1. A lista RELAYS abaixo é o padrão do projeto. Para mudar o padrão,
 *    edite apenas este arquivo.
 * 2. O usuário também pode adicionar/remover relays direto pela interface
 *    (clique no status de conexão no topo). Essa lista fica salva no
 *    localStorage deste navegador.
 * 3. app.js e perfil.js usam este módulo para conectar, consultar e publicar.
 *
 * Cada item pode ser escrito com ou sem esquema:
 *   'https://meu-relay.exemplo.com'
 *   'meu-relay.exemplo.com'            -> https://
 *   'localhost:3000' / '127.0.0.1:3000' -> http://
 *   'wss://meu-relay.exemplo.com'      -> convertido para https://
 */
(function (global) {
  'use strict';

  var RELAYS = [
    'https://onpostt-relay1.onrender.com',
    'http://localhost:3000',
  ];

  var STORAGE_KEY = 'onpostt.demo.relays';
  var FETCH_TIMEOUT_MS = 15000;
  var PROBE_TIMEOUT_MS = 4000;
  var PROBE_RETRY_TIMEOUT_MS = 15000;
  var PROBE_RETRY_DELAY_MS = 1200;
  var SAVE_TIMEOUT_MS = 15000;
  var probeRetryPending = new Set();

  // Interações só podem ser gravadas em relays que já possuem o bloco alvo.
  // Sem esse roteamento o relay recebe referências para blocos inexistentes.
  var ROUTED_MODES = ['like', 'reaction', 'comment', 'repost', 'delete', 'notification'];
  // Reposts são blocos próprios e também podem receber curtidas/comentários.
  var TARGET_MODES = ['post', 'repost', 'comment', 'follow'];

  function trimUrl(value) {
    return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  }

  function httpUrl(value) {
    var url = trimUrl(value);
    if (!url) return '';

    if (/^wss:\/\//i.test(url)) return url.replace(/^wss:/i, 'https:');
    if (/^ws:\/\//i.test(url)) return url.replace(/^ws:/i, 'http:');
    if (/^https?:\/\//i.test(url)) return url;

    // Sem esquema: localhost/IP local usam http, o resto usa https.
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w.-]+\.local)(:\d+)?(\/|$)/i.test(url)) {
      return 'http://' + url;
    }
    if (/^[\w.-]+(:\d+)?(\/|$)/.test(url)) return 'https://' + url;
    return '';
  }

  function wsUrl(value) {
    var url = httpUrl(value);
    return url ? url.replace(/^http/i, 'ws') : '';
  }

  function normalizeList(list) {
    var result = [];
    (Array.isArray(list) ? list : []).forEach(function (raw) {
      var host = httpUrl(raw);
      if (!host) {
        if (global.console && typeof global.console.warn === 'function') {
          global.console.warn('onpostt: relay ignorado (URL inválida):', raw);
        }
        return;
      }
      if (result.indexOf(host) === -1) result.push(host);
    });
    return result;
  }

  function readStoredRelays() {
    try {
      var raw = global.localStorage && global.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch (error) {
      return null;
    }
  }

  function writeStoredRelays(list) {
    try {
      if (global.localStorage) {
        global.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
      }
    } catch (error) {
      /* localStorage indisponível: a lista vale só nesta sessão */
    }
  }

  function emit(name, detail) {
    if (!global.dispatchEvent || typeof global.CustomEvent !== 'function') return;
    try {
      global.dispatchEvent(new global.CustomEvent(name, { detail: detail }));
    } catch (error) {
      /* navegadores antigos */
    }
  }

  function abortableFetch(url, init, timeoutMs) {
    var controller = typeof global.AbortController === 'function' ? new global.AbortController() : null;
    var timer = null;

    var options = Object.assign({}, init || {});
    if (controller) options.signal = controller.signal;

    if (controller && timeoutMs > 0) {
      timer = setTimeout(function () {
        controller.abort();
      }, timeoutMs);
    }

    var request = global.fetch(url, options).then(function (response) {
      if (!response.ok) {
        var error = new Error('HTTP ' + response.status);
        error.status = response.status;
        throw error;
      }
      return response.json();
    });

    return {
      request: request,
      cancel: function () {
        if (timer) clearTimeout(timer);
        if (controller) {
          try {
            controller.abort();
          } catch (error) {
            /* ignore */
          }
        }
      },
      done: function () {
        if (timer) clearTimeout(timer);
      },
    };
  }

  function jsonRequest(url, init, timeoutMs) {
    var handle = abortableFetch(url, init, timeoutMs);
    return handle.request.then(
      function (body) {
        handle.done();
        return body;
      },
      function (error) {
        handle.done();
        if (error && error.name === 'AbortError') {
          throw new Error('Tempo esgotado ao consultar ' + url);
        }
        throw error;
      }
    );
  }

  function withReader(payload) {
    var token =
      global.onpostt && typeof global.onpostt.getReaderToken === 'function'
        ? global.onpostt.getReaderToken()
        : null;
    if (token) payload.reader = token;
    return payload;
  }

  function postJSON(host, path, payload, timeoutMs) {
    return jsonRequest(
      host + path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'omit',
        body: JSON.stringify(payload || {}),
      },
      timeoutMs
    );
  }

  var defaults = normalizeList(RELAYS);
  var stored = readStoredRelays();
  var configured = stored ? normalizeList(stored) : defaults.slice();
  if (!configured.length) configured = defaults.slice();

  // Lista efetiva escolhida pelo usuário (para exibição).
  var hosts = configured.slice();
  // Lista efetivamente usada para conectar/consultar (relays que responderam).
  var activeHosts = configured.slice();
  var statusByHost = {};

  function socketsFor(list) {
    return list
      .map(function (host) {
        return wsUrl(host);
      })
      .filter(Boolean);
  }

  function setStatus(host, state) {
    if (!host) return;
    var previous = statusByHost[host];
    statusByHost[host] = state;
    if (previous !== state) emit('onpostt:relay-status', { url: host, state: state });
  }

  function hostFromSocket(url) {
    if (!url) return '';
    var target = wsUrl(url);
    var all = hosts.slice();
    for (var i = 0; i < all.length; i += 1) {
      if (wsUrl(all[i]) === target) return all[i];
    }
    return '';
  }

  /**
   * Verifica quais relays estão respondendo e recalcula a lista ativa.
   * Um relay fora do ar não pode travar `onpostt.list` (que espera todos
   * os hosts), por isso ele é removido da conexão até a próxima checagem.
   */
  function probeHost(host, timeoutMs) {
    return postJSON(
      host,
      '/get_blocks_list',
      withReader({ mode: 'profile', limit: 1 }),
      timeoutMs
    )
      .then(function (body) {
        return Boolean(body && Array.isArray(body.blocks));
      })
      .catch(function () {
        return false;
      });
  }

  function applyReachableHosts() {
    var reachable = hosts.filter(function (host) {
      return statusByHost[host] === 'online';
    });
    var changed = reachable.join('|') !== activeHosts.join('|');
    // Se nada respondeu, mantém a lista configurada para que o app ainda
    // tente conectar (e mostre o erro real em vez de ficar sem hosts).
    activeHosts = reachable.length ? reachable : hosts.slice();

    emit('onpostt:relays-status', { relays: getStatus(), active: activeHosts.slice() });
    if (changed) emit('onpostt:relays-changed', { relays: hosts.slice(), active: activeHosts.slice() });
    return activeHosts.slice();
  }

  /**
   * Relays gratuitos (ex.: Render) podem levar mais que os 4 s do probe
   * inicial para acordar. Tentamos uma vez mais em segundo plano para não
   * deixar um relay saudável fora da conexão até o usuário recarregar a página.
   */
  function scheduleProbeRetry(failedHosts) {
    failedHosts.forEach(function (host) {
      if (probeRetryPending.has(host)) return;
      probeRetryPending.add(host);

      setTimeout(function () {
        if (hosts.indexOf(host) === -1) {
          probeRetryPending.delete(host);
          return;
        }

        probeHost(host, PROBE_RETRY_TIMEOUT_MS).then(function (online) {
          probeRetryPending.delete(host);
          if (hosts.indexOf(host) === -1) return;
          if (!online) {
            setStatus(host, 'offline');
            return;
          }
          setStatus(host, 'online');
          applyReachableHosts();
        });
      }, PROBE_RETRY_DELAY_MS);
    });
  }

  async function probe(timeoutMs) {
    var limit = timeoutMs || PROBE_TIMEOUT_MS;
    var results = await Promise.all(
      hosts.map(async function (host) {
        var online = await probeHost(host, limit);
        setStatus(host, online ? 'online' : 'offline');
        return { host: host, online: online };
      })
    );

    scheduleProbeRetry(
      results
        .filter(function (result) {
          return !result.online;
        })
        .map(function (result) {
          return result.host;
        })
    );

    return applyReachableHosts();
  }

  function connectOptions() {
    var list = activeHosts.length ? activeHosts.slice() : hosts.slice();
    return {
      host: list,
      socket: socketsFor(list),
    };
  }

  function getStatus() {
    return hosts.map(function (host) {
      return {
        url: host,
        state: statusByHost[host] || 'unknown',
        online: statusByHost[host] === 'online',
        isDefault: defaults.indexOf(host) !== -1,
      };
    });
  }

  function persist() {
    writeStoredRelays(hosts.slice());
  }

  async function addRelay(value) {
    var host = httpUrl(value);
    if (!host) throw new Error('Endereço de relay inválido. Exemplo: https://relay.exemplo.com');
    if (hosts.indexOf(host) !== -1) throw new Error('Esse relay já está na lista.');

    hosts.push(host);
    persist();
    await probe();
    return host;
  }

  async function removeRelay(value) {
    var host = httpUrl(value) || value;
    var index = hosts.indexOf(host);
    if (index === -1) return;

    if (hosts.length === 1) {
      throw new Error('Mantenha pelo menos um relay na lista.');
    }

    hosts.splice(index, 1);
    delete statusByHost[host];
    persist();
    await probe();
  }

  async function resetRelays() {
    // Mantém a mesma referência de array exposta em api.hosts.
    hosts.length = 0;
    defaults.forEach(function (host) {
      hosts.push(host);
    });
    statusByHost = {};
    persist();
    await probe();
  }

  /**
   * Busca um JSON em todos os relays e resolve com a primeira resposta válida.
   * Assim um relay lento ou fora do ar não atrasa a interface.
   */
  function fetchJSON(path, init, timeoutMs) {
    var list = (activeHosts.length ? activeHosts : hosts).slice();
    var urls = list.map(function (host) {
      return host + path;
    });

    if (!urls.length) return Promise.reject(new Error('Nenhum relay configurado.'));

    var limit = timeoutMs || FETCH_TIMEOUT_MS;

    return new Promise(function (resolve, reject) {
      var pending = urls.length;
      var settled = false;
      var errors = [];
      var requests = [];

      function fail(error) {
        errors.push(error);
        pending -= 1;
        if (settled || pending > 0) return;
        settled = true;
        reject(errors[errors.length - 1] || new Error('Nenhum relay respondeu.'));
      }

      urls.forEach(function (url) {
        var handle = abortableFetch(url, init, limit);
        requests.push(handle);

        handle.request
          .then(function (body) {
            handle.done();
            if (settled) return;
            settled = true;
            requests.forEach(function (other) {
              if (other !== handle) other.cancel();
            });
            resolve(body);
          })
          .catch(function (error) {
            handle.done();
            fail(
              error && error.name === 'AbortError'
                ? new Error('Tempo esgotado ao consultar ' + url)
                : error
            );
          });
      });
    });
  }

  function queryValue(block, key) {
    if (!block || !Array.isArray(block.query)) return '';
    for (var i = 0; i < block.query.length; i += 1) {
      var pair = block.query[i];
      if (Array.isArray(pair) && pair[0] === key && typeof pair[1] === 'string') {
        return pair[1];
      }
    }
    return '';
  }

  function hostHasBlock(host, id, mode, timeoutMs) {
    return postJSON(
      host,
      '/get_blocks_list',
      withReader({ mode: mode, id: id, limit: 1 }),
      timeoutMs
    )
      .then(function (body) {
        return Boolean(body && Array.isArray(body.blocks) && body.blocks.length > 0);
      })
      .catch(function () {
        return false;
      });
  }

  /**
   * Retorna somente os relays que possuem o bloco alvo.
   * Testa `post`, `repost`, `comment` e `follow` porque uma interação pode
   * apontar para qualquer um desses tipos.
   */
  async function hostsWithBlock(id, timeoutMs) {
    if (!id) return [];
    var list = (activeHosts.length ? activeHosts : hosts).slice();
    if (!list.length) return [];

    var limit = timeoutMs || PROBE_TIMEOUT_MS;
    var results = await Promise.all(
      list.map(async function (host) {
        for (var i = 0; i < TARGET_MODES.length; i += 1) {
          if (await hostHasBlock(host, id, TARGET_MODES[i], limit)) return host;
        }
        return '';
      })
    );

    return results.filter(Boolean);
  }

  function saveBlockTo(hostsList, block, timeoutMs) {
    return Promise.all(
      hostsList.map(async function (host) {
        try {
          var body = await postJSON(host, '/save_block', block, timeoutMs || SAVE_TIMEOUT_MS);
          if (!body || typeof body !== 'object') {
            return { status: 'erro', message: 'Resposta inválida do relay.', host: host };
          }
          return Object.assign({}, body, { host: host });
        } catch (error) {
          return {
            status: 'erro',
            message: error && error.message ? error.message : 'Falha ao publicar no relay.',
            host: host,
          };
        }
      })
    );
  }

  /**
   * Publica um bloco. Interações são enviadas apenas aos relays que têm o
   * bloco alvo; mensagens e demais blocos seguem pelo caminho normal da
   * biblioteca (inclusive via WebSocket).
   */
  async function sendBlock(block) {
    if (!block || typeof block !== 'object') throw new Error('Bloco inválido.');

    var mode = block.mode;
    var target = queryValue(block, 'block');
    var mustRoute = ROUTED_MODES.indexOf(mode) !== -1 && Boolean(target);

    // Notificação de follow referencia o próprio bloco de follow, que é
    // publicado em todos os relays; segue pelo caminho normal da biblioteca.
    if (mode === 'notification' && queryValue(block, 'kind') === 'follow') {
      mustRoute = false;
    }

    if (mustRoute) {
      var found = await hostsWithBlock(target);

      // Uma resposta a um comentário só deve ir para relays que também
      // conhecem o comentário pai, evitando referências órfãs.
      var parent = queryValue(block, 'parent');
      if (found.length && parent && mode === 'comment' && parent !== target) {
        var parentHosts = await hostsWithBlock(parent);
        var both = found.filter(function (host) {
          return parentHosts.indexOf(host) !== -1;
        });
        if (both.length) found = both;
      }

      if (!found.length) {
        throw new Error(
          'O bloco original não está disponível nos relays conectados. A interação não foi enviada.'
        );
      }
      return saveBlockTo(found, block);
    }

    if (global.onpostt && typeof global.onpostt.sendBlock === 'function') {
      return global.onpostt.sendBlock(block);
    }

    return saveBlockTo(activeHosts.length ? activeHosts : hosts, block);
  }

  var api = {
    // Lista configurada (inclui relays temporariamente offline).
    hosts: hosts,
    get sockets() {
      return socketsFor(hosts);
    },
    // Lista usada nas conexões/consultas (somente relays que responderam).
    get activeHosts() {
      return activeHosts.slice();
    },
    get activeSockets() {
      return socketsFor(activeHosts);
    },
    get primary() {
      return activeHosts[0] || hosts[0] || '';
    },
    defaults: defaults.slice(),
    connectOptions: connectOptions,
    probe: probe,
    getStatus: getStatus,
    addRelay: addRelay,
    removeRelay: removeRelay,
    resetRelays: resetRelays,
    fetchJSON: fetchJSON,
    sendBlock: sendBlock,
    hostsWithBlock: hostsWithBlock,
    hostFromSocket: hostFromSocket,
    setHostStatus: function (url, online) {
      var host = hostFromSocket(url);
      if (host) setStatus(host, online ? 'online' : 'offline');
    },
    markOffline: function (url) {
      var host = hostFromSocket(url) || httpUrl(url);
      if (host) setStatus(host, 'offline');
    },
    url: function (path) {
      return (activeHosts[0] || hosts[0] || '') + path;
    },
  };

  global.onposttRelay = api;

  // Mantém outras abas do mesmo navegador em sincronia. A aba que alterou a
  // lista não recebe o evento `storage`; as demais atualizam e verificam os
  // relays, disparando `onpostt:relays-changed` se a lista ativa mudar.
  if (global.addEventListener) {
    global.addEventListener('storage', function (event) {
      if (event.key !== STORAGE_KEY) return;

      var storedList = readStoredRelays();
      if (!storedList) return;

      var next = normalizeList(storedList);
      if (!next.length || next.join('|') === hosts.join('|')) return;

      hosts.length = 0;
      next.forEach(function (host) {
        hosts.push(host);
      });
      statusByHost = {};

      probe().catch(function () {
        /* mantém a lista configurada mesmo sem resposta */
      });
    });
  }
})(typeof window !== 'undefined' ? window : globalThis);
