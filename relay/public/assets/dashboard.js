'use strict';

(function () {
  var REFRESH_MS = 5000;
  var timer = null;
  var lastError = 0;

  function byId(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    var element = byId(id);
    if (!element) return;
    element.textContent = value;
  }

  function formatNumber(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    return new Intl.NumberFormat('pt-BR').format(value);
  }

  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '—';
    var units = ['B', 'KiB', 'MiB', 'GiB'];
    var index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    var value = bytes / Math.pow(1024, index);
    return value.toFixed(value >= 10 || index === 0 ? 0 : 1) + ' ' + units[index];
  }

  function formatDuration(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '—';
    if (seconds < 60) return seconds + 's';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'min';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ' + (minutes % 60) + 'min';
    var days = Math.floor(hours / 24);
    return days + 'd ' + (hours % 24) + 'h';
  }

  function formatSince(iso) {
    if (!iso) return '—';
    var timestamp = Date.parse(iso);
    if (!Number.isFinite(timestamp)) return '—';
    var seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 5) return 'agora';
    if (seconds < 60) return 'há ' + seconds + 's';
    if (seconds < 3600) return 'há ' + Math.floor(seconds / 60) + 'min';
    if (seconds < 86400) return 'há ' + Math.floor(seconds / 3600) + 'h';
    return 'há ' + Math.floor(seconds / 86400) + 'd';
  }

  function setDot(id, state) {
    var dot = byId(id);
    if (!dot) return;
    dot.classList.remove('ok', 'warn', 'error');
    if (state) dot.classList.add(state);
  }

  function toast(message, isError) {
    var stack = byId('toast-stack');
    if (!stack) return;
    var element = document.createElement('div');
    element.className = 'toast' + (isError ? ' error' : '');
    element.textContent = message;
    stack.appendChild(element);
    setTimeout(function () {
      element.remove();
    }, 6000);
  }

  function renderModes(modes) {
    var body = byId('modes-body');
    if (!body) return;
    body.textContent = '';

    if (!Array.isArray(modes) || modes.length === 0) {
      var empty = document.createElement('tr');
      var cell = document.createElement('td');
      cell.colSpan = 5;
      cell.className = 'muted';
      cell.textContent = 'Nenhum modo publicado pelo relay.';
      empty.appendChild(cell);
      body.appendChild(empty);
      return;
    }

    modes.forEach(function (mode) {
      var row = document.createElement('tr');

      var nameCell = document.createElement('td');
      var name = document.createElement('code');
      name.textContent = mode.name;
      nameCell.appendChild(name);

      var description = document.createElement('td');
      description.textContent = mode.description || '—';

      var transport = document.createElement('td');
      var transportPill = document.createElement('span');
      transportPill.className = 'pill';
      transportPill.textContent = String(mode.transport || 'http').toUpperCase();
      transport.appendChild(transportPill);

      var query = document.createElement('td');
      var queryCode = document.createElement('code');
      var rule = mode.query && typeof mode.query === 'object' ? mode.query : {};
      var required = Array.isArray(rule.required) ? rule.required : [];
      var optional = Array.isArray(rule.optional) ? rule.optional : [];
      var queryText = 'livre';
      if (!rule.free) {
        queryText = required.length ? required.join(', ') : '—';
        if (optional.length) queryText += ' (+ ' + optional.join(', ') + ')';
      }
      queryCode.textContent = queryText;
      query.appendChild(queryCode);

      var visibility = document.createElement('td');
      visibility.textContent = mode.public ? 'público' : 'cifrado / restrito';

      row.appendChild(nameCell);
      row.appendChild(description);
      row.appendChild(transport);
      row.appendChild(query);
      row.appendChild(visibility);
      body.appendChild(row);
    });
  }

  function render(status) {
    var relay = status.relay || {};
    var protocol = status.protocol || {};
    var database = status.database || {};
    var stats = status.stats || {};

    setText('metric-protocol-name', protocol.name || 'onpostt');
    setText('metric-modes', formatNumber(Array.isArray(status.modes) ? status.modes.length : 0));
    setText('port', String(relay.port || '—'));
    setText('metric-connections', formatNumber(stats.connections || 0));
    setText('metric-subscriptions', formatNumber(stats.subscriptions || 0));
    setText('users-count', formatNumber(stats.users || 0));
    setText('metric-http-total', formatNumber(stats.httpTotal || 0));
    setText('metric-http-active', formatNumber(stats.httpActive || 0) + ' ativas');
    setText('metric-rejected', formatNumber(stats.blocksRejected || 0));
    setText('metric-duplicates', formatNumber(stats.duplicates || 0) + ' duplicados');
    setText('blocks-saved', formatNumber(stats.blocksSaved || 0));
    setText('uptime', formatDuration(relay.uptimeSeconds || 0));
    setText('metric-last-block', formatSince(stats.lastBlockAt));
    setText('metric-memory', formatBytes(stats.memoryRss));

    if (database.ok) {
      setText('db-status', 'ok' + (database.latencyMs !== null && database.latencyMs !== undefined ? ' · ' + database.latencyMs + ' ms' : ''));
      setDot('health-dot', 'ok');
      setText('health-label', 'Operacional');
    } else {
      setText('db-status', database.error ? 'offline (' + database.error + ')' : 'offline');
      setDot('health-dot', 'error');
      setText('health-label', 'Banco indisponível');
    }

    setText('updated-at', new Date().toLocaleTimeString('pt-BR'));
    renderModes(status.modes);
  }

  async function refresh() {
    try {
      var response = await fetch('/api/status', {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        credentials: 'omit',
      });

      if (!response.ok) throw new Error('HTTP ' + response.status);
      var status = await response.json();
      render(status);

      var refreshState = byId('refresh-state');
      if (refreshState) refreshState.textContent = 'auto · 5s';
    } catch (error) {
      setDot('health-dot', 'error');
      setText('health-label', 'Relay inacessível');
      var refreshState = byId('refresh-state');
      if (refreshState) refreshState.textContent = 'reconectando';

      var now = Date.now();
      if (now - lastError > 30000) {
        lastError = now;
        toast('Não foi possível atualizar o status do relay.', true);
      }
    }
  }

  function start() {
    if (timer) return;
    refresh();
    timer = setInterval(refresh, REFRESH_MS);
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stop();
      var refreshState = byId('refresh-state');
      if (refreshState) refreshState.textContent = 'pausado';
    } else {
      start();
    }
  });

  start();
})();
