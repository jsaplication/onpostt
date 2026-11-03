'use strict';

/*
 * Bootstrap exclusivo de post.html.
 *
 * Reaproveita o shell do index.html e carrega o app.js em modo de publicação
 * única. O app.js lê ?post=<id> e ?repost=<id>, monta a view #view-post e
 * mantém curtidas, comentários e reposts funcionando no bloco exibido.
 */
(function () {
  var loading = document.getElementById('post-loading');
  var errorBox = document.getElementById('post-loading-error');
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
      showError('Estrutura da página de publicação não encontrada.');
      return;
    }

    try {
      var response = await fetch('/index.html', { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);

      var doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      var header = doc.querySelector('header.site-header');
      var main = doc.querySelector('main.demo-main');
      var dialog = doc.getElementById('key-dialog');
      var toasts = doc.getElementById('toast-stack');
      if (!header || !main || !dialog || !toasts) {
        throw new Error('estrutura do app não encontrada');
      }

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
        'Não foi possível carregar a publicação. ' +
          error.message +
          ' Abra a página inicial e tente novamente.'
      );
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
