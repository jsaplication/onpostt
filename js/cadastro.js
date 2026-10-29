'use strict';

(function () {
  var state = {
    busy: false,
    vault: null,
    username: '',
  };
  var sessionReady = null;

  function byId(id) {
    return document.getElementById(id);
  }

  function showError(message) {
    var node = byId('register-error');
    if (!node) return;
    node.textContent = message || 'Não foi possível criar a identidade.';
    node.hidden = false;
  }

  function clearError() {
    var node = byId('register-error');
    if (!node) return;
    node.textContent = '';
    node.hidden = true;
  }

  function showNotice(message) {
    var node = byId('register-session-notice');
    if (!node) return;
    node.textContent = message || '';
    node.hidden = !message;
  }

  function setBusy(button, busy) {
    if (!button) return;
    if (!button.dataset.label) button.dataset.label = button.textContent;
    button.disabled = Boolean(busy);
    button.textContent = busy ? 'Gerando chaves…' : button.dataset.label;
  }

  function shortKey(pubkey) {
    var key = String(pubkey || '');
    if (key.length < 20) return key || '—';
    return key.slice(0, 10) + '…' + key.slice(-8);
  }

  function toast(message, isError) {
    var stack = byId('toast-stack');
    if (!stack) return;
    var item = document.createElement('div');
    item.className = 'toast' + (isError ? ' error' : '');
    item.textContent = message;
    stack.appendChild(item);
    window.setTimeout(function () {
      item.remove();
    }, 7000);
  }

  function updatePasswordMeter() {
    var input = byId('register-password');
    var meter = byId('password-meter');
    var text = byId('password-meter-text');
    if (!input || !meter || !text) return;

    var password = input.value;
    var score = 0;
    if (password.length >= 10) score += 1;
    if (password.length >= 14) score += 1;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
    if (/\d/.test(password)) score += 1;
    if (/[^A-Za-z0-9]/.test(password)) score += 1;

    meter.classList.remove('weak', 'medium', 'strong');
    if (!password) {
      meter.classList.add('weak');
      text.textContent = 'Use pelo menos 10 caracteres.';
      return;
    }
    if (score >= 5) {
      meter.classList.add('strong');
      text.textContent = 'Forte.';
    } else if (score >= 3) {
      meter.classList.add('medium');
      text.textContent = 'Média. Considere usar letras, números e símbolos.';
    } else {
      meter.classList.add('weak');
      text.textContent = 'Fraca. Use pelo menos 10 caracteres e varie os tipos.';
    }
  }

  function showSuccess(identity, result) {
    var form = byId('register-form');
    var success = byId('register-success');
    var switchLine = byId('register-switch');
    var sessionNotice = byId('register-session-notice');
    var username = byId('success-username');
    var pubkey = byId('success-pubkey');
    var session = byId('success-session');
    var note = byId('success-note');
    var continueLink = byId('continue-demo');

    if (form) form.hidden = true;
    if (success) success.hidden = false;
    if (switchLine) switchLine.hidden = true;
    if (sessionNotice) {
      sessionNotice.textContent = '';
      sessionNotice.hidden = true;
    }
    if (username) username.textContent = identity.username;
    if (pubkey) pubkey.textContent = identity.publicKey;
    if (session) {
      session.textContent = result.remembered
        ? 'Mantida neste dispositivo por 30 dias.'
        : 'Somente nesta aba.';
    }
    if (continueLink) continueLink.href = window.onposttAuth.nextUrl('/');
    if (note) {
      note.textContent = result.warning
        ? result.warning + ' Baixe o cofre e guarde a senha.'
        : 'A senha não foi armazenada. Se você perder o cofre e a senha, a identidade não poderá ser recuperada.';
    }

    var password = byId('register-password');
    var confirm = byId('register-password-confirm');
    if (password) password.value = '';
    if (confirm) confirm.value = '';
  }

  function bindEvents() {
    var password = byId('register-password');
    if (password) password.addEventListener('input', updatePasswordMeter);

    var form = byId('register-form');
    if (form) {
      form.addEventListener('submit', async function (event) {
        event.preventDefault();
        if (state.busy) return;
        if (sessionReady) await sessionReady;
        clearError();

        var usernameInput = byId('register-username');
        var passwordInput = byId('register-password');
        var confirmInput = byId('register-password-confirm');
        var rememberInput = byId('register-remember');
        var button = byId('register-submit');

        try {
          var username = window.onposttAuth.validateUsername(
            usernameInput ? usernameInput.value : ''
          );
          var passwordValue = window.onposttAuth.validatePassword(
            passwordInput ? passwordInput.value : ''
          );
          if (!confirmInput || confirmInput.value !== passwordValue) {
            throw new Error('As senhas não coincidem.');
          }

          var existing = window.onposttAuth.readSession();
          if (existing) {
            var label = existing.username || shortKey(existing.publicKey);
            var confirmed = window.confirm(
              'Você já está conectado como ' +
                label +
                '. Criar uma nova identidade substituirá a sessão neste dispositivo. Continuar?'
            );
            if (!confirmed) return;
          }

          state.busy = true;
          setBusy(button, true);

          var keys = window.onpostt.generateKeys();
          if (
            !window.onpostt.isValidPrivateKey(keys.privateKey) ||
            window.onpostt.generatePublicKey(keys.privateKey) !== keys.publicKey
          ) {
            throw new Error('Não foi possível gerar um par de chaves válido.');
          }

          var identity = {
            privateKey: keys.privateKey,
            publicKey: keys.publicKey,
            username: username,
            createdAt: new Date().toISOString(),
          };

          var vault = await window.onposttAuth.createVault(identity, passwordValue);
          var result = await window.onposttAuth.loginWithIdentity(
            identity,
            rememberInput ? rememberInput.checked : true
          );

          state.vault = vault;
          state.username = username;
          showSuccess(result.identity, result);
          updatePasswordMeter();

          try {
            // window.onposttAuth.downloadVault(vault, username);
            // toast('Cofre cifrado baixado. Guarde o arquivo e a senha.');
          } catch (error) {
            toast('Cofre pronto. Use o botão de download.', true);
          }
        } catch (error) {
          showError(error.message);
          state.busy = false;
          setBusy(button, false);
        }
      });
    }

    var download = byId('download-vault');
    if (download) {
      download.addEventListener('click', function () {
        if (!state.vault) {
          toast('O cofre não está mais disponível nesta aba. Crie a identidade novamente.', true);
          return;
        }
        try {
          window.onposttAuth.downloadVault(state.vault, state.username);
          toast('Download iniciado.');
        } catch (error) {
          toast(error.message, true);
        }
      });
    }
  }

  async function init() {
    if (!window.onpostt) {
      showError('A biblioteca onpostt não carregou. Recarregue a página.');
      return;
    }
    if (!window.onposttAuth) {
      showError('O módulo de sessão não carregou. Recarregue a página.');
      return;
    }
    if (!window.crypto || !window.crypto.subtle) {
      showError('WebCrypto indisponível. Abra o demo por HTTPS ou em localhost.');
      return;
    }

    bindEvents();
    updatePasswordMeter();

    var next = window.onposttAuth.nextUrl('/');
    document.querySelectorAll('a[href="/login.html"]').forEach(function (link) {
      link.href = '/login.html?next=' + encodeURIComponent(next);
    });

    sessionReady = window.onposttAuth.ensureSession().catch(function () {
      return null;
    });
    await sessionReady;

    var existing = window.onposttAuth.readSession();
    if (existing) {
      showNotice(
        'Você já está conectado como ' +
          (existing.username || shortKey(existing.publicKey)) +
          '. Criar uma nova identidade substituirá a sessão neste dispositivo.'
      );
    }
  }

  init();
})();
