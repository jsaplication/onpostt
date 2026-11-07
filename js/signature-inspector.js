'use strict';

/*
 * Inspector de assinaturas das publicações.
 *
 * O botão discreto "Assinatura" abre um <dialog> com o objeto canônico que foi
 * assinado, a assinatura DER e o resultado da verificação feita localmente no
 * navegador (secp256k1 + SHA-256). Também confere se o id do bloco corresponde
 * ao hash do objeto, sem depender de nenhum relay.
 */
(function (global) {
  var dialog = null;
  var refs = null;
  var verifyToken = 0;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function blockId(block) {
    return block && typeof block.id === 'string' ? block.id : '';
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function canonicalPostImage(image) {
    if (!isPlainObject(image)) return image;

    var known = ['mime', 'data', 'width', 'height'];
    var ordered = {};
    if (image.mime !== undefined) ordered.mime = image.mime;
    if (image.data !== undefined) ordered.data = image.data;
    if (image.width !== undefined) ordered.width = image.width;
    if (image.height !== undefined) ordered.height = image.height;

    Object.keys(image).forEach(function (key) {
      if (known.indexOf(key) === -1) ordered[key] = image[key];
    });

    return ordered;
  }

  /*
   * O relay devolve os objetos JSON com as chaves reordenadas. Para o conteúdo
   * de posts, restauramos a ordem usada pelo cliente no momento da assinatura:
   * image, text, topics — e, dentro de image, mime, data, width, height.
   */
  function canonicalPostContent(content) {
    if (!isPlainObject(content)) return content;

    var known = ['image', 'text', 'topics'];
    var ordered = {};
    if (content.image !== undefined) ordered.image = canonicalPostImage(content.image);
    if (content.text !== undefined) ordered.text = content.text;
    if (content.topics !== undefined) ordered.topics = content.topics;

    Object.keys(content).forEach(function (key) {
      if (known.indexOf(key) === -1) ordered[key] = content[key];
    });

    return ordered;
  }

  function canonicalBlock(block) {
    var known = ['pubkey', 'created_at', 'mode', 'query', 'content', 'app', 'id', 'sig'];
    var ordered = {
      pubkey: block.pubkey,
      created_at: block.created_at,
      mode: block.mode,
      query: Array.isArray(block.query) ? block.query : [],
    };

    if (block.content !== undefined) {
      ordered.content =
        block.mode === 'post' ? canonicalPostContent(block.content) : block.content;
    }
    if (block.app !== undefined) ordered.app = block.app;

    Object.keys(block).forEach(function (key) {
      if (known.indexOf(key) === -1) ordered[key] = block[key];
    });

    if (Object.prototype.hasOwnProperty.call(block, 'id')) ordered.id = block.id;
    return ordered;
  }

  function closeDialog() {
    if (!dialog) return;
    try {
      if (typeof dialog.close === 'function' && dialog.open) dialog.close();
      else dialog.removeAttribute('open');
    } catch (error) {
      dialog.removeAttribute('open');
    }
    document.body.classList.remove('signature-dialog-open');
  }

  function ensureDialog() {
    if (dialog && dialog.isConnected) return;

    dialog = document.createElement('dialog');
    dialog.className = 'signature-dialog';
    dialog.id = 'signature-dialog';
    dialog.setAttribute('aria-labelledby', 'signature-dialog-title');

    var body = el('div', 'signature-dialog-body');

    var head = el('div', 'signature-head');
    var heading = el('div', 'signature-heading');
    heading.appendChild(el('span', 'signature-eyebrow', 'Integridade do bloco'));
    var title = el('h2', '', 'Assinatura da publicação');
    title.id = 'signature-dialog-title';
    heading.appendChild(title);
    head.appendChild(heading);

    var closeButton = el('button', 'signature-close', '\u00d7');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Fechar verificação de assinatura');
    closeButton.title = 'Fechar';
    head.appendChild(closeButton);
    body.appendChild(head);

    var status = el('p', 'signature-status is-pending', 'Verificando assinatura…');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    body.appendChild(status);

    var idStatus = el('p', 'signature-id-status', 'ID do bloco: verificando…');
    body.appendChild(idStatus);

    var meta = el('dl', 'signature-meta');
    var idRow = el('div', '');
    idRow.appendChild(el('dt', '', 'ID do bloco'));
    var idValue = el('dd', 'mono', '—');
    idRow.appendChild(idValue);
    meta.appendChild(idRow);

    var authorRow = el('div', '');
    authorRow.appendChild(el('dt', '', 'Pubkey do autor'));
    var authorValue = el('dd', 'mono', '—');
    authorRow.appendChild(authorValue);
    meta.appendChild(authorRow);
    body.appendChild(meta);

    var objectSection = el('section', 'signature-section');
    objectSection.appendChild(el('h3', '', 'Objeto assinado'));
    var objectCode = el('pre', 'signature-code');
    objectSection.appendChild(objectCode);
    body.appendChild(objectSection);

    var signatureSection = el('section', 'signature-section');
    signatureSection.appendChild(el('h3', '', 'Assinatura (DER, hex)'));
    var signatureCode = el('pre', 'signature-code signature-code-signature');
    signatureSection.appendChild(signatureCode);
    body.appendChild(signatureSection);

    body.appendChild(
      el(
        'p',
        'signature-note faint small',
        'A verificação acontece localmente no seu navegador usando secp256k1 e SHA-256. ' +
          'Nenhum dado da publicação é enviado a um relay para essa checagem.'
      )
    );

    dialog.appendChild(body);
    document.body.appendChild(dialog);
    refs = {
      title: title,
      status: status,
      idStatus: idStatus,
      idValue: idValue,
      authorValue: authorValue,
      objectCode: objectCode,
      signatureCode: signatureCode,
      close: closeButton,
    };

    closeButton.addEventListener('click', closeDialog);
    dialog.addEventListener('click', function (event) {
      if (event.target === dialog) closeDialog();
    });
    dialog.addEventListener('cancel', function (event) {
      event.preventDefault();
      closeDialog();
    });
    dialog.addEventListener('close', function () {
      verifyToken += 1;
      document.body.classList.remove('signature-dialog-open');
    });
  }

  function setStatus(kind, text) {
    if (!refs) return;
    refs.status.className = 'signature-status is-' + kind;
    refs.status.textContent = text;
  }

  function setIdStatus(kind, text) {
    if (!refs) return;
    refs.idStatus.className = 'signature-id-status is-' + kind;
    refs.idStatus.textContent = text;
  }

  function verifyBlockId(block, canonical) {
    if (!block.id || !global.onpostt || typeof global.onpostt.sha256 !== 'function') {
      return Promise.resolve(null);
    }

    var withoutId = {};
    Object.keys(canonical).forEach(function (key) {
      if (key !== 'id') withoutId[key] = canonical[key];
    });

    return global.onpostt
      .sha256(JSON.stringify(withoutId))
      .then(function (hash) {
        return String(hash).toLowerCase() === String(block.id).toLowerCase();
      })
      .catch(function () {
        return null;
      });
  }

  function open(block) {
    if (!block || typeof block !== 'object') return;

    ensureDialog();

    verifyToken += 1;
    var token = verifyToken;
    var canonical = canonicalBlock(block);
    var signedText;

    try {
      signedText = JSON.stringify(canonical);
    } catch (error) {
      signedText = '';
    }

    refs.title.textContent =
      block.mode === 'post' ? 'Assinatura da publicação' : 'Assinatura do bloco';
    refs.idValue.textContent = blockId(block) || '—';
    refs.authorValue.textContent =
      typeof block.pubkey === 'string' && block.pubkey ? block.pubkey : '—';
    refs.objectCode.textContent = signedText
      ? JSON.stringify(canonical, null, 2)
      : 'Objeto indisponível.';
    refs.signatureCode.textContent =
      typeof block.sig === 'string' && block.sig ? block.sig : 'Sem assinatura.';

    setStatus('pending', 'Verificando assinatura…');
    setIdStatus('pending', 'ID do bloco: verificando…');

    if (!dialog.open) {
      document.body.classList.add('signature-dialog-open');
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', 'open');
      if (refs.close && typeof refs.close.focus === 'function') refs.close.focus();
    }

    var pubkey = typeof block.pubkey === 'string' ? block.pubkey : '';
    var signature = typeof block.sig === 'string' ? block.sig : '';

    if (!signature) {
      setStatus('invalid', 'Sem assinatura: integridade não verificável.');
      setIdStatus('unavailable', 'ID do bloco: não verificado.');
      return;
    }

    if (
      !pubkey ||
      !signedText ||
      !global.onpostt ||
      typeof global.onpostt.verifySignature !== 'function'
    ) {
      setStatus('unavailable', 'Verificação indisponível neste navegador.');
      setIdStatus('unavailable', 'ID do bloco: não verificado.');
      return;
    }

    Promise.all([
      global.onpostt.verifySignature(pubkey, signedText, signature),
      verifyBlockId(block, canonical),
    ])
      .then(function (results) {
        if (token !== verifyToken) return;

        var valid = results[0] === true;
        var idValid = results[1];

        if (valid) {
          setStatus(
            'valid',
            'Assinatura válida. O objeto não foi alterado desde a assinatura.'
          );
        } else {
          setStatus(
            'invalid',
            'Assinatura inválida. O conteúdo pode ter sido alterado ou a assinatura não pertence a esta pubkey.'
          );
        }

        if (idValid === true) {
          setIdStatus('valid', 'ID do bloco: confere com o hash do objeto.');
        } else if (idValid === false) {
          setIdStatus('invalid', 'ID do bloco: não confere com o hash do objeto.');
        } else {
          setIdStatus('unavailable', 'ID do bloco: verificação indisponível.');
        }
      })
      .catch(function () {
        if (token !== verifyToken) return;
        setStatus('invalid', 'Não foi possível verificar esta assinatura.');
        setIdStatus('unavailable', 'ID do bloco: não verificado.');
      });
  }

  function button(block) {
    var node = el('button', 'action-button signature-button');
    node.type = 'button';
    node.title = 'Verificar assinatura e integridade';
    node.setAttribute('aria-label', 'Verificar assinatura desta publicação');

    var mark = el('span', 'signature-button-mark', '\u2713');
    mark.setAttribute('aria-hidden', 'true');
    node.appendChild(mark);
    node.appendChild(document.createTextNode('Assinatura'));

    node.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      open(block);
    });

    return node;
  }

  global.onposttSignature = {
    button: button,
    open: open,
    canonical: canonicalBlock,
  };
})(window);
