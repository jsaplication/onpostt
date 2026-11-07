'use strict';

/*
 * Bootstrap exclusivo de messages.html.
 *
 * A página de conversas reaproveita o shell do index.html (cabeçalho, main,
 * dialog de identidade e toasts) e carrega o app.js depois. O app.js detecta
 * body.messages-body e entra em modo somente-conversas.
 */
(function () {
  var loading = document.getElementById('messages-loading');
  var errorBox = document.getElementById('messages-loading-error');
  var shell = document.getElementById('app-shell');

  function showError(message) {
    if (loading) loading.style.display = 'grid';
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.onload = function () {
        resolve();
      };
      script.onerror = function () {
        reject(new Error('Falha ao carregar ' + src));
      };
      document.body.appendChild(script);
    });
  }

  async function boot() {
    if (!shell) {
      showError('Estrutura da página de conversas não encontrada.');
      return;
    }

    try {
      var response = await fetch('index.html', { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);

      var doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      var header = doc.querySelector('header.site-header');
      var main = doc.querySelector('main.demo-main');
      var dialog = doc.getElementById('key-dialog');
      var toasts = doc.getElementById('toast-stack');
      if (!header || !main || !dialog || !toasts) {
        throw new Error('estrutura do app não encontrada');
      }

      // O app.js mostra a view de conversas depois de conectar.
      main.querySelectorAll('.demo-view').forEach(function (view) {
        view.hidden = true;
      });

      document.body.insertBefore(header, shell);
      shell.appendChild(main);
      shell.appendChild(dialog);
      shell.appendChild(toasts);

      window.addEventListener('onpostt:app-ready', function () {
        document.body.classList.add('app-ready');
        if (loading) loading.style.display = 'none';
      });

      await loadScript('js/app.js');
    } catch (error) {
      showError(
        'Não foi possível carregar as conversas. ' +
          error.message +
          ' Abra a página inicial e tente novamente.'
      );
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
