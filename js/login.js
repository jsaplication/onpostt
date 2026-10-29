'use strict';

(function () {
  var state = {
    vault: null,
    file: null,
    busy: false,
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function showError(message) {
    var node = byId('login-error');
    if (!node) return;
    node.textContent = message || 'Não foi possível entrar.';
    node.hidden = false;
  }

  function clearError() {
    var node = byId('login-error');
    if (!node) return;
    node.textContent = '';
    node.hidden = true;
  }

  function showNotice(message) {
    var node = byId('login-notice');
    if (!node) return;
    node.textContent = message || '';
    node.hidden = !message;
  }

  function setBusy(button, busy) {
    if (!button) return;
    if (!button.dataset.label) button.dataset.label = button.textContent;
    button.disabled = Boolean(busy);
    button.textContent = busy ? 'Aguarde…' : button.dataset.label;
  }

  function shortKey(pubkey) {
    var key = String(pubkey || '');
    if (key.length < 20) return key || '—';
    return key.slice(0, 10) + '…' + key.slice(-8);
  }

  function switchTab(name) {
    var keyTab = byId('tab-key');
    var fileTab = byId('tab-file');
    var keyPanel = byId('key-panel');
    var filePanel = byId('file-panel');
    var isFile = name === 'file';

    if (keyTab) {
      keyTab.classList.toggle('active', !isFile);
      keyTab.setAttribute('aria-selected', String(!isFile));
    }
    if (fileTab) {
      fileTab.classList.toggle('active', isFile);
      fileTab.setAttribute('aria-selected', String(isFile));
    }
    if (keyPanel) keyPanel.hidden = isFile;
    if (filePanel) filePanel.hidden = !isFile;

    var input = isFile ? byId('vault-file') : byId('private-key');
    if (input) input.focus();
  }

  async function handleFileSelection(file) {
    var info = byId('file-info');
    var submit = byId('file-submit');
    state.file = file || null;
    state.vault = null;
    if (submit) submit.disabled = true;
    clearError();

    if (!file) {
      if (info) {
        info.textContent = '';
        info.hidden = true;
      }
      return;
    }

    if (info) {
      info.textContent = 'Lendo cofre…';
      info.hidden = false;
    }

    try {
      var vault = await window.onposttAuth.readVaultFile(file);
      state.vault = vault;
      if (info) {
        info.textContent =
          'Cofre de ' + vault.username + ' · ' + shortKey(vault.publicKey) + ' · pronto para desbloquear.';
      }
      if (submit) submit.disabled = false;
      var password = byId('vault-password');
      if (password) password.focus();
    } catch (error) {
      state.file = null;
      var input = byId('vault-file');
      if (input) input.value = '';
      if (info) {
        info.textContent = '';
        info.hidden = true;
      }
      showError(error.message);
    }
  }

  function bindEvents() {
    var tabs = document.querySelectorAll('[data-auth-tab]');
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        switchTab(tab.dataset.authTab);
      });
    });

    var keyForm = byId('key-panel');
    if (keyForm) {
      keyForm.addEventListener('submit', async function (event) {
        event.preventDefault();
        if (state.busy) return;
        clearError();

        var privateKey = byId('private-key');
        var username = byId('key-username');
        var remember = byId('key-remember');
        var button = byId('key-submit');

        if (!privateKey || !privateKey.value.trim()) {
          showError('Cole sua chave privada para entrar.');
          if (privateKey) privateKey.focus();
          return;
        }

        state.busy = true;
        setBusy(button, true);
        try {
          await window.onposttAuth.loginWithPrivateKey(
            privateKey.value,
            username ? username.value : '',
            remember ? remember.checked : true
          );
          window.location.replace(window.onposttAuth.nextUrl('/'));
        } catch (error) {
          showError(error.message);
          state.busy = false;
          setBusy(button, false);
        }
      });
    }

    var fileInput = byId('vault-file');
    if (fileInput) {
      fileInput.addEventListener('change', function () {
        var file = fileInput.files && fileInput.files[0];
        handleFileSelection(file);
      });
    }

    var fileForm = byId('file-panel');
    if (fileForm) {
      fileForm.addEventListener('submit', async function (event) {
        event.preventDefault();
        if (state.busy) return;
        clearError();

        if (!state.file || !state.vault) {
          showError('Selecione um cofre .json válido.');
          return;
        }

        var password = byId('vault-password');
        var remember = byId('file-remember');
        var button = byId('file-submit');

        if (!password || !password.value) {
          showError('Informe a senha do cofre.');
          if (password) password.focus();
          return;
        }

        state.busy = true;
        setBusy(button, true);
        try {
          await window.onposttAuth.loginWithFile(
            state.file,
            password.value,
            remember ? remember.checked : true
          );
          window.location.replace(window.onposttAuth.nextUrl('/'));
        } catch (error) {
          showError(error.message);
          password.value = '';
          password.focus();
          state.busy = false;
          setBusy(button, false);
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

    var notice = window.onposttAuth.consumeNotice();
    if (notice) showNotice(notice);

    var next = window.onposttAuth.nextUrl('/');
    document.querySelectorAll('a[href="/cadastro.html"]').forEach(function (link) {
      link.href = '/cadastro.html?next=' + encodeURIComponent(next);
    });

    var params = new URLSearchParams(window.location.search);
    if (params.get('trocar') === '1') {
      bindEvents();
      return;
    }

    try {
      var existing = await window.onposttAuth.ensureSession();
      if (existing) {
        window.location.replace(window.onposttAuth.nextUrl('/'));
        return;
      }
    } catch (error) {
      showError(error.message);
    }

    bindEvents();
  }

  init();
})();
