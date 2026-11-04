'use strict';

/*
 * Visualizador de imagens das publicações.
 *
 * Qualquer imagem marcada com data-image-modal (ou dentro de .post-media /
 * .profile-post-media) abre em um <dialog> nativo. O clique na imagem não
 * propaga para o card, então o post não redireciona para post.html.
 */
(function () {
  var dialog = null;
  var preview = null;

  function ensureDialog() {
    if (dialog && dialog.isConnected) return dialog;

    dialog = document.createElement('dialog');
    dialog.className = 'image-modal';
    dialog.id = 'image-modal';
    dialog.setAttribute('aria-label', 'Visualizar imagem');

    var closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'image-modal-close';
    closeButton.setAttribute('aria-label', 'Fechar imagem');
    closeButton.textContent = '\u00d7';

    preview = document.createElement('img');
    preview.className = 'image-modal-img';
    preview.alt = '';

    dialog.appendChild(closeButton);
    dialog.appendChild(preview);
    document.body.appendChild(dialog);

    closeButton.addEventListener('click', closeDialog);

    dialog.addEventListener('click', function (event) {
      if (event.target === dialog) closeDialog();
    });

    dialog.addEventListener('cancel', function (event) {
      event.preventDefault();
      closeDialog();
    });

    dialog.addEventListener('close', cleanup);

    return dialog;
  }

  function cleanup() {
    if (preview) {
      preview.removeAttribute('src');
      preview.alt = '';
    }
    document.body.classList.remove('image-modal-open');
  }

  function openDialog(source, alt) {
    if (!source) return;

    var modal = ensureDialog();
    preview.src = source;
    preview.alt = alt || 'Imagem ampliada';

    if (typeof modal.showModal === 'function') {
      if (!modal.open) modal.showModal();
    } else {
      modal.setAttribute('open', 'open');
    }

    document.body.classList.add('image-modal-open');

    var closeButton = modal.querySelector('.image-modal-close');
    if (closeButton && typeof closeButton.focus === 'function') closeButton.focus();
  }

  function closeDialog() {
    if (!dialog) return;

    if (typeof dialog.close === 'function' && dialog.open) {
      dialog.close();
    } else {
      dialog.removeAttribute('open');
    }

    cleanup();
  }

  function imageFromEvent(event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') return null;
    return target.closest(
      'img[data-image-modal], .post-media img, .profile-post-media img'
    );
  }

  document.addEventListener(
    'click',
    function (event) {
      var image = imageFromEvent(event);
      if (!image) return;

      event.preventDefault();
      event.stopPropagation();
      openDialog(image.currentSrc || image.src, image.alt);
    },
    true
  );

  document.addEventListener(
    'keydown',
    function (event) {
      if (event.key === 'Escape' && dialog && dialog.open) {
        event.preventDefault();
        event.stopPropagation();
        closeDialog();
        return;
      }

      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;

      var image = imageFromEvent(event);
      if (!image) return;

      event.preventDefault();
      event.stopPropagation();
      openDialog(image.currentSrc || image.src, image.alt);
    },
    true
  );

  // Garante acessibilidade para imagens já presentes ou inseridas depois.
  function enhance(root) {
    var scope = root && typeof root.querySelectorAll === 'function' ? root : document;
    scope.querySelectorAll('.post-media img, .profile-post-media img').forEach(function (image) {
      image.dataset.imageModal = 'true';
      if (!image.hasAttribute('tabindex')) image.tabIndex = 0;
      if (!image.hasAttribute('role')) image.setAttribute('role', 'button');
      if (!image.hasAttribute('aria-label')) {
        image.setAttribute(
          'aria-label',
          image.alt ? 'Ampliar imagem: ' + image.alt : 'Ampliar imagem'
        );
      }
    });
  }

  window.onposttImageViewer = {
    open: openDialog,
    close: closeDialog,
    enhance: enhance,
  };

  function init() {
    enhance();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
