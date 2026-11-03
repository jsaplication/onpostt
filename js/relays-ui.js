/*!
 * onpostt · interface de gerenciamento dos relays
 *
 * Cria um único <dialog> por página e permite:
 *  - ver a lista de relays e o estado de cada conexão;
 *  - adicionar um relay (salvo no localStorage);
 *  - remover relays;
 *  - verificar as conexões novamente e restaurar o padrão do projeto.
 *
 * Abre ao clicar no status de conexão do topo ou em qualquer elemento com
 * [data-open-relays]. Os estados vêm de js/relay.js e são atualizados por
 * eventos (onpostt:relay-status / onpostt:relays-status / onpostt:relays-changed).
 */
(function (global) {
  'use strict';

  function byId(id) {
    return document.getElementById(id);
  }

  function relayApi() {
    return global.onposttRelay;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function stateLabel(state) {
    if (state === 'online') return 'conectado';
    if (state === 'offline') return 'sem resposta';
    return 'verificando…';
  }

  function stateClass(state) {
    if (state === 'online') return ' online';
    if (state === 'offline') return ' offline';
    return '';
  }

  function buildDialog() {
    if (byId('relay-dialog')) return byId('relay-dialog');

    var dialog = el('dialog', 'key-dialog relay-dialog');
    dialog.id = 'relay-dialog';
    dialog.setAttribute('aria-labelledby', 'relay-dialog-title');

    var body = el('div', 'key-dialog-body relay-dialog-body');

    var head = el('div', 'relay-head');
    var titles = el('div');
    var title = el('h2', null, 'Relays');
    title.id = 'relay-dialog-title';
    var subtitle = el(
      'p',
      'muted small relay-subtitle',
      'Escolha de quais relays o app lê e publica. Relays sem resposta ficam fora até a próxima verificação. As alterações ficam salvas neste navegador.'
    );
    titles.appendChild(title);
    titles.appendChild(subtitle);

    var close = el('button', 'btn btn-small btn-ghost relay-close', 'Fechar');
    close.type = 'button';
    close.setAttribute('data-relay-close', '');
    head.appendChild(titles);
    head.appendChild(close);

    var list = el('ul', 'relay-list');
    list.setAttribute('data-relay-list', '');
    list.setAttribute('aria-live', 'polite');

    var form = el('form', 'relay-add');
    form.setAttribute('data-relay-form', '');
    form.autocomplete = 'off';

    var input = el('input', 'input relay-input');
    input.type = 'text';
    input.placeholder = 'https://outro-relay.exemplo.com';
    input.maxLength = 300;
    input.spellcheck = false;
    input.setAttribute('data-relay-input', '');
    input.setAttribute('aria-label', 'Endereço do novo relay');

    var addButton = el('button', 'btn btn-primary relay-add-button', 'Adicionar');
    addButton.type = 'submit';

    form.appendChild(input);
    form.appendChild(addButton);

    var hint = el('p', 'relay-hint small');
    hint.setAttribute('data-relay-hint', '');
    hint.setAttribute('role', 'status');
    hint.hidden = true;

    var actions = el('div', 'form-actions relay-actions');
    var check = el('button', 'btn btn-small', 'Verificar conexões');
    check.type = 'button';
    check.setAttribute('data-relay-check', '');
    var reset = el('button', 'btn btn-small btn-ghost', 'Restaurar padrão');
    reset.type = 'button';
    reset.setAttribute('data-relay-reset', '');
    var spacer = el('span', 'spacer');
    var note = el('span', 'faint small', 'Salvo neste navegador.');
    actions.appendChild(check);
    actions.appendChild(reset);
    actions.appendChild(spacer);
    actions.appendChild(note);

    body.appendChild(head);
    body.appendChild(list);
    body.appendChild(form);
    body.appendChild(hint);
    body.appendChild(actions);
    dialog.appendChild(body);
    document.body.appendChild(dialog);

    return dialog;
  }

  function render(dialog) {
    var api = relayApi();
    var list = dialog.querySelector('[data-relay-list]');
    if (!api || !list) return;

    var statuses = api.getStatus();
    list.textContent = '';

    if (!statuses.length) {
      var empty = el('li', 'relay-empty faint small', 'Nenhum relay configurado.');
      list.appendChild(empty);
      return;
    }

    statuses.forEach(function (entry) {
      var item = el('li', 'relay-item');
      item.setAttribute('data-relay-url', entry.url);

      var dot = el('span', 'relay-dot' + stateClass(entry.state));
      dot.setAttribute('aria-hidden', 'true');

      var info = el('div', 'relay-info');
      var url = el('span', 'relay-url mono', entry.url);
      var meta = el(
        'span',
        'relay-meta small',
        stateLabel(entry.state) + (entry.isDefault ? ' · padrão' : '')
      );
      info.appendChild(url);
      info.appendChild(meta);

      var remove = el('button', 'btn btn-small btn-ghost relay-remove', 'Remover');
      remove.type = 'button';
      remove.setAttribute('data-relay-remove', entry.url);
      remove.title = 'Remover este relay';
      remove.disabled = statuses.length === 1;

      item.appendChild(dot);
      item.appendChild(info);
      item.appendChild(remove);
      list.appendChild(item);
    });
  }

  function showHint(dialog, message, isError) {
    var hint = dialog.querySelector('[data-relay-hint]');
    if (!hint) return;
    hint.textContent = message || '';
    hint.hidden = !message;
    hint.classList.toggle('relay-hint-error', Boolean(isError));
  }

  function openDialog(dialog) {
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    dialog.classList.add('open');
    render(dialog);
  }

  function closeDialog(dialog) {
    if (typeof dialog.close === 'function') {
      if (dialog.open) dialog.close();
    } else {
      dialog.removeAttribute('open');
    }
    dialog.classList.remove('open');
  }

  function bind(dialog) {
    dialog.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || !target.closest) return;

      if (target.closest('[data-relay-close]')) {
        closeDialog(dialog);
        return;
      }

      var remove = target.closest('[data-relay-remove]');
      if (remove) {
        var url = remove.getAttribute('data-relay-remove');
        var api = relayApi();
        if (!api) return;
        remove.disabled = true;
        showHint(dialog, 'Removendo ' + url + '…', false);
        api
          .removeRelay(url)
          .then(function () {
            showHint(dialog, 'Relay removido.', false);
            render(dialog);
          })
          .catch(function (error) {
            remove.disabled = false;
            showHint(dialog, error.message, true);
          });
        return;
      }

      var check = target.closest('[data-relay-check]');
      if (check) {
        var relay = relayApi();
        if (!relay) return;
        check.disabled = true;
        showHint(dialog, 'Verificando conexões…', false);
        relay
          .probe()
          .then(function () {
            showHint(dialog, 'Verificação concluída.', false);
            render(dialog);
          })
          .catch(function (error) {
            showHint(dialog, error.message, true);
          })
          .then(function () {
            check.disabled = false;
          });
        return;
      }

      var reset = target.closest('[data-relay-reset]');
      if (reset) {
        var module = relayApi();
        if (!module) return;
        reset.disabled = true;
        showHint(dialog, 'Restaurando a lista padrão…', false);
        module
          .resetRelays()
          .then(function () {
            showHint(dialog, 'Lista padrão restaurada.', false);
            render(dialog);
          })
          .catch(function (error) {
            showHint(dialog, error.message, true);
          })
          .then(function () {
            reset.disabled = false;
          });
      }
    });

    // Fecha ao clicar fora do conteúdo (backdrop do <dialog>).
    dialog.addEventListener('click', function (event) {
      if (event.target === dialog) closeDialog(dialog);
    });

    var form = dialog.querySelector('[data-relay-form]');
    if (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var api = relayApi();
        if (!api) return;

        var input = dialog.querySelector('[data-relay-input]');
        var button = form.querySelector('button[type="submit"]');
        var value = input ? input.value.trim() : '';
        if (!value) return;

        if (button) button.disabled = true;
        showHint(dialog, 'Verificando ' + value + '…', false);

        api
          .addRelay(value)
          .then(function (host) {
            if (input) input.value = '';
            showHint(dialog, 'Relay adicionado: ' + host, false);
            render(dialog);
          })
          .catch(function (error) {
            showHint(dialog, error.message, true);
          })
          .then(function () {
            if (button) button.disabled = false;
          });
      });
    }
  }

  function bindTriggers(dialog) {
    document.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || !target.closest) return;

      if (target.closest('[data-open-relays]') || target.closest('#net-status')) {
        event.preventDefault();
        openDialog(dialog);
      }
    });

    var netStatus = byId('net-status');
    if (netStatus) {
      netStatus.setAttribute('role', 'button');
      netStatus.setAttribute('tabindex', '0');
      netStatus.setAttribute('aria-haspopup', 'dialog');
      netStatus.title = 'Gerenciar relays';
      netStatus.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openDialog(dialog);
        }
      });
    }
  }

  function init() {
    var dialog = buildDialog();
    bind(dialog);
    bindTriggers(dialog);
    render(dialog);

    ['onpostt:relay-status', 'onpostt:relays-status'].forEach(function (name) {
      global.addEventListener(name, function () {
        if (dialog.open || dialog.hasAttribute('open')) render(dialog);
      });
    });

    global.addEventListener('onpostt:relays-changed', function () {
      render(dialog);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
