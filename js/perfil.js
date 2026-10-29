'use strict';

(function () {
  var APP = 'onpostt-demo';
  var ORIGIN = 'http://localhost:3000';
  var IDENTITY_KEY = 'onpostt.demo.identity';
  var MAX_POSTS = 100;
  var MAX_REPOSTS = 100;
  var MAX_REPOST_FETCHES = 30;
  var MAX_PROFILE_LOOKUPS = 50;
  var MAX_SOCIAL = 1000;
  var MAX_PROFILES = 500;
  var MAX_IMAGE_DIMENSION = 500;
  var REACTIONS = ['❤️', '😂', '🔥', '👏', '😮'];
  var COMMENT_LIKE = '👍';
  var COMMENT_DISLIKE = '👎';
  var COMMENT_REACTIONS = [COMMENT_LIKE, COMMENT_DISLIKE];
  var REACTION_SEP = '\u0000';

  var state = {
    identity: null,
    pubkey: null,
    profile: null,
    profiles: new Map(),
    posts: [],
    likes: new Map(),
    comments: new Map(),
    reactions: new Map(),
    reposts: new Map(),
    repostBlocks: [],
    repostPosts: new Map(),
    likedByMe: new Set(),
    myReactions: new Set(),
    repostedByMe: new Set(),
    reactionPending: new Set(),
    repostPending: new Set(),
    openComments: new Set(),
    commentDrafts: new Map(),
    replyTo: new Map(),
    likesTotal: 0,
    commentsTotal: 0,
    followers: 0,
    following: 0,
    followsProfile: false,
    followsViewer: false,
    followPending: false,
    blockedProfile: false,
    blockedByProfile: false,
    blockPending: false,
  };

  var errorTimes = new Map();

  function byId(id) {
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    if (node) node.textContent = '';
  }

  function shortKey(pubkey) {
    if (typeof pubkey !== 'string' || pubkey.length < 16) return pubkey || '—';
    return pubkey.slice(0, 10) + '…' + pubkey.slice(-8);
  }

  function initials(name, pubkey) {
    if (name) {
      var parts = String(name).trim().split(/\s+/).filter(Boolean);
      if (parts.length) return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
    }
    return String(pubkey || '?').replace(/^0x/, '').slice(0, 2).toUpperCase();
  }

  function formatTime(timestamp) {
    if (!timestamp) return '';
    var date = new Date(timestamp * 1000);
    if (!Number.isFinite(date.getTime())) return '';
    return date.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function formatRelative(timestamp) {
    if (!timestamp) return '';
    var seconds = Math.max(0, Math.round(Date.now() / 1000 - timestamp));
    if (seconds < 60) return 'agora';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' min';
    if (seconds < 86400) return Math.floor(seconds / 3600) + ' h';
    return formatTime(timestamp);
  }

  function queryValue(block, key) {
    if (!block || !Array.isArray(block.query)) return undefined;
    for (var i = 0; i < block.query.length; i += 1) {
      var pair = block.query[i];
      if (Array.isArray(pair) && pair[0] === key) return pair[1];
    }
    return undefined;
  }

  var TOPIC_RE = /^[a-z0-9](?:[a-z0-9._-]{0,48}[a-z0-9])?$/;
  var TOPIC_CONTROL_RE = /[\u0000-\u001F\u007F\u2028\u2029]/;

  function normalizeTopic(value) {
    if (typeof value !== 'string' || TOPIC_CONTROL_RE.test(value)) return '';
    var topic = value.trim().toLowerCase();
    if (topic.charAt(0) === '#') topic = topic.slice(1);

    try {
      topic = topic.normalize('NFD').replace(/[\u0300-\u036F]/g, '');
    } catch (error) {
      /* mantém o texto original em motores sem normalize */
    }

    topic = topic
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-._]+|[-._]+$/g, '');

    if (topic.length > 50) topic = topic.slice(0, 50).replace(/[-._]+$/g, '');
    return TOPIC_RE.test(topic) ? topic : '';
  }

  function blockTopics(block) {
    if (!block || block.mode !== 'post') return [];
    var topics = [];
    var seen = Object.create(null);
    var content = block.content;

    function add(value) {
      var topic = normalizeTopic(value);
      if (!topic || seen[topic]) return;
      seen[topic] = true;
      topics.push(topic);
    }

    if (
      content &&
      typeof content === 'object' &&
      !Array.isArray(content) &&
      Array.isArray(content.topics)
    ) {
      content.topics.forEach(add);
    }

    if (Array.isArray(block.query)) {
      block.query.forEach(function (pair) {
        if (Array.isArray(pair) && pair[0] === 'topic') add(pair[1]);
      });
    }

    return topics;
  }

  function topicUrl(topic) {
    return '/?view=feed&topic=' + encodeURIComponent(topic);
  }

  function normalizeImage(image) {
    if (!image || typeof image !== 'object') return null;
    var mime = image.mime;
    var data = image.data;
    var supported =
      (mime === 'image/jpeg' || mime === 'image/png') &&
      typeof data === 'string' &&
      data.length > 0 &&
      data.length <= 128 * 1024 &&
      Number.isInteger(image.width) &&
      Number.isInteger(image.height) &&
      image.width > 0 &&
      image.height > 0 &&
      image.width <= MAX_IMAGE_DIMENSION &&
      image.height <= MAX_IMAGE_DIMENSION;
    if (!supported) return null;
    return {
      mime: mime,
      data: data,
      width: image.width,
      height: image.height,
    };
  }

  function profileData(profile) {
    var content = profile && profile.content;
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      return { name: '', bio: '', image: null };
    }
    return {
      name: typeof content.name === 'string' ? content.name : '',
      bio: typeof content.bio === 'string' ? content.bio : '',
      image: normalizeImage(content.image),
    };
  }

  function profileOf(pubkey) {
    return state.profiles.get(pubkey) || null;
  }

  function displayName(pubkey) {
    var data = profileData(profileOf(pubkey));
    return data.name || shortKey(pubkey);
  }

  function avatarNode(name, pubkey, image, className) {
    var avatar = el('div', 'avatar' + (className ? ' ' + className : ''));
    var photo = normalizeImage(image);
    if (!photo) {
      avatar.textContent = initials(name, pubkey);
      return avatar;
    }

    var img = document.createElement('img');
    img.src = 'data:' + photo.mime + ';base64,' + photo.data;
    img.alt = name ? 'Foto de ' + name : 'Foto do perfil';
    img.width = photo.width;
    img.height = photo.height;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    avatar.appendChild(img);
    return avatar;
  }

  function readIdentity(storage) {
    try {
      var parsed = JSON.parse(storage.getItem(IDENTITY_KEY) || 'null');
      if (!parsed || typeof parsed !== 'object') return null;

      var username = typeof parsed.username === 'string' ? parsed.username : '';
      var createdAt = typeof parsed.createdAt === 'string' ? parsed.createdAt : '';

      if (
        window.onpostt.isValidPrivateKey(parsed.privateKey) &&
        window.onpostt.generatePublicKey(parsed.privateKey) === parsed.publicKey
      ) {
        return {
          publicKey: parsed.publicKey,
          privateKey: parsed.privateKey,
          username: username,
          createdAt: createdAt,
        };
      }

      if (window.onpostt.isValidPublicKey(parsed.publicKey)) {
        return {
          publicKey: parsed.publicKey,
          username: username,
          createdAt: createdAt,
        };
      }
    } catch (error) {
      /* armazenamento indisponível ou identidade inválida */
    }
    return null;
  }

  function loadIdentity() {
    return readIdentity(window.sessionStorage);
  }

  function canWrite() {
    return Boolean(state.identity && state.identity.privateKey);
  }

  function ensureWritable() {
    if (canWrite()) return true;
    showMessage(
      'Para seguir, curtir, reagir, comentar, repostar ou excluir, entre na rede demo neste navegador.'
    );
    return false;
  }

  function profileUrl(pubkey) {
    return '/perfil.html?pubkey=' + encodeURIComponent(pubkey);
  }

  function showMessage(text) {
    var message = byId('profile-message');
    if (!message) return;
    message.textContent = text;
    message.hidden = false;
  }

  function hideMessage() {
    var message = byId('profile-message');
    if (message) message.hidden = true;
  }

  function reportError(message) {
    var key = String(message || 'erro');
    var now = Date.now();
    if (now - (errorTimes.get(key) || 0) < 5000) return;
    errorTimes.set(key, now);
    showMessage(key);
  }

  function setBusy(button, busy) {
    if (!button) return;
    button.disabled = Boolean(busy);
    if (!button.dataset.label) button.dataset.label = button.textContent;
    button.textContent = busy ? 'Aguarde…' : button.dataset.label;
  }

  function setAvatar(name, pubkey, image) {
    var avatar = byId('profile-avatar');
    if (!avatar) return;
    clear(avatar);
    var photo = normalizeImage(image);
    if (!photo) {
      avatar.textContent = initials(name, pubkey);
      return;
    }

    var img = document.createElement('img');
    img.src = 'data:' + photo.mime + ';base64,' + photo.data;
    img.alt = name ? 'Foto de ' + name : 'Foto do perfil';
    img.width = photo.width;
    img.height = photo.height;
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    avatar.appendChild(img);
  }

  async function publish(partial) {
    if (!canWrite()) throw new Error('Chave privada indisponível nesta sessão.');

    var signed = await window.onpostt.signBlock(partial, state.identity.privateKey);
    if (typeof signed === 'string') throw new Error(signed);

    var responses = await window.onpostt.sendBlock(signed);
    var success = responses.filter(function (response) {
      return response && response.status === 'success';
    });

    if (success.length === 0) {
      var message = responses
        .map(function (response) {
          return response && response.message;
        })
        .filter(Boolean)
        .join(' · ');
      throw new Error(message || 'O relay não confirmou o bloco.');
    }

    return { block: signed, responses: responses, result: success[0] };
  }

  function findKnownBlock(id) {
    if (typeof id !== 'string' || !id) return null;

    var post = state.posts.find(function (candidate) {
      return candidate.id === id;
    });
    if (post) return post;

    var repostPost = state.repostPosts.get(id);
    if (repostPost) return repostPost;

    var found = null;
    state.comments.forEach(function (comments) {
      if (found) return;
      found = comments.find(function (candidate) {
        return candidate.id === id;
      });
    });
    return found;
  }

  async function notifyInteraction(targetBlockId, interaction, kind) {
    var target = findKnownBlock(targetBlockId);
    if (!target || !interaction || !state.identity) return;

    var owner = target.pubkey;
    if (!owner || owner === state.identity.publicKey) return;

    try {
      await publish({
        mode: 'notification',
        query: [
          ['to', owner],
          ['block', target.id],
          ['interaction', interaction.id],
          ['kind', kind],
        ],
        app: APP,
      });
    } catch (error) {
      if (window.console && typeof window.console.warn === 'function') {
        window.console.warn('Notificação não enviada:', error.message);
      }
    }
  }

  async function notifyFollow(followBlock, pubkey) {
    if (!followBlock || !followBlock.id || !pubkey || !state.identity) return;
    try {
      await publish({
        mode: 'notification',
        query: [
          ['to', pubkey],
          ['block', followBlock.id],
          ['interaction', followBlock.id],
          ['kind', 'follow'],
        ],
        app: APP,
      });
    } catch (error) {
      if (window.console && typeof window.console.warn === 'function') {
        window.console.warn('Notificação de follow não enviada:', error.message);
      }
    }
  }

  function renderPostContent(article, post) {
    var content = post.content;

    if (typeof content === 'string') {
      if (content) article.appendChild(el('p', 'profile-post-content', content));
      return;
    }

    if (Array.isArray(content)) {
      if (content.length) {
        article.appendChild(el('p', 'profile-post-content', JSON.stringify(content)));
      }
      return;
    }

    if (!content || typeof content !== 'object') {
      if (content !== undefined && content !== null && content !== '') {
        article.appendChild(el('p', 'profile-post-content', JSON.stringify(content)));
      }
      return;
    }

    var text = typeof content.text === 'string' ? content.text : '';
    if (text) article.appendChild(el('p', 'profile-post-content', text));

    if (content.image && typeof content.image === 'object') {
      var image = normalizeImage(content.image);
      if (!image) {
        article.appendChild(el('p', 'profile-post-content muted', '[imagem indisponível]'));
        return;
      }

      var figure = el('figure', 'profile-post-media');
      var img = document.createElement('img');
      img.src = 'data:' + image.mime + ';base64,' + image.data;
      img.alt = text || 'Imagem publicada';
      img.width = image.width;
      img.height = image.height;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      figure.appendChild(img);
      article.appendChild(figure);
      return;
    }

    if (!text && !Array.isArray(content.topics)) {
      article.appendChild(el('p', 'profile-post-content', JSON.stringify(content)));
    }
  }

  function renderPostTopics(article, post) {
    var topics = blockTopics(post);
    if (!topics.length) return;

    var row = el('div', 'profile-post-topics');
    row.setAttribute('aria-label', 'Tópicos da publicação');
    topics.forEach(function (topic) {
      var link = el('a', 'profile-topic-chip', '#' + topic);
      link.href = topicUrl(topic);
      link.setAttribute('aria-label', 'Ver posts sobre #' + topic);
      row.appendChild(link);
    });
    article.appendChild(row);
  }

  function renderReactionBar(post) {
    var reactions = state.reactions.get(post.id) || new Map();
    var bar = el('div', 'reaction-bar');
    bar.setAttribute('aria-label', 'Reações');

    REACTIONS.forEach(function (emoji) {
      var count = reactions.get(emoji) || 0;
      var key = post.id + REACTION_SEP + emoji;
      var active = state.myReactions.has(key);
      var pending = state.reactionPending.has(key);
      var button = el(
        'button',
        'reaction-button' + (active ? ' active' : ''),
        emoji + (count ? ' ' + count : '')
      );
      button.type = 'button';
      button.disabled = pending;
      button.dataset.action = 'reaction';
      button.dataset.block = post.id;
      button.dataset.emoji = emoji;
      button.setAttribute(
        'aria-label',
        (active ? 'Remover reação ' : 'Reagir com ') + emoji + (count ? ' (' + count + ')' : '')
      );
      bar.appendChild(button);
    });

    return bar;
  }

  function commentReactionPending(commentId) {
    return (
      state.reactionPending.has(commentId + REACTION_SEP + COMMENT_LIKE) ||
      state.reactionPending.has(commentId + REACTION_SEP + COMMENT_DISLIKE)
    );
  }

  function renderCommentReactions(postId, comment) {
    var reactions = state.reactions.get(comment.id) || new Map();
    var row = el('div', 'comment-reactions');

    COMMENT_REACTIONS.forEach(function (emoji) {
      var count = reactions.get(emoji) || 0;
      var active = state.myReactions.has(comment.id + REACTION_SEP + emoji);
      var label =
        emoji === COMMENT_LIKE ? 'Curtir comentário' : 'Não curtir comentário';
      var removeLabel =
        emoji === COMMENT_LIKE
          ? 'Remover curtida do comentário'
          : 'Remover não curtida do comentário';
      var button = el(
        'button',
        'comment-reaction ' +
          (emoji === COMMENT_LIKE ? 'like' : 'dislike') +
          (active ? ' active' : ''),
        emoji + (count ? ' ' + count : '')
      );
      button.type = 'button';
      button.disabled = commentReactionPending(comment.id);
      button.dataset.action = 'comment-reaction';
      button.dataset.block = postId;
      button.dataset.comment = comment.id;
      button.dataset.emoji = emoji;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.setAttribute(
        'aria-label',
        (active ? removeLabel : label) + (count ? ' (' + count + ')' : '')
      );
      row.appendChild(button);
    });

    return row;
  }

  function renderComments(post, comments) {
    var box = el('div', 'comment-box');
    var list = el('div', 'comment-list');
    var sorted = comments.slice().sort(function (a, b) {
      return a.created_at - b.created_at;
    });

    if (sorted.length === 0) {
      list.appendChild(el('p', 'faint small mb-0', 'Nenhum comentário ainda.'));
    } else {
      var ids = new Set(
        sorted
          .map(function (comment) {
            return comment.id;
          })
          .filter(Boolean)
      );
      var byParent = new Map();
      var roots = [];

      sorted.forEach(function (comment) {
        var parent = queryValue(comment, 'parent');
        if (typeof parent === 'string' && parent !== comment.id && ids.has(parent)) {
          if (!byParent.has(parent)) byParent.set(parent, []);
          byParent.get(parent).push(comment);
        } else {
          roots.push(comment);
        }
      });

      var rendered = new Set();

      function buildComment(comment, depth) {
        if (!comment || rendered.has(comment.id)) return null;
        rendered.add(comment.id);

        var item = el('div', 'comment' + (depth ? ' reply' : ''));
        var meta = el('div', 'comment-meta');
        var commentData = profileData(profileOf(comment.pubkey));
        var author = el('a', 'comment-author-link');
        author.href = profileUrl(comment.pubkey);
        author.setAttribute('aria-label', 'Abrir perfil de ' + displayName(comment.pubkey));
        author.appendChild(
          avatarNode(commentData.name, comment.pubkey, commentData.image, 'avatar-small')
        );

        var authorMeta = el('div', 'comment-author');
        authorMeta.appendChild(el('strong', '', displayName(comment.pubkey)));
        authorMeta.appendChild(el('small', '', formatRelative(comment.created_at)));
        author.appendChild(authorMeta);
        meta.appendChild(author);

        var actions = el('div', 'comment-actions');
        var replyButton = el('button', 'comment-action', 'Responder');
        replyButton.type = 'button';
        replyButton.dataset.action = 'reply';
        replyButton.dataset.block = post.id;
        replyButton.dataset.comment = comment.id;
        actions.appendChild(replyButton);

        if (state.identity && comment.pubkey === state.identity.publicKey && canWrite()) {
          var deleteButton = el('button', 'comment-action danger', 'Excluir');
          deleteButton.type = 'button';
          deleteButton.dataset.action = 'delete-comment';
          deleteButton.dataset.block = post.id;
          deleteButton.dataset.comment = comment.id;
          actions.appendChild(deleteButton);
        }

        meta.appendChild(actions);
        item.appendChild(meta);
        item.appendChild(
          el('span', 'comment-text', typeof comment.content === 'string' ? comment.content : '')
        );
        item.appendChild(renderCommentReactions(post.id, comment));

        var replies = byParent.get(comment.id) || [];
        if (replies.length) {
          var childBox = el('div', 'comment-replies');
          replies.forEach(function (reply) {
            var child = buildComment(reply, depth + 1);
            if (child) childBox.appendChild(child);
          });
          item.appendChild(childBox);
        }

        return item;
      }

      roots.forEach(function (comment) {
        var node = buildComment(comment, 0);
        if (node) list.appendChild(node);
      });

      // Proteção contra ciclos ou pais ausentes.
      sorted.forEach(function (comment) {
        if (rendered.has(comment.id)) return;
        var node = buildComment(comment, 0);
        if (node) list.appendChild(node);
      });
    }

    box.appendChild(list);

    var replyId = state.replyTo.get(post.id) || null;
    if (replyId && !sorted.some(function (comment) { return comment.id === replyId; })) {
      state.replyTo.delete(post.id);
      replyId = null;
    }

    if (replyId) {
      var replyComment = sorted.find(function (comment) { return comment.id === replyId; });
      var indicator = el('div', 'reply-indicator');
      indicator.appendChild(
        el(
          'span',
          '',
          'Respondendo a ' + (replyComment ? displayName(replyComment.pubkey) : 'comentário') + '…'
        )
      );
      var cancelButton = el('button', 'comment-action', 'Cancelar');
      cancelButton.type = 'button';
      cancelButton.dataset.action = 'cancel-reply';
      cancelButton.dataset.block = post.id;
      indicator.appendChild(cancelButton);
      box.appendChild(indicator);
    }

    var form = el('form', 'comment-form');
    form.dataset.block = post.id;

    var input = el('input', 'input');
    input.type = 'text';
    input.maxLength = 1000;
    input.placeholder = replyId ? 'Escreva uma resposta…' : 'Escreva um comentário…';
    input.value = state.commentDrafts.get(post.id) || '';
    input.dataset.draft = post.id;
    form.appendChild(input);

    var submit = el('button', 'btn btn-primary btn-small', 'Enviar');
    submit.type = 'submit';
    form.appendChild(submit);

    box.appendChild(form);
    return box;
  }

  function renderPost(post, repost) {
    var article = el('article', 'card profile-post' + (repost ? ' profile-repost' : ''));
    article.dataset.block = post.id;
    if (repost) article.dataset.repost = repost.id;

    if (repost) {
      var me = state.identity ? state.identity.publicKey : null;
      var reposterData = profileData(profileOf(repost.pubkey));
      var banner = el('div', 'repost-banner');
      banner.appendChild(el('span', 'repost-mark', '↻'));

      var actorLink = el('a', 'repost-actor');
      actorLink.href = profileUrl(repost.pubkey);
      actorLink.setAttribute(
        'aria-label',
        'Abrir perfil de ' + (repost.pubkey === me ? 'você' : displayName(repost.pubkey))
      );
      actorLink.appendChild(
        avatarNode(reposterData.name, repost.pubkey, reposterData.image, 'avatar-small')
      );
      actorLink.appendChild(
        el(
          'span',
          'repost-actor-name',
          repost.pubkey === me ? 'Você' : displayName(repost.pubkey)
        )
      );
      banner.appendChild(actorLink);

      banner.appendChild(el('span', 'repost-text', ' repostou '));
      banner.appendChild(el('span', 'repost-time', formatRelative(repost.created_at)));
      article.appendChild(banner);
    }

    var head = el('div', 'profile-post-head');
    head.appendChild(el('span', 'profile-post-date', formatTime(post.created_at)));
    head.appendChild(el('span', 'block-id', 'id ' + String(post.id || '').slice(0, 12)));
    article.appendChild(head);

    if (repost) {
      var originalData = profileData(profileOf(post.pubkey));
      var origin = el('div', 'profile-repost-origin');
      origin.appendChild(avatarNode(originalData.name, post.pubkey, originalData.image));
      var originText = el('span', 'profile-repost-origin-text');
      originText.appendChild(document.createTextNode('Publicação original de '));
      var authorLink = el('a', 'profile-repost-author', displayName(post.pubkey));
      authorLink.href = profileUrl(post.pubkey);
      originText.appendChild(authorLink);
      origin.appendChild(originText);
      article.appendChild(origin);
    }

    renderPostContent(article, post);
    renderPostTopics(article, post);
    article.appendChild(renderReactionBar(post));

    var liked = state.likedByMe.has(post.id);
    var likeCount = state.likes.get(post.id) || 0;
    var comments = state.comments.get(post.id) || [];
    var reposted = state.repostedByMe.has(post.id);
    var repostCount = state.reposts.get(post.id) || 0;

    var actions = el('div', 'post-actions');

    var likeButton = el(
      'button',
      'action-button' + (liked ? ' liked' : ''),
      (liked ? '♥ ' : '♡ ') + 'Curtir' + (likeCount ? ' (' + likeCount + ')' : '')
    );
    likeButton.type = 'button';
    likeButton.dataset.action = 'like';
    likeButton.dataset.block = post.id;
    actions.appendChild(likeButton);

    var repostButton = el(
      'button',
      'action-button' + (reposted ? ' reposted' : ''),
      (reposted ? '↻ Repostado' : '↻ Repostar') + (repostCount ? ' (' + repostCount + ')' : '')
    );
    repostButton.type = 'button';
    repostButton.disabled = state.repostPending.has(post.id);
    repostButton.dataset.action = 'repost';
    repostButton.dataset.block = post.id;
    actions.appendChild(repostButton);

    var commentButton = el(
      'button',
      'action-button',
      'Comentar' + (comments.length ? ' (' + comments.length + ')' : '')
    );
    commentButton.type = 'button';
    commentButton.dataset.action = 'comment';
    commentButton.dataset.block = post.id;
    actions.appendChild(commentButton);

    if (state.identity && state.identity.publicKey === post.pubkey && canWrite()) {
      var deleteButton = el('button', 'action-button', 'Excluir');
      deleteButton.type = 'button';
      deleteButton.dataset.action = 'delete';
      deleteButton.dataset.block = post.id;
      actions.appendChild(deleteButton);
    }

    article.appendChild(actions);

    if (state.openComments.has(post.id)) {
      article.appendChild(renderComments(post, comments));
    }

    return article;
  }

  function repostPostFor(block) {
    var target = queryValue(block, 'block');
    if (!target) return null;
    if (state.repostPosts.has(target)) return state.repostPosts.get(target);
    return (
      state.posts.find(function (post) {
        return post.id === target;
      }) || null
    );
  }

  function profileActivityItems() {
    var items = [];

    state.posts.forEach(function (post) {
      if (!post || !post.id) return;
      items.push({
        kind: 'post',
        post: post,
        created_at: post.created_at || 0,
        sortKey: post.id,
      });
    });

    var seenReposts = new Set();
    state.repostBlocks
      .slice()
      .sort(function (a, b) {
        return (b.created_at || 0) - (a.created_at || 0);
      })
      .slice(0, MAX_REPOSTS)
      .forEach(function (repost) {
        if (!repost || !repost.id || seenReposts.has(repost.id)) return;
        var post = repostPostFor(repost);
        if (!post) return;
        seenReposts.add(repost.id);
        items.push({
          kind: 'repost',
          post: post,
          repost: repost,
          created_at: repost.created_at || post.created_at || 0,
          sortKey: repost.id,
        });
      });

    return items.sort(function (a, b) {
      var byTime = (b.created_at || 0) - (a.created_at || 0);
      if (byTime) return byTime;
      return String(b.sortKey || '').localeCompare(String(a.sortKey || ''));
    });
  }

  function renderPosts() {
    var list = byId('profile-posts');
    var empty = byId('profile-posts-empty');
    var caption = byId('profile-posts-caption');
    if (!list) return;

    var items = profileActivityItems();
    var repostCount = items.filter(function (item) {
      return item.kind === 'repost';
    }).length;

    clear(list);
    if (caption) {
      var parts = [];
      if (state.posts.length) {
        parts.push(
          state.posts.length +
            (state.posts.length >= MAX_POSTS ? '+' : '') +
            ' publicação(ões)'
        );
      }
      if (repostCount) {
        parts.push(repostCount + (repostCount >= MAX_REPOSTS ? '+' : '') + ' repost(s)');
      }
      caption.textContent = parts.length
        ? parts.join(' e ') + '.'
        : 'Conteúdo público assinado.';
    }

    if (items.length === 0) {
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;

    items.forEach(function (item) {
      list.appendChild(
        renderPost(item.post, item.kind === 'repost' ? item.repost : null)
      );
    });
  }

  function recalcTotals() {
    var postIds = new Set(
      state.posts
        .map(function (post) {
          return post.id;
        })
        .filter(Boolean)
    );

    state.likesTotal = 0;
    state.commentsTotal = 0;
    postIds.forEach(function (id) {
      state.likesTotal += state.likes.get(id) || 0;
      state.commentsTotal += (state.comments.get(id) || []).length;
    });
  }

  function renderProfile() {
    var data = profileData(state.profile);
    var isSelf = Boolean(state.identity && state.identity.publicKey === state.pubkey);
    var ownName = isSelf && state.identity.username ? state.identity.username : '';
    var name = data.name || ownName || shortKey(state.pubkey);

    document.title = name + ' · onpostt';

    var nameNode = byId('profile-display-name');
    if (nameNode) nameNode.textContent = name;

    var bioNode = byId('profile-bio-text');
    if (bioNode) bioNode.textContent = data.bio || 'Sem bio.';

    var pubkeyNode = byId('profile-pubkey');
    if (pubkeyNode) pubkeyNode.textContent = state.pubkey;

    var selfPill = byId('profile-self');
    if (selfPill) selfPill.hidden = !isSelf;

    var editLink = byId('profile-edit-link');
    if (editLink) editLink.hidden = !isSelf;

    var followButton = byId('profile-follow');
    if (followButton) {
      var canFollow =
        !isSelf && canWrite() && Boolean(state.pubkey) && !state.blockedProfile;
      followButton.hidden = !canFollow;
      followButton.disabled = state.followPending;
      followButton.textContent = state.followsProfile
        ? 'Deixar de seguir'
        : state.followsViewer
          ? 'Seguir de volta'
          : 'Seguir';
      followButton.classList.toggle('btn-primary', !state.followsProfile);
      followButton.classList.toggle('btn-ghost', state.followsProfile);
      followButton.setAttribute(
        'aria-pressed',
        state.followsProfile ? 'true' : 'false'
      );
    }

    var chatButton = byId('profile-chat');
    if (chatButton) {
      var canChat =
        !isSelf && canWrite() && Boolean(state.pubkey) && !state.blockedProfile;
      chatButton.hidden = !canChat;
      chatButton.disabled = state.blockPending;
    }

    var blockButton = byId('profile-block');
    if (blockButton) {
      var canBlock = !isSelf && canWrite() && Boolean(state.pubkey);
      blockButton.hidden = !canBlock;
      blockButton.disabled = state.blockPending;
      blockButton.textContent = state.blockedProfile ? 'Desbloquear' : 'Bloquear';
      blockButton.classList.toggle('btn-ghost', !state.blockedProfile);
    }

    var note = byId('profile-action-note');
    if (note) {
      note.hidden = canWrite();
      note.textContent =
        'Ações sociais exigem a chave privada da identidade. Abra o demo nesta sessão para criar ou usar sua identidade.';
    }

    setAvatar(name, state.pubkey, data.image);

    recalcTotals();

    var statPosts = byId('stat-posts');
    if (statPosts) statPosts.textContent = String(state.posts.length) + (state.posts.length >= MAX_POSTS ? '+' : '');
    var statLikes = byId('stat-likes');
    if (statLikes) statLikes.textContent = String(state.likesTotal);
    var statComments = byId('stat-comments');
    if (statComments) statComments.textContent = String(state.commentsTotal);
    var statReposts = byId('stat-reposts');
    if (statReposts) {
      statReposts.textContent = String(
        state.posts.reduce(function (total, post) {
          return total + (state.reposts.get(post.id) || 0);
        }, 0)
      );
    }
    var statFollowers = byId('stat-followers');
    if (statFollowers) statFollowers.textContent = String(state.followers);
    var statFollowing = byId('stat-following');
    if (statFollowing) statFollowing.textContent = String(state.following);

    renderPosts();
  }

  function applySocial(posts, likeBlocks, commentBlocks, reactionBlocks, repostBlocks, followingBlocks, followerBlocks) {
    var me = state.identity ? state.identity.publicKey : null;
    var postIds = new Set(
      posts
        .map(function (post) {
          return post.id;
        })
        .filter(Boolean)
    );
    state.repostPosts.forEach(function (post, id) {
      if (post && id) postIds.add(id);
    });

    var likes = new Map();
    var likedByMe = new Set();
    likeBlocks.forEach(function (block) {
      var target = queryValue(block, 'block');
      if (!target || !postIds.has(target)) return;
      likes.set(target, (likes.get(target) || 0) + 1);
      if (me && block.pubkey === me) likedByMe.add(target);
    });

    var comments = new Map();
    var commentIds = new Set();
    commentBlocks.forEach(function (block) {
      var target = queryValue(block, 'block');
      if (!target || !postIds.has(target)) return;
      if (!comments.has(target)) comments.set(target, []);
      comments.get(target).push(block);
      if (block.id) commentIds.add(block.id);
    });

    var reactions = new Map();
    var myReactions = new Set();
    reactionBlocks.forEach(function (block) {
      var target = queryValue(block, 'block');
      var emoji = queryValue(block, 'reaction');
      if (
        !target ||
        (!postIds.has(target) && !commentIds.has(target)) ||
        typeof emoji !== 'string'
      ) {
        return;
      }
      if (!reactions.has(target)) reactions.set(target, new Map());
      var byEmoji = reactions.get(target);
      byEmoji.set(emoji, (byEmoji.get(emoji) || 0) + 1);
      if (me && block.pubkey === me) myReactions.add(target + REACTION_SEP + emoji);
    });

    var reposts = new Map();
    var repostedByMe = new Set();
    repostBlocks.forEach(function (block) {
      var target = queryValue(block, 'block');
      if (!target || !postIds.has(target)) return;
      reposts.set(target, (reposts.get(target) || 0) + 1);
      if (me && block.pubkey === me) repostedByMe.add(target);
    });

    state.likes = likes;
    state.likedByMe = likedByMe;
    state.comments = comments;
    state.reactions = reactions;
    state.myReactions = myReactions;
    state.reposts = reposts;
    state.repostedByMe = repostedByMe;
    state.following = followingBlocks.length;
    state.followers = followerBlocks.length;
  }

  async function handleLike(button, blockId) {
    if (!ensureWritable()) return;
    setBusy(button, true);

    try {
      var output = await publish({
        mode: 'like',
        query: [['block', blockId]],
        app: APP,
      });

      if (output.result.action === 'removed') {
        state.likes.set(blockId, Math.max(0, (state.likes.get(blockId) || 1) - 1));
        state.likedByMe.delete(blockId);
      } else {
        state.likes.set(blockId, (state.likes.get(blockId) || 0) + 1);
        state.likedByMe.add(blockId);
        await notifyInteraction(blockId, output.block, 'like');
      }

      renderProfile();
    } catch (error) {
      reportError(error.message);
    } finally {
      setBusy(button, false);
    }
  }

  async function toggleReaction(blockId, emoji) {
    var output = await publish({
      mode: 'reaction',
      query: [
        ['block', blockId],
        ['reaction', emoji],
      ],
      app: APP,
    });

    if (!state.reactions.has(blockId)) state.reactions.set(blockId, new Map());
    var key = blockId + REACTION_SEP + emoji;
    var reactions = state.reactions.get(blockId);
    var count = reactions.get(emoji) || 0;

    if (output.result.action === 'removed') {
      reactions.set(emoji, Math.max(0, count - 1));
      state.myReactions.delete(key);
    } else {
      reactions.set(emoji, count + 1);
      state.myReactions.add(key);
      await notifyInteraction(blockId, output.block, 'reaction');
    }

    return output;
  }

  async function handleReaction(button, blockId, emoji) {
    if (!ensureWritable()) return;
    if (!window.onpostt.isValidReaction(emoji)) {
      reportError('Reação inválida.');
      return;
    }

    var key = blockId + REACTION_SEP + emoji;
    if (state.reactionPending.has(key)) return;
    state.reactionPending.add(key);
    button.disabled = true;

    try {
      await toggleReaction(blockId, emoji);
    } catch (error) {
      reportError(error.message);
    } finally {
      state.reactionPending.delete(key);
      button.disabled = false;
      if (state.pubkey) renderProfile();
    }
  }

  async function handleCommentReaction(button, commentId, emoji) {
    if (!ensureWritable()) return;
    if (!window.onpostt.isValidReaction(emoji)) {
      reportError('Reação inválida.');
      return;
    }

    var likeKey = commentId + REACTION_SEP + COMMENT_LIKE;
    var dislikeKey = commentId + REACTION_SEP + COMMENT_DISLIKE;
    if (state.reactionPending.has(likeKey) || state.reactionPending.has(dislikeKey)) return;

    state.reactionPending.add(likeKey);
    state.reactionPending.add(dislikeKey);
    button.disabled = true;

    try {
      var active = state.myReactions.has(commentId + REACTION_SEP + emoji);
      if (active) {
        await toggleReaction(commentId, emoji);
      } else {
        var opposite = emoji === COMMENT_LIKE ? COMMENT_DISLIKE : COMMENT_LIKE;
        if (state.myReactions.has(commentId + REACTION_SEP + opposite)) {
          await toggleReaction(commentId, opposite);
        }
        await toggleReaction(commentId, emoji);
      }
    } catch (error) {
      reportError(error.message);
    } finally {
      state.reactionPending.delete(likeKey);
      state.reactionPending.delete(dislikeKey);
      button.disabled = false;
      if (state.pubkey) renderProfile();
    }
  }

  function rememberProfileRepost(block) {
    if (!block || block.mode !== 'repost') return;
    if (!state.identity || state.pubkey !== state.identity.publicKey) return;

    var target = queryValue(block, 'block');
    state.repostBlocks = state.repostBlocks.filter(function (candidate) {
      return !(
        candidate &&
        candidate.pubkey === block.pubkey &&
        queryValue(candidate, 'block') === target
      );
    });
    state.repostBlocks.unshift(block);

    var post = findKnownBlock(target);
    if (post) state.repostPosts.set(target, post);
  }

  function forgetProfileRepost(blockId) {
    if (!state.identity || state.pubkey !== state.identity.publicKey) return;
    var me = state.identity.publicKey;
    state.repostBlocks = state.repostBlocks.filter(function (candidate) {
      return !(
        candidate &&
        candidate.pubkey === me &&
        queryValue(candidate, 'block') === blockId
      );
    });
  }

  async function handleRepost(button, blockId) {
    if (!ensureWritable()) return;
    if (state.repostPending.has(blockId)) return;
    state.repostPending.add(blockId);
    setBusy(button, true);

    try {
      var output = await publish({
        mode: 'repost',
        query: [['block', blockId]],
        app: APP,
      });

      if (output.result.action === 'removed') {
        state.reposts.set(blockId, Math.max(0, (state.reposts.get(blockId) || 1) - 1));
        state.repostedByMe.delete(blockId);
        forgetProfileRepost(blockId);
      } else {
        state.reposts.set(blockId, (state.reposts.get(blockId) || 0) + 1);
        state.repostedByMe.add(blockId);
        rememberProfileRepost(output.block);
        await notifyInteraction(blockId, output.block, 'repost');
      }
    } catch (error) {
      reportError(error.message);
    } finally {
      state.repostPending.delete(blockId);
      setBusy(button, false);
      if (state.pubkey) renderProfile();
    }
  }

  async function handleFollow(button) {
    if (!ensureWritable()) return;
    if (
      !state.identity ||
      !state.pubkey ||
      state.pubkey === state.identity.publicKey ||
      state.followPending
    ) {
      return;
    }

    state.followPending = true;
    setBusy(button, true);

    try {
      var output = await publish({
        mode: 'follow',
        query: [
          ['follower', state.identity.publicKey],
          ['following', state.pubkey],
        ],
        app: APP,
      });

      if (output.result.action === 'removed') {
        state.followsProfile = false;
        state.followers = Math.max(0, state.followers - 1);
      } else {
        state.followsProfile = true;
        state.followers += 1;
        await notifyFollow(output.block, state.pubkey);
      }
    } catch (error) {
      reportError(error.message);
    } finally {
      state.followPending = false;
      setBusy(button, false);
      renderProfile();
    }
  }

  async function handleBlock(button) {
    if (!ensureWritable()) return;
    if (!state.identity || !state.pubkey || state.pubkey === state.identity.publicKey) {
      return;
    }
    if (state.blockPending) return;

    if (!state.blockedProfile) {
      var name = profileData(state.profile).name || shortKey(state.pubkey);
      var confirmed = window.confirm(
        'Bloquear ' +
          name +
          '? O bloqueio impede que essa pessoa veja seu perfil no demo e envie mensagens para você.'
      );
      if (!confirmed) return;
    }

    state.blockPending = true;
    setBusy(button, true);
    try {
      var output = await publish({
        mode: 'block',
        query: [
          ['blocker', state.identity.publicKey],
          ['blocked', state.pubkey],
        ],
        app: APP,
      });

      state.blockedProfile = output.result.action !== 'removed';
      showMessage(
        output.result.action === 'removed'
          ? 'Usuário desbloqueado.'
          : 'Usuário bloqueado. Ele não pode ver seu perfil no demo nem enviar mensagens.'
      );
    } catch (error) {
      reportError(error.message);
    } finally {
      state.blockPending = false;
      setBusy(button, false);
      renderProfile();
    }
  }

  function handleCommentToggle(blockId) {
    if (state.openComments.has(blockId)) state.openComments.delete(blockId);
    else state.openComments.add(blockId);
    renderProfile();
  }

  function handleReply(blockId, commentId) {
    state.replyTo.set(blockId, commentId);
    state.openComments.add(blockId);
    renderProfile();

    var form = byId('profile-posts').querySelector('.comment-form[data-block="' + blockId + '"]');
    if (form) {
      var input = form.querySelector('input');
      if (input) input.focus();
    }
  }

  function handleCancelReply(blockId) {
    state.replyTo.delete(blockId);
    renderProfile();
  }

  async function handleComment(form, blockId) {
    if (!ensureWritable()) return;
    var input = form.querySelector('input');
    var content = input ? input.value.trim() : '';
    if (!content) return;

    var button = form.querySelector('button[type="submit"]');
    setBusy(button, true);

    var query = [['block', blockId]];
    var parent = state.replyTo.get(blockId);
    if (parent) query.push(['parent', parent]);

    try {
      var output = await publish({
        mode: 'comment',
        query: query,
        content: content,
        app: APP,
      });
      await notifyInteraction(blockId, output.block, 'comment');

      if (!state.comments.has(blockId)) state.comments.set(blockId, []);
      state.comments.get(blockId).push(output.block);
      state.commentDrafts.delete(blockId);
      state.replyTo.delete(blockId);
      renderProfile();
    } catch (error) {
      reportError(error.message);
    } finally {
      setBusy(button, false);
    }
  }

  async function handleDeleteComment(blockId, commentId) {
    if (!ensureWritable()) return;
    var confirmed = window.confirm('Excluir este comentário?');
    if (!confirmed) return;

    try {
      await publish({
        mode: 'delete',
        query: [['block', commentId]],
        app: APP,
      });

      var comments = state.comments.get(blockId) || [];
      state.comments.set(
        blockId,
        comments.filter(function (comment) {
          return comment.id !== commentId;
        })
      );
      state.replyTo.delete(blockId);
      renderProfile();
    } catch (error) {
      reportError(error.message);
    }
  }

  async function handleDelete(blockId) {
    if (!ensureWritable()) return;
    var confirmed = window.confirm('Excluir esta publicação? O bloco de exclusão é público.');
    if (!confirmed) return;

    try {
      await publish({
        mode: 'delete',
        query: [['block', blockId]],
        app: APP,
      });

      state.posts = state.posts.filter(function (post) {
        return post.id !== blockId;
      });
      state.repostPosts.delete(blockId);
      state.repostBlocks = state.repostBlocks.filter(function (block) {
        return queryValue(block, 'block') !== blockId;
      });
      state.openComments.delete(blockId);
      state.commentDrafts.delete(blockId);
      state.replyTo.delete(blockId);
      renderProfile();
    } catch (error) {
      reportError(error.message);
    }
  }

  function renderSearchResults(profiles, term) {
    var box = byId('profile-search-results');
    if (!box) return;
    clear(box);
    box.hidden = false;

    if (profiles.length === 0) {
      box.appendChild(el('p', 'faint small mb-0', 'Nenhum perfil corresponde a “' + term + '”.'));
      return;
    }

    profiles.forEach(function (profile) {
      var data = profileData(profile);
      var link = el('a', 'profile-search-result');
      link.href = profileUrl(profile.pubkey);
      link.appendChild(avatarNode(data.name, profile.pubkey, data.image, 'avatar-small'));

      var meta = el('span', 'profile-search-result-meta');
      meta.appendChild(el('strong', '', data.name || shortKey(profile.pubkey)));
      meta.appendChild(el('small', 'mono', shortKey(profile.pubkey)));
      link.appendChild(meta);
      box.appendChild(link);
    });
  }

  async function searchProfiles(term) {
    var button = byId('profile-search-button');
    setBusy(button, true);

    try {
      var profiles = await window.onpostt.list({ mode: 'profile', limit: MAX_PROFILES });
      var lower = term.toLowerCase();
      var matches = profiles
        .filter(function (profile) {
          if (!profile || typeof profile.pubkey !== 'string') return false;
          var data = profileData(profile);
          return (
            profile.pubkey.toLowerCase().includes(lower) ||
            data.name.toLowerCase().includes(lower)
          );
        })
        .sort(function (a, b) {
          var nameA = profileData(a).name || a.pubkey;
          var nameB = profileData(b).name || b.pubkey;
          return nameA.localeCompare(nameB, 'pt-BR');
        });

      matches.forEach(function (profile) {
        if (profile && profile.pubkey) state.profiles.set(profile.pubkey, profile);
      });

      renderSearchResults(matches, term);
    } catch (error) {
      reportError('Não foi possível buscar perfis: ' + error.message);
    } finally {
      setBusy(button, false);
    }
  }

  async function loadCommenterProfiles() {
    var pubkeys = new Set();
    state.comments.forEach(function (comments) {
      comments.forEach(function (comment) {
        if (comment && comment.pubkey) pubkeys.add(comment.pubkey);
      });
    });

    var missing = Array.from(pubkeys)
      .filter(function (candidate) {
        return (
          candidate &&
          !state.profiles.has(candidate) &&
          window.onpostt.isValidPublicKey(candidate)
        );
      })
      .slice(0, 50);

    await Promise.all(
      missing.map(function (candidate) {
        return window.onpostt
          .list({ mode: 'profile', pubkey: candidate, limit: 1 })
          .then(function (profiles) {
            if (profiles && profiles[0]) state.profiles.set(candidate, profiles[0]);
          })
          .catch(function () {
            /* perfil ausente: o comentário usa as iniciais da pubkey */
          });
      })
    );
  }

  async function loadProfileReposts(pubkey, posts, repostBlocks) {
    var map = new Map();
    posts.forEach(function (post) {
      if (post && post.id) map.set(post.id, post);
    });

    var blocks = repostBlocks
      .filter(function (block) {
        return block && block.mode === 'repost' && block.pubkey === pubkey;
      })
      .sort(function (a, b) {
        return (b.created_at || 0) - (a.created_at || 0);
      })
      .slice(0, MAX_REPOSTS);

    var missing = [];
    var seen = new Set();
    blocks.forEach(function (block) {
      var target = queryValue(block, 'block');
      if (!target || seen.has(target) || map.has(target)) return;
      seen.add(target);
      missing.push(target);
    });

    var fetched = await Promise.all(
      missing.slice(0, MAX_REPOST_FETCHES).map(function (id) {
        return window.onpostt
          .list({ mode: 'post', id: id, limit: 1 })
          .then(function (list) {
            return list && list[0] && list[0].mode === 'post' ? list[0] : null;
          })
          .catch(function () {
            return null;
          });
      })
    );

    fetched.forEach(function (post) {
      if (post && post.id) map.set(post.id, post);
    });

    state.repostBlocks = blocks;
    state.repostPosts = map;
  }

  async function loadPostAuthorProfiles() {
    var pubkeys = new Set();
    state.repostPosts.forEach(function (post) {
      if (post && post.pubkey && !state.profiles.has(post.pubkey)) {
        pubkeys.add(post.pubkey);
      }
    });

    var missing = Array.from(pubkeys).slice(0, MAX_PROFILE_LOOKUPS);
    await Promise.all(
      missing.map(function (candidate) {
        return window.onpostt
          .list({ mode: 'profile', pubkey: candidate, limit: 1 })
          .then(function (profiles) {
            if (profiles && profiles[0]) state.profiles.set(candidate, profiles[0]);
          })
          .catch(function () {
            /* autor sem perfil público: usa as iniciais da pubkey */
          });
      })
    );
  }

  async function load(pubkey) {
    var target = String(pubkey || '').toLowerCase();
    state.pubkey = target;
    state.followPending = false;
    state.blockPending = false;
    state.followsViewer = false;
    state.blockedProfile = false;
    state.blockedByProfile = false;
    hideMessage();

    var me = state.identity ? state.identity.publicKey.toLowerCase() : null;
    var viewerFollowQuery =
      me && me !== target
        ? window.onpostt.list({
            mode: 'follow',
            query: [
              ['follower', me],
              ['following', target],
            ],
            limit: 1,
          })
        : Promise.resolve([]);
    var viewerBlockQuery =
      me && me !== target
        ? window.onpostt.list({
            mode: 'block',
            query: [
              ['blocker', me],
              ['blocked', target],
            ],
            limit: 1,
          })
        : Promise.resolve([]);
    var targetBlockQuery =
      me && me !== target
        ? window.onpostt.list({
            mode: 'block',
            query: [
              ['blocker', target],
              ['blocked', me],
            ],
            limit: 1,
          })
        : Promise.resolve([]);

    var results = await Promise.all([
      window.onpostt.list({ mode: 'profile', pubkey: target, limit: 1 }),
      window.onpostt.list({ mode: 'post', pubkey: target, limit: MAX_POSTS }),
      window.onpostt.list({ mode: 'like', limit: MAX_SOCIAL }),
      window.onpostt.list({ mode: 'comment', limit: MAX_SOCIAL }),
      window.onpostt.list({ mode: 'reaction', limit: MAX_SOCIAL }),
      window.onpostt.list({ mode: 'repost', limit: MAX_SOCIAL }),
      window.onpostt.list({ mode: 'follow', query: [['follower', target]], limit: MAX_SOCIAL }),
      window.onpostt.list({ mode: 'follow', query: [['following', target]], limit: MAX_SOCIAL }),
      viewerFollowQuery,
      viewerBlockQuery,
      targetBlockQuery,
    ]);

    state.profile = results[0][0] || null;

    if (
      !state.profile &&
      state.identity &&
      canWrite() &&
      state.identity.username &&
      target === state.identity.publicKey.toLowerCase()
    ) {
      try {
        await publish({
          mode: 'profile',
          query: [],
          content: { name: state.identity.username, bio: '' },
          app: APP,
        });
        var created = await window.onpostt.list({
          mode: 'profile',
          pubkey: target,
          limit: 1,
        });
        state.profile = (created && created[0]) || state.profile;
      } catch (error) {
        /* o perfil inicial é opcional; a página continua somente para leitura */
      }
    }

    state.profiles = new Map();
    if (state.profile && state.profile.pubkey) {
      state.profiles.set(state.profile.pubkey, state.profile);
    }

    state.posts = results[1].filter(function (post) {
      return post && post.mode === 'post';
    });
    state.followsProfile = Boolean(results[8] && results[8].length);
    state.followsViewer = Boolean(
      me &&
        results[6].some(function (block) {
          return String(queryValue(block, 'following') || '').toLowerCase() === me;
        })
    );
    state.blockedProfile = Boolean(results[9] && results[9].length);
    state.blockedByProfile = Boolean(results[10] && results[10].length);

    var blockedSection = byId('profile-blocked');
    if (state.blockedByProfile && me && me !== target) {
      byId('profile-loading').hidden = true;
      byId('profile-view').hidden = true;
      if (blockedSection) blockedSection.hidden = false;
      return;
    }
    if (blockedSection) blockedSection.hidden = true;

    await loadProfileReposts(target, state.posts, results[5]);

    applySocial(
      state.posts,
      results[2],
      results[3],
      results[4],
      results[5],
      results[6],
      results[7]
    );

    await Promise.all([loadCommenterProfiles(), loadPostAuthorProfiles()]);

    byId('profile-loading').hidden = true;
    byId('profile-view').hidden = false;
    renderProfile();
  }

  function selectedPubkey() {
    var params = new URLSearchParams(window.location.search);
    var requested = (params.get('pubkey') || '').trim();
    if (requested) return { pubkey: requested, invalid: !window.onpostt.isValidPublicKey(requested) };
    if (state.identity) return { pubkey: state.identity.publicKey, invalid: false };
    return { pubkey: '', invalid: false };
  }

  /* ---------------------------------------------------------------------- */
  /* App completo reaproveitado do index.html                               */
  /* ---------------------------------------------------------------------- */

  var APP_VIEWS = ['feed', 'profiles', 'notifications', 'chat', 'about'];

  function appMain() {
    var shell = byId('app-shell');
    return shell ? shell.querySelector('.demo-main') : null;
  }

  function relayReady() {
    return Boolean(
      window.onpostt &&
        Array.isArray(window.onpostt.hosts) &&
        window.onpostt.hosts.length > 0
    );
  }

  function setNet(status, label) {
    var pill = byId('net-status');
    var dot = pill && pill.querySelector('.status-dot');
    if (dot) {
      dot.classList.remove('ok', 'warn', 'error');
      if (status) dot.classList.add(status);
    }
    var text = byId('net-label');
    if (text) text.textContent = label;
  }

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  async function waitForRelay(timeout) {
    var deadline = Date.now() + (timeout || 8000);
    while (!relayReady() && Date.now() < deadline) await delay(100);
    return relayReady();
  }

  async function ensureRelay() {
    if (!relayReady() && appMain()) await waitForRelay(8000);
    if (relayReady()) {
      if (!appMain()) setNet('ok', 'online');
      return true;
    }

    try {
      await window.onpostt.connect({ host: [ORIGIN] });
    } catch (error) {
      if (!appMain()) setNet('error', 'offline');
      reportError('Não foi possível conectar ao relay: ' + error.message);
      return false;
    }
    if (!appMain()) setNet(relayReady() ? 'ok' : 'warn', relayReady() ? 'online' : 'offline');
    return relayReady();
  }

  function setActiveNav(view) {
    var buttons = document.querySelectorAll('.nav-button[data-view]');
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].classList.toggle('active', buttons[i].dataset.view === view);
    }
  }

  function showProfilePage() {
    var page = byId('profile-page');
    var main = appMain();
    if (main) main.hidden = true;
    if (page) page.hidden = false;
    setActiveNav('profile');
  }

  function showAppView() {
    var page = byId('profile-page');
    var main = appMain();
    if (page) page.hidden = true;
    if (main) main.hidden = false;
  }

  function handleNavClick(button) {
    var view = button.dataset.view;
    if (view === 'profile') {
      showProfilePage();
      return;
    }
    if (APP_VIEWS.indexOf(view) === -1 || !appMain()) {
      if (APP_VIEWS.indexOf(view) !== -1) {
        window.location.assign('/?view=' + encodeURIComponent(view));
      }
      return;
    }

    showAppView();

    // O app.js pode ainda não ter ligado os eventos no primeiro clique.
    if (!relayReady() && !button.dataset.navRetry) {
      button.dataset.navRetry = '1';
      waitForRelay(8000).then(function () {
        delete button.dataset.navRetry;
        if (relayReady()) button.click();
      });
    }
  }

  async function openChatWith(pubkey) {
    if (!pubkey || !window.onpostt || !window.onpostt.isValidPublicKey(pubkey)) return;
    if (state.identity && pubkey.toLowerCase() === state.identity.publicKey.toLowerCase()) return;

    var fallback = '/?view=chat&peer=' + encodeURIComponent(pubkey);
    var form = byId('open-chat-form');
    var input = byId('peer-input');

    if (!appMain() || !form || !input || !(await waitForRelay(8000))) {
      window.location.assign(fallback);
      return;
    }

    var nav = document.querySelector('.nav-button[data-view="chat"]');
    if (nav) nav.click();
    showAppView();

    var attempts = 0;
    function attempt() {
      var label = byId('chat-peer-key');
      if (label && label.textContent.trim().toLowerCase() === pubkey.toLowerCase()) return;

      attempts += 1;
      input.value = pubkey;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      if (attempts < 4) setTimeout(attempt, 500);
    }
    attempt();
  }

  function bindEvents() {
    document.addEventListener('click', function (event) {
      var button =
        event.target && event.target.closest
          ? event.target.closest('.nav-button')
          : null;
      if (button) handleNavClick(button);
    });

    var copyButton = byId('copy-pubkey');
    if (copyButton) {
      copyButton.addEventListener('click', function () {
        if (!state.pubkey) return;
        var previous = copyButton.textContent;
        var done = function () {
          copyButton.textContent = 'Copiado';
          setTimeout(function () {
            copyButton.textContent = previous;
          }, 1400);
        };
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(state.pubkey).then(done, function () {
            showMessage('Não foi possível copiar a pubkey.');
          });
          return;
        }
        showMessage('Seu navegador não permite copiar automaticamente.');
      });
    }

    var followButton = byId('profile-follow');
    if (followButton) {
      followButton.addEventListener('click', function () {
        handleFollow(followButton);
      });
    }

    var blockButton = byId('profile-block');
    if (blockButton) {
      blockButton.addEventListener('click', function () {
        handleBlock(blockButton);
      });
    }

    var chatButton = byId('profile-chat');
    if (chatButton) {
      chatButton.addEventListener('click', function () {
        openChatWith(state.pubkey);
      });
    }

    // Sem o app completo (visitante anônimo), o botão de identidade leva ao login.
    var identityButton = byId('identity-button');
    if (identityButton && !appMain()) {
      identityButton.addEventListener('click', function () {
        window.location.assign(state.identity ? '/' : '/login.html');
      });
    }

    var searchForm = byId('profile-search-form');
    if (searchForm) {
      searchForm.addEventListener('submit', function (event) {
        event.preventDefault();
        var input = byId('profile-search-input');
        var value = input ? input.value.trim() : '';
        if (!value) {
          showMessage('Informe um nome ou uma pubkey para buscar.');
          return;
        }
        if (window.onpostt.isValidPublicKey(value)) {
          window.location.assign(profileUrl(value));
          return;
        }
        searchProfiles(value);
      });
    }

    var refreshButton = byId('refresh-profile');
    if (refreshButton) {
      refreshButton.addEventListener('click', function () {
        if (!state.pubkey) return;
        setBusy(refreshButton, true);
        load(state.pubkey)
          .catch(function (error) {
            reportError(error.message);
          })
          .finally(function () {
            setBusy(refreshButton, false);
          });
      });
    }

    var posts = byId('profile-posts');
    if (posts) {
      posts.addEventListener('click', function (event) {
        var button = event.target.closest('[data-action]');
        if (!button) return;
        var blockId = button.dataset.block;
        var commentId = button.dataset.comment;
        if (!blockId) return;

        if (button.dataset.action === 'like') handleLike(button, blockId);
        if (button.dataset.action === 'repost') handleRepost(button, blockId);
        if (button.dataset.action === 'reaction') {
          handleReaction(button, blockId, button.dataset.emoji);
        }
        if (button.dataset.action === 'comment-reaction' && commentId) {
          handleCommentReaction(button, commentId, button.dataset.emoji);
        }
        if (button.dataset.action === 'comment') handleCommentToggle(blockId);
        if (button.dataset.action === 'reply' && commentId) handleReply(blockId, commentId);
        if (button.dataset.action === 'cancel-reply') handleCancelReply(blockId);
        if (button.dataset.action === 'delete-comment' && commentId) {
          handleDeleteComment(blockId, commentId);
        }
        if (button.dataset.action === 'delete') handleDelete(blockId);
      });

      posts.addEventListener('input', function (event) {
        var input = event.target;
        if (input && input.dataset && input.dataset.draft) {
          state.commentDrafts.set(input.dataset.draft, input.value);
        }
      });

      posts.addEventListener('submit', function (event) {
        var form = event.target.closest('.comment-form');
        if (!form) return;
        event.preventDefault();
        handleComment(form, form.dataset.block);
      });
    }
  }

  window.addEventListener('onpostt:logout', function () {
    if (state.identity) window.location.reload();
  });

  async function init() {
    if (!window.onpostt) {
      var loading = byId('profile-loading');
      if (loading) loading.hidden = true;
      showMessage('A biblioteca onpostt não carregou.');
      return;
    }

    state.identity = loadIdentity();
    if ((!state.identity || !state.identity.privateKey) && window.onposttAuth) {
      try {
        var restored = await window.onposttAuth.ensureSession();
        if (restored) state.identity = restored;
      } catch (error) {
        /* sem sessão persistente: o perfil continua somente para leitura */
      }
    }
    bindEvents();

    var identityButton = byId('identity-button');
    if (identityButton && !appMain()) {
      identityButton.textContent = state.identity
        ? state.identity.username || shortKey(state.identity.publicKey)
        : 'Entrar';
      identityButton.title = state.identity
        ? 'Abrir o app completo'
        : 'Entrar com uma identidade';
    }

    if (state.identity && state.identity.privateKey) {
      try {
        await window.onpostt.setReaderKey(state.identity.privateKey);
      } catch (error) {
        reportError('Não foi possível preparar a leitura autenticada: ' + error.message);
      }
    }

    if (!(await ensureRelay())) {
      byId('profile-loading').hidden = true;
      return;
    }

    var selected = selectedPubkey();
    var searchInput = byId('profile-search-input');
    if (searchInput && selected.pubkey) searchInput.value = selected.pubkey;

    if (!selected.pubkey) {
      byId('profile-loading').hidden = true;
      showMessage('Nenhum perfil selecionado. Busque por nome ou pubkey para abrir um perfil.');
      return;
    }

    if (selected.invalid) {
      byId('profile-loading').hidden = true;
      showMessage('Pubkey inválida. Use a chave pública completa.');
      return;
    }

    try {
      await load(selected.pubkey);
    } catch (error) {
      byId('profile-loading').hidden = true;
      showMessage('Não foi possível carregar este perfil: ' + error.message);
    }
  }






  init();
})();
