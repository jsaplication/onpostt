'use strict';

(function () {
  var APP = 'onpostt-demo';
  // A página messages.html reaproveita este mesmo app.js, mas carrega somente
  // o necessário para as conversas (sem feed, trending e notificações).
  var MESSAGES_PAGE = document.body.classList.contains('messages-body');
  // post.html também reaproveita o app.js, mas exibe somente uma publicação.
  var POST_PAGE = document.body.classList.contains('post-body');

  // Configuração central em js/relay.js. O fallback mantém o app funcionando
  // mesmo se aquele arquivo não for carregado.
  var RELAY =
    window.onposttRelay && Array.isArray(window.onposttRelay.hosts)
      ? window.onposttRelay
      : (function () {
          var fallbackHosts = ['http://localhost:3000'];
          return {
            hosts: fallbackHosts,
            sockets: fallbackHosts.map(function (url) {
              return url.replace(/^http/i, 'ws');
            }),
            url: function (path) {
              return fallbackHosts[0] + path;
            },
          };
        })();

  var ORIGIN = RELAY.hosts;
  var WS_URL = RELAY.sockets;

  // Relays que responderam à última verificação. O relay.js remove da
  // conexão os hosts fora do ar para não travar as listagens (a biblioteca
  // espera todos os hosts responderem).
  function relayConnectOptions() {
    if (RELAY && typeof RELAY.connectOptions === 'function') return RELAY.connectOptions();
    return { host: ORIGIN, socket: WS_URL };
  }
  // O feed carrega uma página pequena e cresce sob demanda com offset.
  var FEED_PAGE_SIZE = 20;
  var MAX_FEED_PAGE_SIZE = 200;
  var MAX_TOPIC_POSTS = 100;
  var MAX_TOPICS = 5;
  var MAX_LINK_PREVIEWS = 3;
  var LINK_PREVIEW_DELAY_MS = 450;
  var TRENDING_LIMIT = 10;
  var TRENDING_WINDOW_SECONDS = 7 * 24 * 60 * 60;
  var TRENDING_REFRESH_MS = 15000;
  var MAX_REPOSTS = 100;
  var MAX_REPOST_FETCHES = 30;
  var MAX_REPOST_PROFILE_LOOKUPS = 50;
  var MAX_SOCIAL = 500;
  var MAX_COMMENT_INDEX = 200;
  var MAX_COMMENTS_PER_POST = 200;
  var MAX_PROFILE_SUGGESTIONS = 24;
  var MAX_NEW_CHAT_PROFILE_LOOKUPS = 120;
  var PROFILE_SEARCH_PAGE = 100;
  var MAX_PROFILE_SEARCH = 500;
  var MAX_NOTIFICATIONS = 200;
  var MAX_INBOX = 1000;
  var MAX_MESSAGE_READS = 1000;
  var MESSAGE_READ_BATCH = 500;
  var MAX_CHAT_IMAGE_DIMENSION = 500;
  var MAX_CHAT_IMAGE_BYTES = 64 * 1024;
  var MAX_CHAT_AUDIO_BASE64 = 180000;
  var MAX_CHAT_AUDIO_BYTES = 135000;
  var CHAT_AUDIO_LIMIT_MS = 15000;
  var HIDDEN_CHATS_PREFIX = 'onpostt.demo.hidden.';
  var COMMENT_LIKE = '👍';
  var COMMENT_DISLIKE = '👎';
  var COMMENT_REACTIONS = [COMMENT_LIKE, COMMENT_DISLIKE];
  var REACTION_SEP = '\u0000';

  var state = {
    identity: null,
    posts: [],
    profiles: new Map(),
    likes: new Map(),
    reactions: new Map(),
    comments: new Map(),
    commentLoading: new Set(),
    commentLoaded: new Set(),
    reposts: new Map(),
    repostBlocks: [],
    repostPosts: new Map(),
    following: new Set(),
    followers: new Set(),
    blocked: new Set(),
    blockedBy: new Set(),
    likedByMe: new Set(),
    myReactions: new Set(),
    repostedByMe: new Set(),
    reactionPending: new Set(),
    repostPending: new Set(),
    openComments: new Set(),
    commentDrafts: new Map(),
    replyTo: new Map(),
    view: 'feed',
    feedMode: 'global',
    feedPageCount: 1,
    feedOffset: 0,
    feedHasMore: false,
    feedLoadingMore: false,
    composeTopics: [],
    topicFilter: null,
    topicPosts: [],
    topicLoading: false,
    trending: [],
    trendingLoading: false,
    trendingError: '',
    trendingFetchedAt: 0,
    peer: null,
    chatQuery: '',
    newChatQuery: '',
    chat: new Map(),
    chatPending: new Set(),
    chatUnsubs: [],
    inbox: new Map(),
    outbox: new Map(),
    hiddenChats: new Map(),
    messageRead: new Set(),
    chatMediaBusy: false,
    audioRecording: null,
    profileDirty: false,
    profileLookups: new Set(),
    refreshing: false,
    refreshQueued: false,
    pendingImage: null,
    imageBusy: false,
    profilePhoto: null,
    pendingProfileImage: null,
    profileImageBusy: false,
    profileImageRemoved: false,
    profileQuery: '',
    suggestedPubkeys: [],
    profileSearchResults: new Map(),
    profileSearchTerm: '',
    profileSearchOffset: 0,
    profileSearchHasMore: false,
    profileSearchLoading: false,
    profileSearchSeq: 0,
    notifications: [],
    notificationRead: new Set(),
    showReadNotifications: false,
    detail: null,
    ready: false,
  };

  var MAX_IMAGE_BYTES = 64 * 1024;
  var MAX_IMAGE_SOURCE_BYTES = 12 * 1024 * 1024;
  var MAX_IMAGE_DIMENSION = 500;
  var MAX_PROFILE_IMAGE_DIMENSION = 150;

  var refreshTimer = null;
  var composePreviewTimer = null;
  var profileSearchTimer = null;
  var linkPreviewCache = new Map();
  var errorTimes = new Map();

  /* ---------------------------------------------------------------------- */
  /* DOM helpers                                                            */
  /* ---------------------------------------------------------------------- */

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
    return pubkey.slice(0, 8) + '…' + pubkey.slice(-6);
  }

  function sameKey(a, b) {
    return (
      typeof a === 'string' &&
      typeof b === 'string' &&
      a.toLowerCase() === b.toLowerCase()
    );
  }

  function initials(name, pubkey) {
    if (name) {
      var parts = String(name).trim().split(/\s+/).filter(Boolean);
      if (parts.length) return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
    }
    return String(pubkey || '?').replace(/^0x/, '').slice(0, 2).toUpperCase();
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

  function normalizeAudio(audio) {
    if (!audio || typeof audio !== 'object') return null;
    var mime = typeof audio.mime === 'string' ? audio.mime.split(';')[0].toLowerCase() : '';
    var data = audio.data;
    var duration = Number(audio.duration);
    var supportedMime = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav'].includes(
      mime
    );
    var validData =
      typeof data === 'string' &&
      data.length > 0 &&
      data.length <= MAX_CHAT_AUDIO_BASE64 &&
      /^[A-Za-z0-9+/=]+$/.test(data);
    if (!supportedMime || !validData || !Number.isFinite(duration) || duration <= 0 || duration > 16) {
      return null;
    }
    return {
      mime: mime,
      data: data,
      duration: Math.round(duration * 10) / 10,
    };
  }

  function avatarNode(name, pubkey, image, className) {
    var avatar = el('div', 'avatar' + (className ? ' ' + className : ''));
    var photo = normalizeImage(image);
    if (photo) {
      var img = document.createElement('img');
      img.src = 'data:' + photo.mime + ';base64,' + photo.data;
      img.alt = name ? 'Foto de ' + name : 'Foto do perfil';
      img.width = photo.width;
      img.height = photo.height;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      avatar.appendChild(img);
    } else {
      avatar.textContent = initials(name, pubkey);
    }
    return avatar;
  }

  function formatTime(timestamp) {
    if (!timestamp) return '';
    var date = new Date(timestamp * 1000);
    if (!Number.isFinite(date.getTime())) return '';
    return date.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
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

  function formatDayLabel(timestamp) {
    if (!timestamp) return '';
    var date = new Date(timestamp * 1000);
    if (!Number.isFinite(date.getTime())) return '';

    var today = new Date();
    var yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);

    if (date.toDateString() === today.toDateString()) return 'Hoje';
    if (date.toDateString() === yesterday.toDateString()) return 'Ontem';
    return date.toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  }

  function queryValue(block, key) {
    if (!block || !Array.isArray(block.query)) return undefined;
    for (var i = 0; i < block.query.length; i += 1) {
      if (Array.isArray(block.query[i]) && block.query[i][0] === key) return block.query[i][1];
    }
    return undefined;
  }

  function contentObject(block) {
    var content = block && block.content;
    if (typeof content === 'string') {
      try {
        content = JSON.parse(content);
      } catch (error) {
        return null;
      }
    }
    return content && typeof content === 'object' ? content : null;
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

  function extractTopicsFromText(text) {
    if (typeof text !== 'string' || !text) return [];
    var topics = [];
    var seen = Object.create(null);
    var re = /(^|[\s([{>])#([^\s#<>"'`]+)/g;
    var match;

    while ((match = re.exec(text))) {
      var raw = match[2].replace(/[.,;:!?)\]}]+$/g, '');
      var topic = normalizeTopic(raw);
      if (!topic || seen[topic]) continue;
      seen[topic] = true;
      topics.push(topic);
    }

    return topics;
  }

  function trimUrlCandidate(value) {
    var candidate = String(value || '').replace(/[.,;:!?]+$/g, '');

    while (candidate) {
      var last = candidate.charAt(candidate.length - 1);
      if (
        last === ')' &&
        (candidate.match(/\)/g) || []).length > (candidate.match(/\(/g) || []).length
      ) {
        candidate = candidate.slice(0, -1);
        continue;
      }
      if (
        last === ']' &&
        (candidate.match(/\]/g) || []).length > (candidate.match(/\[/g) || []).length
      ) {
        candidate = candidate.slice(0, -1);
        continue;
      }
      if (
        last === '}' &&
        (candidate.match(/\}/g) || []).length > (candidate.match(/\{/g) || []).length
      ) {
        candidate = candidate.slice(0, -1);
        continue;
      }
      break;
    }

    return candidate;
  }

  function hrefForUrl(value) {
    return /^www\./i.test(value) ? 'https://' + value : value;
  }

  function hostnameOf(value) {
    try {
      return new URL(value).hostname.replace(/^www\./i, '');
    } catch (error) {
      return '';
    }
  }

  function extractUrls(text) {
    if (typeof text !== 'string' || !text) return [];
    var results = [];
    var seen = Object.create(null);
    var re = /(?:\bhttps?:\/\/|\bwww\.)[^\s<>"']+/gi;
    var match;

    while ((match = re.exec(text))) {
      var candidate = trimUrlCandidate(match[0]);
      if (!candidate) continue;
      var href = hrefForUrl(candidate);
      try {
        var parsed = new URL(href);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
        href = parsed.href;
      } catch (error) {
        continue;
      }
      var key = href.toLowerCase();
      if (seen[key]) continue;
      seen[key] = true;
      results.push({ text: candidate, href: href });
    }

    return results;
  }

  function appendLinkifiedText(parent, text) {
    var re = /(?:\bhttps?:\/\/|\bwww\.)[^\s<>"']+/gi;
    var last = 0;
    var match;

    while ((match = re.exec(text))) {
      var candidate = trimUrlCandidate(match[0]);
      if (!candidate) continue;
      var href = hrefForUrl(candidate);
      try {
        var parsed = new URL(href);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
        href = parsed.href;
      } catch (error) {
        continue;
      }

      if (match.index > last) {
        parent.appendChild(document.createTextNode(text.slice(last, match.index)));
      }

      var link = document.createElement('a');
      link.className = 'post-link';
      link.href = href;
      link.textContent = candidate;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      parent.appendChild(link);

      last = match.index + candidate.length;
      re.lastIndex = last;
    }

    if (last < text.length) {
      parent.appendChild(document.createTextNode(text.slice(last)));
    }
  }

  function appendPostText(article, text) {
    if (!text) return;

    var paragraph = el('p', 'post-content');
    appendLinkifiedText(paragraph, text);
    article.appendChild(paragraph);

    if (extractUrls(text).length) {
      var previews = el('div', 'link-previews');
      article.appendChild(previews);
      renderLinkPreviews(previews, text);
    }
  }

  function fetchLinkPreview(url) {
    if (linkPreviewCache.has(url)) return linkPreviewCache.get(url);

    var promise = fetch('/api/link-preview?url=' + encodeURIComponent(url), {
      headers: { Accept: 'application/json' },
    })
      .then(function (response) {
        if (!response.ok) throw new Error('Prévia indisponível.');
        return response.json();
      })
      .then(function (data) {
        if (
          !data ||
          (!data.title && !data.description && !data.image)
        ) {
          return null;
        }
        return data;
      })
      .catch(function () {
        return null;
      });

    linkPreviewCache.set(url, promise);
    return promise;
  }

  function createLinkPreviewCard(link) {
    var card = document.createElement('a');
    card.className = 'link-preview';
    card.href = link.href;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    card.hidden = true;

    var media = el('div', 'link-preview-media');
    media.hidden = true;
    var image = document.createElement('img');
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    media.appendChild(image);
    card.appendChild(media);

    var body = el('div', 'link-preview-body');
    var site = el('span', 'link-preview-site', hostnameOf(link.href));
    var title = el('strong', 'link-preview-title', '');
    var description = el('span', 'link-preview-description', '');
    description.hidden = true;
    var urlText = el('span', 'link-preview-url', link.text);
    body.appendChild(site);
    body.appendChild(title);
    body.appendChild(description);
    body.appendChild(urlText);
    card.appendChild(body);

    return card;
  }

  function fillLinkPreview(card, data) {
    var href = data.finalUrl || data.url || card.href;
    try {
      var parsed = new URL(href);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        href = parsed.href;
        card.href = href;
      }
    } catch (error) {
      /* mantém o endereço original */
    }

    var label = data.site || hostnameOf(href) || 'Link';
    var site = card.querySelector('.link-preview-site');
    var title = card.querySelector('.link-preview-title');
    var description = card.querySelector('.link-preview-description');
    var urlText = card.querySelector('.link-preview-url');
    var media = card.querySelector('.link-preview-media');
    var image = media ? media.querySelector('img') : null;

    if (site) site.textContent = label;
    if (title) title.textContent = data.title || label;
    if (description) {
      description.textContent = data.description || '';
      description.hidden = !data.description;
    }
    if (urlText) {
      urlText.textContent = href.replace(/^https?:\/\//i, '').replace(/\/$/, '');
    }
    if (media && image) {
      if (data.image && /^https?:\/\//i.test(data.image)) {
        image.src = data.image;
        image.alt = data.title || label;
        media.hidden = false;
      } else {
        media.hidden = true;
      }
    }

    card.hidden = false;
  }

  function renderLinkPreviews(container, text) {
    if (!container) return;

    clear(container);
    var links = extractUrls(text).slice(0, MAX_LINK_PREVIEWS);
    if (!links.length) {
      container.hidden = true;
      return;
    }

    container.hidden = false;
    links.forEach(function (link) {
      var card = createLinkPreviewCard(link);
      container.appendChild(card);

      fetchLinkPreview(link.href).then(function (data) {
        if (!card.isConnected) return;
        if (!data) {
          card.remove();
          if (!container.querySelector('.link-preview')) container.hidden = true;
          return;
        }
        fillLinkPreview(card, data);
      });
    });
  }

  function syncComposeTopics() {
    var textarea = byId('post-content');
    if (!textarea) return;

    var detected = extractTopicsFromText(textarea.value);
    state.composeTopics = detected.slice(0, MAX_TOPICS);
    renderComposeTopics();

    var hint = byId('compose-topic-hint');
    if (hint) {
      hint.textContent =
        detected.length > MAX_TOPICS
          ? 'Detectamos ' +
            detected.length +
            ' tópicos; apenas os ' +
            MAX_TOPICS +
            ' primeiros serão publicados.'
          : 'Digite #tópicos no texto. Até ' +
            MAX_TOPICS +
            ' são publicados automaticamente.';
    }
  }

  function scheduleComposeLinkPreviews() {
    var container = byId('compose-link-previews');
    if (!container) return;

    if (composePreviewTimer) {
      clearTimeout(composePreviewTimer);
      composePreviewTimer = null;
    }

    var textarea = byId('post-content');
    var text = textarea ? textarea.value : '';
    if (!extractUrls(text).length) {
      clear(container);
      container.hidden = true;
      return;
    }

    composePreviewTimer = setTimeout(function () {
      composePreviewTimer = null;
      renderLinkPreviews(container, text);
    }, LINK_PREVIEW_DELAY_MS);
  }

  function topicsOf(block) {
    if (!block || block.mode !== 'post') return [];
    var topics = [];
    var seen = Object.create(null);
    var content = contentObject(block);

    function add(value) {
      var topic = normalizeTopic(value);
      if (!topic || seen[topic]) return;
      seen[topic] = true;
      topics.push(topic);
    }

    if (content && Array.isArray(content.topics)) content.topics.forEach(add);
    if (typeof block.content === 'string') {
      extractTopicsFromText(block.content).slice(0, MAX_TOPICS).forEach(add);
    } else if (content && typeof content.text === 'string') {
      extractTopicsFromText(content.text).slice(0, MAX_TOPICS).forEach(add);
    }
    if (Array.isArray(block.query)) {
      block.query.forEach(function (pair) {
        if (Array.isArray(pair) && pair[0] === 'topic') add(pair[1]);
      });
    }
    return topics.slice(0, MAX_TOPICS);
  }

  function topicLabel(topic) {
    return '#' + topic;
  }

  function trendingCount(topic) {
    var found = state.trending.find(function (item) {
      return item && item.topic === topic;
    });
    return found ? found.count : null;
  }

  function messagePayload(text) {
    if (typeof text !== 'string') return null;

    var trimmed = text.trim();
    if (trimmed.charAt(0) === '{') {
      try {
        var parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          var image = normalizeImage(parsed.image);
          var audio = normalizeAudio(parsed.audio);
          if (image || audio || typeof parsed.text === 'string') {
            return {
              text: typeof parsed.text === 'string' ? parsed.text : '',
              image: image,
              audio: audio,
            };
          }
        }
      } catch (error) {
        /* texto comum que começa com chave */
      }
    }

    return { text: text, image: null, audio: null };
  }

  function toast(message, isError) {
    var stack = byId('toast-stack');
    if (!stack) return;
    var item = el('div', 'toast' + (isError ? ' error' : ''), message);
    stack.appendChild(item);
    setTimeout(function () {
      item.remove();
    }, 7000);
  }

  function reportError(message) {
    var key = String(message || 'erro');
    var now = Date.now();
    if (now - (errorTimes.get(key) || 0) < 8000) return;
    errorTimes.set(key, now);
    toast(key, true);
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
    if (pill && RELAY && Array.isArray(RELAY.hosts)) {
      pill.title = 'Relays (clique para gerenciar): ' + RELAY.hosts.join(' · ');
    }
  }

  function setBusy(button, busy) {
    if (!button) return;
    button.disabled = Boolean(busy);
    if (!button.dataset.label) button.dataset.label = button.textContent;
    button.textContent = busy ? 'Aguarde…' : button.dataset.label;
  }

  /* ---------------------------------------------------------------------- */
  /* Identidade                                                             */
  /* ---------------------------------------------------------------------- */

  function hiddenChatsKey() {
    return state.identity ? HIDDEN_CHATS_PREFIX + state.identity.publicKey : null;
  }

  function loadHiddenChats() {
    state.hiddenChats = new Map();
    var key = hiddenChatsKey();
    if (!key) return;

    try {
      var parsed = JSON.parse(window.localStorage.getItem(key) || '{}');
      if (!parsed || typeof parsed !== 'object') return;
      Object.keys(parsed).forEach(function (peer) {
        var entry = parsed[peer];
        if (!entry || !Array.isArray(entry.known)) return;
        state.hiddenChats.set(peer, {
          cutoff: Number(entry.cutoff) || 0,
          known: new Set(
            entry.known.filter(function (id) {
              return typeof id === 'string' && id;
            })
          ),
        });
      });
    } catch (error) {
      /* localStorage indisponível: conversas apagadas valem só nesta sessão */
    }
  }

  function saveHiddenChats() {
    var key = hiddenChatsKey();
    if (!key) return;

    var output = {};
    state.hiddenChats.forEach(function (entry, peer) {
      output[peer] = {
        cutoff: entry.cutoff || 0,
        known: Array.from(entry.known || []),
      };
    });

    try {
      window.localStorage.setItem(key, JSON.stringify(output));
    } catch (error) {
      /* sem persistência local */
    }
  }

  function isChatHidden(peer) {
    return Boolean(peer && state.hiddenChats.has(peer));
  }

  function unhideChat(peer) {
    if (!peer || !state.hiddenChats.has(peer)) return false;
    state.hiddenChats.delete(peer);
    saveHiddenChats();
    return true;
  }

  function profileHref(pubkey) {
    return '/perfil.html?pubkey=' + encodeURIComponent(pubkey);
  }

  function keepProfile(profile) {
    if (!profile || typeof profile.pubkey !== 'string') return;
    var current = state.profiles.get(profile.pubkey);
    if (!current || (profile.created_at || 0) >= (current.created_at || 0)) {
      state.profiles.set(profile.pubkey, profile);
    }
  }

  function fillAvatarBox(box, name, pubkey, image) {
    if (!box) return;
    clear(box);
    var photo = normalizeImage(image);
    box.classList.toggle('has-photo', Boolean(photo));
    if (photo) {
      var img = document.createElement('img');
      img.src = 'data:' + photo.mime + ';base64,' + photo.data;
      img.alt = '';
      img.width = photo.width;
      img.height = photo.height;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      box.appendChild(img);
    } else {
      box.textContent = initials(name, pubkey);
    }
  }

  function closeProfileMenu() {
    var button = byId('identity-button');
    var dropdown = byId('profile-dropdown');
    if (dropdown) dropdown.hidden = true;
    if (button) button.setAttribute('aria-expanded', 'false');
  }

  function toggleProfileMenu() {
    var button = byId('identity-button');
    var dropdown = byId('profile-dropdown');
    if (!button || !dropdown) return;
    var open = dropdown.hidden;
    dropdown.hidden = !open;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function renderSettings() {
    if (!state.identity) return;
    var nameNode = byId('settings-name');
    if (!nameNode) return;

    var me = state.identity.publicKey;
    var data = profileData(profileOf(me));
    var name = data.name || state.identity.username || shortKey(me);

    nameNode.textContent = name;
    var pubkeyNode = byId('settings-pubkey');
    if (pubkeyNode) {
      pubkeyNode.textContent = shortKey(me);
      pubkeyNode.title = me;
    }
    fillAvatarBox(byId('settings-avatar'), name, me, data.image);

    var profileLink = byId('settings-profile-link');
    if (profileLink) profileLink.href = profileHref(me);
    var editLink = byId('settings-edit-link');
    if (editLink) editLink.href = '/?view=profile-edit';
  }

  function updateIdentityUi() {
    var button = byId('identity-button');
    if (!button || !state.identity) return;

    var me = state.identity.publicKey;
    var data = profileData(profileOf(me));
    var name = data.name || state.identity.username || shortKey(me);

    var nameNode = byId('nav-profile-name');
    if (nameNode) nameNode.textContent = name;
    var menuNameNode = byId('nav-profile-name-menu');
    if (menuNameNode) menuNameNode.textContent = name;
    var handleNode = byId('nav-profile-handle');
    if (handleNode) {
      handleNode.textContent = '@' + (state.identity.username || shortKey(me));
    }

    fillAvatarBox(byId('nav-avatar'), name, me, data.image);
    fillAvatarBox(byId('nav-avatar-menu'), name, me, data.image);

    button.title = 'Abrir menu do perfil de ' + name;
    button.setAttribute('aria-label', 'Abrir menu do perfil de ' + name);

    var profileLink = byId('menu-profile');
    if (profileLink) profileLink.href = profileHref(me);
    var editLink = byId('menu-edit');
    if (editLink) editLink.href = '/?view=profile-edit';
    var settingsLink = byId('menu-settings');
    if (settingsLink) settingsLink.href = '/?view=settings';

    renderSettings();
  }

  /* ---------------------------------------------------------------------- */
  /* Imagens                                                                */
  /* ---------------------------------------------------------------------- */

  function prepareImage(file) {
    return onpostt.prepareImage(file, {
      maxDimension: MAX_IMAGE_DIMENSION,
      maxBytes: MAX_IMAGE_BYTES,
      maxSourceBytes: MAX_IMAGE_SOURCE_BYTES,
      mime: 'image/jpeg',
    });
  }

  function prepareProfileImage(file) {
    return onpostt.prepareImage(file, {
      maxDimension: MAX_PROFILE_IMAGE_DIMENSION,
      maxBytes: MAX_IMAGE_BYTES,
      maxSourceBytes: MAX_IMAGE_SOURCE_BYTES,
      mime: 'image/jpeg',
    });
  }

  function renderImagePreview() {
    var preview = byId('image-preview');
    var image = byId('image-preview-img');
    var meta = byId('image-meta');
    if (!preview || !image || !meta) return;

    if (!state.pendingImage) {
      preview.hidden = true;
      image.removeAttribute('src');
      meta.textContent = '';
      return;
    }

    image.src = 'data:' + state.pendingImage.mime + ';base64,' + state.pendingImage.data;
    image.alt = 'Prévia da foto selecionada';
    meta.textContent =
      state.pendingImage.width +
      ' × ' +
      state.pendingImage.height +
      ' · ' +
      Math.max(1, Math.round(state.pendingImage.bytes / 1024)) +
      ' KB';
    preview.hidden = false;
  }

  function clearPendingImage() {
    state.pendingImage = null;
    renderImagePreview();
    var input = byId('post-image');
    if (input) input.value = '';
  }

  async function handleImageSelection(file) {
    if (state.imageBusy) return;
    state.imageBusy = true;
    var hint = byId('image-hint');
    var previousHint = hint ? hint.textContent : '';
    if (hint) hint.textContent = 'Preparando imagem…';

    try {
      state.pendingImage = await prepareImage(file);
      renderImagePreview();
      toast('Foto pronta: até 500px e pronta para o protocolo.');
    } catch (error) {
      clearPendingImage();
      reportError(error.message);
    } finally {
      state.imageBusy = false;
      if (hint) {
        hint.textContent = previousHint || 'JPEG ou PNG, redimensionada para até 500px.';
      }
      var input = byId('post-image');
      if (input) input.value = '';
    }
  }

  function renderProfilePhoto() {
    var preview = byId('profile-photo-preview');
    var remove = byId('remove-profile-image');
    if (!preview) return;

    clear(preview);
    var photo = normalizeImage(state.profilePhoto);
    if (photo) {
      var img = document.createElement('img');
      img.src = 'data:' + photo.mime + ';base64,' + photo.data;
      img.alt = 'Foto do perfil';
      img.width = photo.width;
      img.height = photo.height;
      img.referrerPolicy = 'no-referrer';
      preview.appendChild(img);
    } else {
      var name = byId('profile-name');
      preview.textContent = initials(name ? name.value : '', state.identity.publicKey);
    }

    if (remove) remove.hidden = !photo;
  }

  async function handleProfileImageSelection(file) {
    if (state.profileImageBusy) return;
    state.profileImageBusy = true;
    var hint = byId('profile-image-hint');
    var previousHint = hint ? hint.textContent : '';
    if (hint) hint.textContent = 'Preparando foto do perfil…';

    try {
      state.pendingProfileImage = await prepareProfileImage(file);
      state.profilePhoto = state.pendingProfileImage;
      state.profileImageRemoved = false;
      state.profileDirty = true;
      renderProfilePhoto();
      toast('Foto do perfil pronta: até 150px.');
    } catch (error) {
      reportError(error.message);
    } finally {
      state.profileImageBusy = false;
      if (hint) {
        hint.textContent = previousHint || 'JPEG ou PNG, redimensionada no navegador para até 150px.';
      }
      var input = byId('profile-image');
      if (input) input.value = '';
    }
  }

  function removeProfileImage() {
    state.profilePhoto = null;
    state.pendingProfileImage = null;
    state.profileImageRemoved = true;
    state.profileDirty = true;
    renderProfilePhoto();
    toast('Foto do perfil removida do rascunho.');
  }

  /* ---------------------------------------------------------------------- */
  /* Publicação                                                             */
  /* ---------------------------------------------------------------------- */

  async function publish(partial) {
    var signed = await onpostt.signBlock(partial, state.identity.privateKey);
    if (typeof signed === 'string') throw new Error(signed);

    // relay.js roteia interações apenas para relays que possuem o bloco alvo.
    var responses =
      RELAY && typeof RELAY.sendBlock === 'function'
        ? await RELAY.sendBlock(signed)
        : await onpostt.sendBlock(signed);
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

    post = state.topicPosts.find(function (candidate) {
      return candidate.id === id;
    });
    if (post) return post;

    var repostPost = state.repostPosts.get(id);
    if (repostPost) return repostPost;

    var repost = state.repostBlocks.find(function (candidate) {
      return candidate && candidate.id === id;
    });
    if (repost) return repost;

    var found = null;
    state.comments.forEach(function (comments) {
      if (found) return;
      found = comments.find(function (candidate) {
        return candidate.id === id;
      });
    });
    return found;
  }

  /**
   * Envia a notificação depois que a interação já foi aceita pelo relay.
   * É best-effort: a curtida/comentário continua válido mesmo se a notificação
   * falhar (por exemplo, se outro cliente já criou uma para a mesma interação).
   */
  async function notifyInteraction(targetBlockId, interaction, kind) {
    var target = findKnownBlock(targetBlockId);
    if (!target || !interaction) return;

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

  /* ---------------------------------------------------------------------- */
  /* Feed                                                                   */
  /* ---------------------------------------------------------------------- */

  function profileOf(pubkey) {
    return state.profiles.get(pubkey) || null;
  }

  function profileData(profile) {
    var content = profile && profile.content;
    if (typeof content === 'string') {
      try {
        content = JSON.parse(content);
      } catch (error) {
        content = { name: content, bio: '' };
      }
    }
    if (!content || typeof content !== 'object') content = {};
    return {
      name: typeof content.name === 'string' ? content.name : '',
      bio: typeof content.bio === 'string' ? content.bio : '',
      image: normalizeImage(content.image),
    };
  }

  function displayName(pubkey) {
    var profile = profileOf(pubkey);
    var data = profileData(profile);
    var ownName =
      state.identity && sameKey(pubkey, state.identity.publicKey)
        ? state.identity.username
        : '';
    return data.name || ownName || shortKey(pubkey);
  }

  function profileHref(pubkey) {
    return '/perfil.html?pubkey=' + encodeURIComponent(pubkey);
  }

  function postDetailUrl(postId, repostId) {
    var params = new URLSearchParams();
    if (postId) params.set('post', postId);
    if (repostId) params.set('repost', repostId);
    var query = params.toString();
    return '/post.html' + (query ? '?' + query : '');
  }

  function profileLink(className, pubkey, label) {
    var link = el('a', className, label);
    link.href = profileHref(pubkey);
    link.setAttribute('aria-label', 'Abrir perfil de ' + displayName(pubkey));
    return link;
  }

  function ensurePeerProfile(pubkey) {
    if (
      !pubkey ||
      state.profiles.has(pubkey) ||
      state.profileLookups.has(pubkey)
    ) {
      return;
    }

    state.profileLookups.add(pubkey);
    onpostt
      .list({ mode: 'profile', pubkey: pubkey, limit: 1 })
      .then(function (profiles) {
        if (!profiles || !profiles[0]) return;
        state.profiles.set(pubkey, profiles[0]);
        renderContacts();
        updateChatHeader();
        if (sameKey(state.peer, pubkey)) renderChat();
      })
      .catch(function () {
        /* sem perfil público: usa a pubkey abreviada */
      });
  }

  function loadProfilesForKeys(pubkeys) {
    var missing = Array.from(new Set(pubkeys || [])).filter(function (pubkey) {
      return (
        typeof pubkey === 'string' &&
        pubkey &&
        !state.profiles.has(pubkey) &&
        !state.profileLookups.has(pubkey)
      );
    });

    missing.forEach(function (pubkey) {
      state.profileLookups.add(pubkey);
    });

    return Promise.all(
      missing.map(function (pubkey) {
        return onpostt
          .list({ mode: 'profile', pubkey: pubkey, limit: 1 })
          .then(function (profiles) {
            if (profiles && profiles[0]) keepProfile(profiles[0]);
          })
          .catch(function () {
            /* sem perfil público: usa as iniciais da pubkey */
          });
      })
    );
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

  function buildFeedItems() {
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

  function isBlockedPubkey(pubkey) {
    if (typeof pubkey !== 'string' || !pubkey) return false;
    return state.blocked.has(pubkey) || state.blockedBy.has(pubkey);
  }

  function feedItemAllowed(item) {
    var me = state.identity ? state.identity.publicKey : null;
    var actor = item.kind === 'repost' ? item.repost.pubkey : item.post.pubkey;
    if (isBlockedPubkey(actor)) return false;
    if (item.post && isBlockedPubkey(item.post.pubkey)) return false;
    if (state.feedMode !== 'following') return true;
    return Boolean(actor && (actor === me || state.following.has(actor)));
  }

  function buildTopicItems() {
    return state.topicPosts
      .filter(function (post) {
        return post && post.id && post.mode === 'post';
      })
      .map(function (post) {
        return {
          kind: 'post',
          post: post,
          created_at: post.created_at || 0,
          sortKey: post.id,
        };
      })
      .sort(function (a, b) {
        var byTime = (b.created_at || 0) - (a.created_at || 0);
        if (byTime) return byTime;
        return String(b.sortKey || '').localeCompare(String(a.sortKey || ''));
      });
  }

  function updateFeedMoreButton() {
    var button = byId('load-more-posts');
    if (!button) return;
    var visible = Boolean(state.feedHasMore && !state.topicFilter);
    button.hidden = !visible;
    button.disabled = state.feedLoadingMore;
    button.textContent = state.feedLoadingMore ? 'Carregando…' : 'Carregar mais posts';
  }

  function renderFeed() {
    var list = byId('feed-list');
    var empty = byId('feed-empty');
    if (!list) return;

    clear(list);
    updateFeedMoreButton();
    var items = state.topicFilter
      ? buildTopicItems().filter(feedItemAllowed)
      : buildFeedItems().filter(feedItemAllowed);
    var emptyTitle = byId('feed-empty-title');
    var emptyNote = byId('feed-empty-note');

    if (items.length === 0) {
      if (state.topicFilter) {
        if (emptyTitle) {
          emptyTitle.textContent = state.topicLoading
            ? 'Carregando #' + state.topicFilter + '…'
            : 'Nenhum post sobre ' + topicLabel(state.topicFilter) + '.';
        }
        if (emptyNote) {
          emptyNote.textContent = state.topicLoading
            ? 'Buscando publicações no relay.'
            : 'Publique com esse tópico para iniciar a conversa.';
        }
      } else if (emptyTitle) {
        emptyTitle.textContent =
          state.feedMode === 'following'
            ? 'Nenhum post de quem você segue.'
            : 'Nenhum post ainda.';
        if (emptyNote) {
          emptyNote.textContent =
            state.feedMode === 'following'
              ? 'Siga alguém na aba Perfis ou publique o primeiro bloco.'
              : 'Publique o primeiro bloco para ver o protocolo em ação.';
        }
      }
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

  function setFeedMode(mode) {
    if (mode !== 'global' && mode !== 'following') return;
    state.feedMode = mode;
    document.querySelectorAll('[data-feed-mode]').forEach(function (button) {
      var active = button.dataset.feedMode === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    renderFeed();
  }

  function renderPostSurfaces() {
    if (!POST_PAGE) renderFeed();
    if (state.detail) renderPostDetail();
  }

  function renderPostDetail() {
    var container = byId('post-detail');
    if (!container) return;

    clear(container);
    var detail = state.detail;
    if (!detail || !detail.post) {
      container.appendChild(
        el('p', 'post-detail-empty', 'Publicação não encontrada ou indisponível.')
      );
      return;
    }

    var title = byId('post-detail-title');
    if (title) title.textContent = detail.repost ? 'Repost' : 'Publicação';

    var article = renderPost(detail.post, detail.repost);
    article.classList.add('post-detail-card');
    container.appendChild(article);
  }

  async function ensureDetailProfiles(post, repost, targetId) {
    var pubkeys = new Set();
    if (post && post.pubkey) pubkeys.add(post.pubkey);
    if (repost && repost.pubkey) pubkeys.add(repost.pubkey);
    (state.comments.get(targetId) || []).forEach(function (comment) {
      if (comment && comment.pubkey) pubkeys.add(comment.pubkey);
    });

    var missing = [];
    pubkeys.forEach(function (pubkey) {
      if (!state.profiles.has(pubkey) && !state.profileLookups.has(pubkey)) {
        missing.push(pubkey);
      }
    });
    missing.forEach(function (pubkey) {
      state.profileLookups.add(pubkey);
    });

    await Promise.all(
      missing.map(function (pubkey) {
        return onpostt
          .list({ mode: 'profile', app: APP, pubkey: pubkey, limit: 1 })
          .then(function (profiles) {
            if (profiles && profiles[0]) state.profiles.set(pubkey, profiles[0]);
          })
          .catch(function () {
            /* sem perfil público: usa a pubkey abreviada */
          });
      })
    );
  }

  async function openPostDetailPage(postId, repostId) {
    var post = null;
    var repost = null;
    var postKey = String(postId || '').trim();
    var repostKey = String(repostId || '').trim();

    if (repostKey) {
      repost = findKnownBlock(repostKey);
      if (!repost || repost.mode !== 'repost') repost = await loadBlockById(repostKey);
      if (repost && repost.mode === 'repost') {
        var repostTarget = queryValue(repost, 'block');
        post = findKnownBlock(repostTarget);
        if (!post || post.mode !== 'post') post = await loadBlockById(repostTarget);
      }
    }

    if (!post && postKey) {
      var candidate = findKnownBlock(postKey);
      if (!candidate || (candidate.mode !== 'post' && candidate.mode !== 'repost')) {
        candidate = await loadBlockById(postKey);
      }
      if (candidate && candidate.mode === 'repost') {
        repost = candidate;
        var target = queryValue(candidate, 'block');
        post = findKnownBlock(target);
        if (!post || post.mode !== 'post') post = await loadBlockById(target);
      } else if (candidate && candidate.mode === 'post') {
        post = candidate;
      }
    }

    if (!post || post.mode !== 'post') {
      state.detail = null;
      renderPostDetail();
      switchView('post');
      return false;
    }

    if (repost && repost.mode !== 'repost') repost = null;

    // Mantém os blocos conhecidos para rotear notificações e interações.
    if (!state.posts.some(function (item) { return item.id === post.id; })) {
      state.posts.unshift(post);
    }
    if (repost && !state.repostBlocks.some(function (item) { return item.id === repost.id; })) {
      state.repostBlocks.unshift(repost);
    }
    if (repost) state.repostPosts.set(post.id, post);

    var targetId = repost ? repost.id : post.id;
    state.detail = { post: post, repost: repost, targetId: targetId };
    state.openComments.add(targetId);

    await loadCommentsFor(targetId);
    await ensureDetailProfiles(post, repost, targetId);
    renderPostDetail();
    switchView('post');
    return true;
  }

  /* ---------------------------------------------------------------------- */
  /* Tópicos e trending                                                     */
  /* ---------------------------------------------------------------------- */

  function renderComposeTopics() {
    var box = byId('compose-topic-chips');
    if (!box) return;

    clear(box);
    if (state.composeTopics.length === 0) {
      box.hidden = true;
      return;
    }

    box.hidden = false;
    state.composeTopics.forEach(function (topic) {
      var chip = el('span', 'topic-chip topic-chip-detected', topicLabel(topic));
      chip.title = 'Tópico detectado no texto';
      chip.setAttribute('aria-label', 'Tópico detectado no texto: ' + topicLabel(topic));
      box.appendChild(chip);
    });
  }

  function updateTopicUrl() {
    if (!window.history || typeof window.history.replaceState !== 'function') return;
    var params = new URLSearchParams(window.location.search);
    params.set('view', 'feed');
    if (state.topicFilter) params.set('topic', state.topicFilter);
    else params.delete('topic');
    var query = params.toString();
    window.history.replaceState(
      null,
      '',
      window.location.pathname + (query ? '?' + query : '')
    );
  }

  function updateTopicBanner() {
    var box = byId('active-topic');
    if (!box) return;

    if (!state.topicFilter) {
      box.hidden = true;
      return;
    }

    box.hidden = false;
    var label = byId('active-topic-name');
    var countNode = byId('active-topic-count');
    if (label) label.textContent = topicLabel(state.topicFilter);

    var count = trendingCount(state.topicFilter);
    if (count === null) count = state.topicPosts.length;
    if (countNode) {
      countNode.textContent = count
        ? count + (count === 1 ? ' post' : ' posts')
        : (state.topicLoading ? 'carregando…' : '');
    }
  }

  async function refreshTopicPosts() {
    var topic = state.topicFilter;
    if (!topic) {
      state.topicPosts = [];
      state.topicLoading = false;
      updateTopicBanner();
      return;
    }

    state.topicLoading = true;
    updateTopicBanner();
    try {
      var posts = await onpostt.list({
        mode: 'post',
        app: APP,
        topic: topic,
        limit: MAX_TOPIC_POSTS,
      });
      if (state.topicFilter !== topic) return;
      state.topicPosts = posts.filter(function (post) {
        return post && post.mode === 'post' && topicsOf(post).indexOf(topic) !== -1;
      });
    } catch (error) {
      if (state.topicFilter === topic) reportError(error.message);
    } finally {
      if (state.topicFilter === topic) {
        state.topicLoading = false;
        updateTopicBanner();
        renderFeed();
      }
    }
  }

  function openTopic(value, options) {
    var topic = normalizeTopic(value);
    if (!topic) {
      reportError('Tópico inválido.');
      return;
    }

    if (POST_PAGE) {
      window.location.assign('/?view=feed&topic=' + encodeURIComponent(topic));
      return;
    }

    var changed = state.topicFilter !== topic;
    state.topicFilter = topic;
    if (changed) state.topicPosts = [];
    state.topicLoading = true;
    updateTopicBanner();
    updateTopicUrl();
    switchView('feed');
    renderFeed();
    refreshTopicPosts().catch(function (error) {
      reportError(error.message);
    });
  }

  function clearTopicFilter() {
    state.topicFilter = null;
    state.topicPosts = [];
    state.topicLoading = false;
    updateTopicBanner();
    updateTopicUrl();
    renderFeed();
  }

  function renderTrending() {
    var list = byId('trending-list');
    var empty = byId('trending-empty');
    var status = byId('trending-status');
    if (!list) return;

    clear(list);
    if (status) status.textContent = state.trendingLoading ? 'Atualizando…' : '';

    if (state.trendingError) {
      if (empty) {
        empty.textContent = state.trendingError;
        empty.hidden = false;
      }
      return;
    }

    if (state.trending.length === 0) {
      if (empty) {
        empty.textContent = state.trendingLoading
          ? 'Carregando tópicos…'
          : 'Nenhum tópico ainda. Publique com #nome para criar o primeiro.';
        empty.hidden = false;
      }
      return;
    }

    if (empty) empty.hidden = true;
    state.trending.forEach(function (item, index) {
      if (!item || !item.topic) return;
      var li = el('li', 'trending-item');
      var button = el('button', 'trending-topic');
      button.type = 'button';
      button.dataset.topic = item.topic;
      button.setAttribute(
        'aria-label',
        'Ver posts sobre ' + topicLabel(item.topic) + ' (' + item.count + ')'
      );

      button.appendChild(el('span', 'trending-rank', String(index + 1)));
      button.appendChild(el('span', 'trending-name', topicLabel(item.topic)));
      button.appendChild(
        el('span', 'trending-count', item.count + (item.count === 1 ? ' post' : ' posts'))
      );
      if (item.latestAt) {
        button.appendChild(el('span', 'trending-time', formatRelative(item.latestAt)));
      }

      li.appendChild(button);
      list.appendChild(li);
    });
  }

  async function refreshTrending(force) {
    var now = Date.now();
    if (!force && now - state.trendingFetchedAt < TRENDING_REFRESH_MS) return;

    state.trendingLoading = true;
    state.trendingError = '';
    renderTrending();

    try {
      var path =
        '/api/trending?app=' +
        encodeURIComponent(APP) +
        '&limit=' +
        TRENDING_LIMIT +
        '&window=' +
        TRENDING_WINDOW_SECONDS;
      var body;
      if (RELAY && typeof RELAY.fetchJSON === 'function') {
        body = await RELAY.fetchJSON(path, {
          headers: { Accept: 'application/json' },
          credentials: 'omit',
        });
      } else {
        var response = await fetch(RELAY.url(path), {
          headers: { Accept: 'application/json' },
          credentials: 'omit',
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        body = await response.json();
      }
      if (!body || !Array.isArray(body.topics)) throw new Error('Resposta inválida do relay.');

      state.trending = body.topics
        .filter(function (item) {
          return item && typeof item.topic === 'string';
        })
        .map(function (item) {
          return {
            topic: normalizeTopic(item.topic),
            count: Number.isInteger(item.count) ? item.count : 0,
            latestAt: Number.isFinite(item.latestAt) ? item.latestAt : 0,
          };
        })
        .filter(function (item) {
          return item.topic;
        });
      state.trendingFetchedAt = Date.now();
    } catch (error) {
      state.trendingError = 'Não foi possível carregar os tópicos em alta.';
      if (window.console && typeof window.console.warn === 'function') {
        window.console.warn('Trending indisponível:', error.message);
      }
    } finally {
      state.trendingLoading = false;
      renderTrending();
    }
  }

  function renderPostContent(article, post) {
    var content = post.content;

    if (typeof content === 'string') {
      appendPostText(article, content);
      return;
    }

    if (Array.isArray(content)) {
      if (content.length) article.appendChild(el('p', 'post-content', JSON.stringify(content)));
      return;
    }

    if (!content || typeof content !== 'object') {
      if (content !== undefined && content !== null && content !== '') {
        article.appendChild(el('p', 'post-content', JSON.stringify(content)));
      }
      return;
    }

    var text = typeof content.text === 'string' ? content.text : '';
    if (text) appendPostText(article, text);

    if (content.image && typeof content.image === 'object') {
      var image = normalizeImage(content.image);
      if (!image) {
        article.appendChild(el('p', 'post-content muted', '[imagem indisponível]'));
        return;
      }

      var figure = el('figure', 'post-media');
      var img = document.createElement('img');
      img.src = 'data:' + image.mime + ';base64,' + image.data;
      img.alt = text || 'Imagem publicada';
      img.width = image.width;
      img.height = image.height;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.dataset.imageModal = 'true';
      img.tabIndex = 0;
      img.setAttribute('role', 'button');
      img.setAttribute(
        'aria-label',
        text ? 'Ampliar imagem: ' + text : 'Ampliar imagem'
      );
      figure.appendChild(img);
      article.appendChild(figure);
      return;
    }

    // Objetos com tópicos (e sem texto) são conteúdo válido, não JSON cru.
    if (!text && !Array.isArray(content.topics)) {
      article.appendChild(el('p', 'post-content', JSON.stringify(content)));
    }
  }

  function renderTopics(article, post) {
    var topics = topicsOf(post);
    if (!topics.length) return;

    var row = el('div', 'post-topics');
    row.setAttribute('aria-label', 'Tópicos da publicação');
    topics.forEach(function (topic) {
      var button = el('button', 'topic-chip', topicLabel(topic));
      button.type = 'button';
      button.dataset.action = 'topic';
      button.dataset.topic = topic;
      button.setAttribute('aria-label', 'Ver posts sobre ' + topicLabel(topic));
      row.appendChild(button);
    });
    article.appendChild(row);
  }

  function renderPost(post, repost) {
    var from = post.pubkey;
    var social = repost || post;
    var profile = profileData(profileOf(from));
    var name = profile.name || shortKey(from);
    var isMine = from === state.identity.publicKey;
    var liked = state.likedByMe.has(social.id);
    var likeCount = state.likes.get(social.id) || 0;
    var reposted = state.repostedByMe.has(post.id);
    var repostCount = state.reposts.get(post.id) || 0;
    var comments = state.comments.get(social.id) || [];
    var commentsLoading = state.commentLoading.has(social.id);

    var article = el('article', 'post' + (repost ? ' post-repost' : ''));
    article.dataset.block = post.id;
    article.dataset.social = social.id;
    if (repost) article.dataset.repost = repost.id;

    if (repost) {
      var reposterProfile = profileData(profileOf(repost.pubkey));
      var reposterName =
        repost.pubkey === state.identity.publicKey ? 'Você' : displayName(repost.pubkey);
      var banner = el('div', 'repost-banner');
      banner.appendChild(el('span', 'repost-mark', '↻'));
      var actorLink = profileLink('repost-actor', repost.pubkey, '');
      actorLink.appendChild(
        avatarNode(reposterProfile.name, repost.pubkey, reposterProfile.image)
      );
      actorLink.appendChild(el('span', 'repost-actor-name', reposterName));
      banner.appendChild(actorLink);
      banner.appendChild(el('span', 'repost-text', ' repostou '));
      banner.appendChild(el('span', 'repost-time', formatRelative(repost.created_at)));
      article.appendChild(banner);
    }

    var head = el('div', 'post-head');
    var authorLink = profileLink('post-author-link', from, '');
    authorLink.appendChild(avatarNode(profile.name, from, profile.image));

    var author = el('div', 'post-author');
    author.appendChild(el('strong', '', name));
    author.appendChild(el('small', '', shortKey(from)));
    authorLink.appendChild(author);
    head.appendChild(authorLink);
    head.appendChild(el('span', 'post-time', formatRelative(post.created_at)));
    article.appendChild(head);

    renderPostContent(article, post);
    renderTopics(article, post);

    var actions = el('div', 'post-actions');

    var likeButton = el('button', 'action-button' + (liked ? ' liked' : ''), (liked ? '♥ ' : '♡ ') + 'Curtir' + (likeCount ? ' (' + likeCount + ')' : ''));
    likeButton.type = 'button';
    likeButton.dataset.action = 'like';
    likeButton.dataset.block = social.id;
    actions.appendChild(likeButton);

    // O botão de repost continua apontando para o post original. Em um card de
    // repost ele mostra/remove o repost do usuário; curtidas e comentários,
    // porém, pertencem ao bloco do repost (social.id).
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
      'Comentar' +
        (commentsLoading && comments.length === 0
          ? '…'
          : comments.length
            ? ' (' + comments.length + ')'
            : '')
    );
    commentButton.type = 'button';
    commentButton.dataset.action = 'comment';
    commentButton.dataset.block = social.id;
    actions.appendChild(commentButton);

    if (!repost && isMine) {
      var deleteButton = el('button', 'action-button', 'Excluir');
      deleteButton.type = 'button';
      deleteButton.dataset.action = 'delete';
      deleteButton.dataset.block = post.id;
      actions.appendChild(deleteButton);
    }

    var idLabel = el(
      'span',
      'block-id',
      (repost ? 'repost id ' : 'id ') + String(social.id).slice(0, 12)
    );
    actions.appendChild(idLabel);
    article.appendChild(actions);

    if (state.openComments.has(social.id)) {
      article.appendChild(renderComments(social, comments));
    }

    return article;
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
    var loading = state.commentLoading.has(post.id);

    if (loading && sorted.length === 0) {
      list.appendChild(el('p', 'faint small mb-0', 'Carregando comentários…'));
    } else if (sorted.length === 0) {
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
        var author = profileLink('comment-author-link', comment.pubkey, '');
        author.appendChild(
          avatarNode(commentData.name, comment.pubkey, commentData.image, 'avatar-small')
        );

        var authorMeta = el('div', 'post-author');
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

        if (comment.pubkey === state.identity.publicKey) {
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

  async function handleLike(button, blockId) {
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

      renderPostSurfaces();
      scheduleRefresh();
    } catch (error) {
      reportError(error.message);
    } finally {
      setBusy(button, false);
    }
  }

  function rememberRepost(block) {
    if (!block || block.mode !== 'repost') return;
    var target = queryValue(block, 'block');
    state.repostBlocks = state.repostBlocks.filter(function (candidate) {
      return !(
        candidate &&
        candidate.pubkey === block.pubkey &&
        queryValue(candidate, 'block') === target
      );
    });
    state.repostBlocks.unshift(block);

    var post =
      state.posts.find(function (candidate) {
        return candidate.id === target;
      }) ||
      state.repostPosts.get(target) ||
      null;
    if (post) state.repostPosts.set(target, post);
  }

  function forgetRepost(blockId) {
    var me = state.identity ? state.identity.publicKey : null;
    state.repostBlocks = state.repostBlocks.filter(function (candidate) {
      return !(
        candidate &&
        candidate.pubkey === me &&
        queryValue(candidate, 'block') === blockId
      );
    });
  }

  async function handleRepost(button, blockId) {
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
        forgetRepost(blockId);
        if (
          state.detail &&
          state.detail.repost &&
          state.detail.repost.pubkey === state.identity.publicKey &&
          queryValue(state.detail.repost, 'block') === blockId
        ) {
          state.detail = {
            post: state.detail.post,
            repost: null,
            targetId: state.detail.post.id,
          };
          state.openComments.add(state.detail.targetId);
          if (POST_PAGE && window.history && typeof window.history.replaceState === 'function') {
            window.history.replaceState(null, '', postDetailUrl(state.detail.post.id));
          }
        }
        toast('Repost removido.');
      } else {
        state.reposts.set(blockId, (state.reposts.get(blockId) || 0) + 1);
        state.repostedByMe.add(blockId);
        rememberRepost(output.block);
        await notifyInteraction(blockId, output.block, 'repost');
        toast('Post repostado.');
      }

      renderPostSurfaces();
      scheduleRefresh();
    } catch (error) {
      reportError(error.message);
    } finally {
      state.repostPending.delete(blockId);
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

    var key = blockId + REACTION_SEP + emoji;
    var reactions = state.reactions.get(blockId) || new Map();
    var count = reactions.get(emoji) || 0;

    if (output.result.action === 'removed') {
      reactions.set(emoji, Math.max(0, count - 1));
      state.myReactions.delete(key);
    } else {
      reactions.set(emoji, count + 1);
      state.myReactions.add(key);
      await notifyInteraction(blockId, output.block, 'reaction');
    }

    state.reactions.set(blockId, reactions);
    return output;
  }

  async function handleCommentReaction(button, commentId, emoji) {
    var likeKey = commentId + REACTION_SEP + COMMENT_LIKE;
    var dislikeKey = commentId + REACTION_SEP + COMMENT_DISLIKE;
    if (state.reactionPending.has(likeKey) || state.reactionPending.has(dislikeKey)) return;
    if (!onpostt.isValidReaction(emoji)) {
      reportError('Reação inválida.');
      return;
    }

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
      scheduleRefresh();
    } catch (error) {
      reportError(error.message);
    } finally {
      state.reactionPending.delete(likeKey);
      state.reactionPending.delete(dislikeKey);
      button.disabled = false;
      renderPostSurfaces();
    }
  }

  function handleReply(blockId, commentId) {
    state.replyTo.set(blockId, commentId);
    state.openComments.add(blockId);
    renderPostSurfaces();
    if (!state.commentLoaded.has(blockId)) {
      loadCommentsFor(blockId).catch(function (error) {
        reportError(error.message);
      });
    }

    var form =
      (byId('feed-list') &&
        byId('feed-list').querySelector('.comment-form[data-block="' + blockId + '"]')) ||
      (byId('post-detail') &&
        byId('post-detail').querySelector('.comment-form[data-block="' + blockId + '"]'));
    if (form) {
      var input = form.querySelector('input');
      if (input) input.focus();
    }
  }

  function handleCancelReply(blockId) {
    state.replyTo.delete(blockId);
    renderPostSurfaces();
  }

  function handleCommentToggle(blockId) {
    if (state.openComments.has(blockId)) {
      state.openComments.delete(blockId);
      renderPostSurfaces();
      return;
    }

    state.openComments.add(blockId);
    renderPostSurfaces();
    loadCommentsFor(blockId).catch(function (error) {
      reportError(error.message);
    });
  }

  async function handleComment(form, blockId) {
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
      state.commentDrafts.delete(blockId);
      state.replyTo.delete(blockId);
      await loadCommentsFor(blockId);
      renderPostSurfaces();
      toast(parent ? 'Resposta publicada.' : 'Comentário publicado.');
    } catch (error) {
      reportError(error.message);
    } finally {
      setBusy(button, false);
    }
  }

  async function handleDeleteComment(blockId, commentId) {
    var confirmed = window.confirm('Excluir este comentário?');
    if (!confirmed) return;

    try {
      await publish({
        mode: 'delete',
        query: [['block', commentId]],
        app: APP,
      });
      state.replyTo.delete(blockId);
      await loadCommentsFor(blockId);
      renderPostSurfaces();
      toast('Comentário excluído.');
    } catch (error) {
      reportError(error.message);
    }
  }

  async function handleDelete(blockId) {
    var confirmed = window.confirm('Excluir este post? O bloco de exclusão é público.');
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
      state.commentLoaded.delete(blockId);
      state.commentLoading.delete(blockId);
      if (state.detail && state.detail.post && state.detail.post.id === blockId) {
        state.detail = null;
        if (POST_PAGE) {
          window.location.assign('/?view=feed');
          return;
        }
      }
      renderPostSurfaces();
      toast('Post marcado como excluído.');
    } catch (error) {
      reportError(error.message);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Perfis                                                                 */
  /* ---------------------------------------------------------------------- */

  function renderProfiles() {
    var list = byId('profiles-list');
    var empty = byId('profiles-empty');
    if (!list) return;

    clear(list);
    var rawTerm = state.profileQuery.trim();
    var term = rawTerm.toLowerCase();
    var context = byId('profiles-context');
    var loadMore = byId('load-more-profiles');

    var profiles;
    if (term) {
      profiles = Array.from(state.profileSearchResults.values())
        .filter(function (profile) {
          if (!profile || typeof profile.pubkey !== 'string') return false;
          if (isBlockedPubkey(profile.pubkey)) return false;
          return (
            displayName(profile.pubkey).toLowerCase().includes(term) ||
            profile.pubkey.toLowerCase().includes(term)
          );
        })
        .sort(function (a, b) {
          return displayName(a.pubkey).localeCompare(displayName(b.pubkey), 'pt-BR');
        });
    } else {
      profiles = state.suggestedPubkeys
        .map(function (pubkey) {
          return state.profiles.get(pubkey);
        })
        .filter(function (profile) {
          return (
            profile &&
            typeof profile.pubkey === 'string' &&
            !isBlockedPubkey(profile.pubkey)
          );
        })
        .sort(function (a, b) {
          return displayName(a.pubkey).localeCompare(displayName(b.pubkey), 'pt-BR');
        });
    }

    if (context) {
      if (term) {
        context.textContent = state.profileSearchLoading
          ? 'Buscando perfis no relay…'
          : 'Resultados para “' + rawTerm + '”.';
      } else {
        context.textContent =
          'Perfis sugeridos a partir de quem você segue, seus seguidores e autores do feed.';
      }
    }

    if (loadMore) {
      loadMore.hidden = !term || !state.profileSearchHasMore;
      loadMore.disabled = state.profileSearchLoading;
      loadMore.textContent = state.profileSearchLoading
        ? 'Carregando…'
        : 'Carregar mais perfis';
    }

    if (profiles.length === 0) {
      if (empty) {
        empty.hidden = false;
        var title = empty.querySelector('p');
        var note = empty.querySelectorAll('p')[1];
        if (title) {
          title.textContent = term
            ? state.profileSearchLoading
              ? 'Buscando perfis…'
              : 'Nenhum perfil corresponde a “' + rawTerm + '”.'
            : 'Nenhum perfil sugerido ainda.';
        }
        if (note) {
          note.textContent = term
            ? state.profileSearchLoading
              ? 'Consultando o relay.'
              : 'Tente outro nome ou uma pubkey completa.'
            : 'Siga alguém, interaja no feed ou busque por nome/pubkey.';
        }
      }
      return;
    }
    if (empty) empty.hidden = true;

    profiles.forEach(function (profile) {
      list.appendChild(renderProfileCard(profile));
    });
  }

  function resetProfileSearch() {
    state.profileSearchSeq += 1;
    state.profileSearchResults = new Map();
    state.profileSearchTerm = '';
    state.profileSearchOffset = 0;
    state.profileSearchHasMore = false;
    state.profileSearchLoading = false;
  }

  async function searchProfilesFromRelay(term, options) {
    var value = typeof term === 'string' ? term.trim() : '';
    if (!value) {
      resetProfileSearch();
      renderProfiles();
      return;
    }

    var append = Boolean(options && options.append);
    if (append && (!state.profileSearchHasMore || state.profileSearchLoading)) return;

    if (!append) {
      state.profileSearchResults = new Map();
      state.profileSearchOffset = 0;
      state.profileSearchHasMore = false;
    }

    var seq = ++state.profileSearchSeq;
    state.profileSearchTerm = value;
    state.profileSearchLoading = true;
    renderProfiles();

    try {
      var list;
      if (!append && window.onpostt.isValidPublicKey(value)) {
        // Pubkey completa é consulta exata, independente da paginação.
        list = await onpostt.list({
          mode: 'profile',
          app: APP,
          pubkey: value,
          limit: 1,
        });
        list.forEach(keepProfile);
        list.forEach(function (profile) {
          if (profile && profile.pubkey) {
            state.profileSearchResults.set(profile.pubkey, profile);
          }
        });
        state.profileSearchOffset = 1;
        state.profileSearchHasMore = false;
      } else {
        var offset = append ? state.profileSearchOffset : 0;
        list = await onpostt.list({
          mode: 'profile',
          app: APP,
          limit: PROFILE_SEARCH_PAGE,
          offset: offset,
        });
        list.forEach(keepProfile);
        list.forEach(function (profile) {
          if (profile && profile.pubkey) {
            state.profileSearchResults.set(profile.pubkey, profile);
          }
        });
        state.profileSearchOffset = offset + PROFILE_SEARCH_PAGE;
        state.profileSearchHasMore =
          (list.length >= PROFILE_SEARCH_PAGE || Boolean(list.truncated)) &&
          state.profileSearchOffset < MAX_PROFILE_SEARCH;
      }
    } catch (error) {
      if (seq === state.profileSearchSeq) {
        state.profileSearchHasMore = false;
        reportError(error.message);
      }
    } finally {
      if (seq === state.profileSearchSeq) {
        state.profileSearchLoading = false;
        renderProfiles();
      }
    }
  }

  function scheduleProfileSearch() {
    if (profileSearchTimer) {
      clearTimeout(profileSearchTimer);
      profileSearchTimer = null;
    }

    var term = state.profileQuery.trim();
    if (!term) {
      resetProfileSearch();
      renderProfiles();
      return;
    }

    state.profileSearchSeq += 1;
    state.profileSearchResults = new Map();
    state.profileSearchOffset = 0;
    state.profileSearchHasMore = false;
    state.profileSearchLoading = true;
    renderProfiles();

    profileSearchTimer = setTimeout(function () {
      profileSearchTimer = null;
      searchProfilesFromRelay(term).catch(function (error) {
        reportError(error.message);
      });
    }, 350);
  }

  function renderProfileCard(profile) {
    var data = profileData(profile);
    var pubkey = profile.pubkey;
    var isMine = pubkey === state.identity.publicKey;
    var following = state.following.has(pubkey);
    var followsMe = state.followers.has(pubkey);

    var card = el('article', 'profile-card');
    var head = el('div', 'profile-card-head');
    var headLink = profileLink('profile-card-link', pubkey, '');
    headLink.appendChild(avatarNode(data.name, pubkey, data.image));

    var meta = el('div', 'post-author');
    meta.appendChild(el('strong', '', data.name || shortKey(pubkey)));
    meta.appendChild(el('small', '', shortKey(pubkey)));
    headLink.appendChild(meta);
    head.appendChild(headLink);
    card.appendChild(head);

    card.appendChild(el('p', 'profile-bio', data.bio || (isMine ? 'Sem bio ainda.' : 'Sem bio.')));

    var actions = el('div', 'profile-actions');
    actions.appendChild(profileLink('btn btn-small btn-ghost', pubkey, 'Ver perfil'));

    if (isMine) {
      actions.appendChild(el('span', 'pill pill-accent', 'você'));
    } else {
      var followLabel = following
        ? 'Deixar de seguir'
        : followsMe
          ? 'Seguir de volta'
          : 'Seguir';
      var followButton = el('button', 'btn btn-small' + (following ? ' btn-ghost' : ' btn-primary'), followLabel);
      followButton.type = 'button';
      followButton.dataset.action = 'follow';
      followButton.dataset.pubkey = pubkey;
      actions.appendChild(followButton);

      var chatButton = el('button', 'btn btn-small', 'Mensagem');
      chatButton.type = 'button';
      chatButton.dataset.action = 'chat';
      chatButton.dataset.pubkey = pubkey;
      actions.appendChild(chatButton);
    }

    card.appendChild(actions);
    return card;
  }

  function fillProfileForm() {
    if (state.profileDirty) return;
    var profile = state.profiles.get(state.identity.publicKey);
    var data = profileData(profile);
    var name = byId('profile-name');
    var bio = byId('profile-bio');
    var fallback =
      state.identity.username || 'anon-' + state.identity.publicKey.slice(2, 6);
    if (name) name.value = data.name || fallback;
    if (bio) bio.value = data.bio || '';
    state.profilePhoto = data.image;
    state.pendingProfileImage = null;
    state.profileImageRemoved = false;
    renderProfilePhoto();
  }

  async function ensureOwnProfileBlock() {
    if (!state.identity || !state.identity.username || !state.identity.privateKey) {
      return;
    }

    var me = state.identity.publicKey;
    var existing = await onpostt.list({ mode: 'profile', pubkey: me, app: APP, limit: 1 });
    if (existing && existing.length) return;

    var output = await publish({
      mode: 'profile',
      query: [],
      content: { name: state.identity.username, bio: '' },
      app: APP,
    });

    if (output && output.block && output.block.pubkey) {
      state.profiles.set(output.block.pubkey, output.block);
      fillProfileForm();
      renderProfiles();
      renderFeed();
    }

    await refreshProfiles();
    renderFeed();
  }

  async function handleProfileSave(event) {
    event.preventDefault();
    var nameInput = byId('profile-name');
    var bioInput = byId('profile-bio');
    var name = nameInput ? nameInput.value.trim() : '';
    var bio = bioInput ? bioInput.value.trim() : '';
    if (!name) {
      toast('Informe um nome para o perfil.', true);
      nameInput && nameInput.focus();
      return;
    }

    var content = { name: name, bio: bio };
    var image = state.pendingProfileImage;
    if (!image && !state.profileImageRemoved) {
      image = profileData(state.profiles.get(state.identity.publicKey)).image;
    }
    if (image) {
      content.image = {
        mime: image.mime,
        data: image.data,
        width: image.width,
        height: image.height,
      };
    }

    var button = byId('save-profile');
    setBusy(button, true);

    try {
      var output = await publish({
        mode: 'profile',
        query: [],
        content: content,
        app: APP,
      });
      if (output && output.block && output.block.pubkey) {
        state.profiles.set(output.block.pubkey, output.block);
        updateIdentityUi();
      }
      state.profileDirty = false;
      state.pendingProfileImage = null;
      state.profileImageRemoved = false;
      state.profilePhoto = image || null;
      await refreshProfiles();
      renderProfiles();
      renderFeed();
      toast('Perfil atualizado.');
    } catch (error) {
      reportError(error.message);
    } finally {
      setBusy(button, false);
    }
  }

  async function notifyFollow(followBlock, pubkey) {
    if (!followBlock || !followBlock.id || !pubkey) return;
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

  async function handleFollow(button, pubkey) {
    if (isBlockedPubkey(pubkey)) {
      toast('Desbloqueie este usuário para seguir.', true);
      return;
    }

    setBusy(button, true);
    try {
      var output = await publish({
        mode: 'follow',
        query: [
          ['follower', state.identity.publicKey],
          ['following', pubkey],
        ],
        app: APP,
      });

      if (output.result.action === 'removed') {
        state.following.delete(pubkey);
      } else {
        state.following.add(pubkey);
        await notifyFollow(output.block, pubkey);
      }

      renderProfiles();
      renderNotifications();
      renderFeed();
      toast(output.result.action === 'removed' ? 'Deixou de seguir.' : 'Seguindo.');
    } catch (error) {
      reportError(error.message);
    } finally {
      setBusy(button, false);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Notificações                                                           */
  /* ---------------------------------------------------------------------- */

  function notificationPhrase(kind, targetMode) {
    var onComment = targetMode === 'comment';
    if (kind === 'follow') return 'começou a te seguir';
    if (kind === 'comment') {
      return onComment ? 'comentou no seu comentário' : 'comentou na sua publicação';
    }
    if (kind === 'reaction') {
      return onComment ? 'reagiu ao seu comentário' : 'reagiu à sua publicação';
    }
    if (kind === 'repost') return 'repostou sua publicação';
    return onComment ? 'curtiu seu comentário' : 'curtiu sua publicação';
  }

  function blockSnippet(block) {
    if (!block) return '';
    if (typeof block.content === 'string') return block.content.trim();
    if (block.content && typeof block.content === 'object') {
      if (typeof block.content.text === 'string') return block.content.text.trim();
      if (block.content.image) return 'publicação com foto';
    }
    return '';
  }

  function unreadNotificationCount() {
    return state.notifications.filter(function (notification) {
      return (
        notification &&
        notification.id &&
        !isBlockedPubkey(notification.pubkey) &&
        !state.notificationRead.has(notification.id)
      );
    }).length;
  }

  function updateNotificationBadge() {
    var badge = byId('notification-badge');
    if (!badge) return;
    var unread = unreadNotificationCount();
    badge.hidden = unread === 0;
    badge.textContent = unread > 99 ? '99+' : String(unread);
  }

  async function persistNotificationReads(ids) {
    if (!ids.length) return;
    await publish({
      mode: 'notification_read',
      query: [],
      content: { read: ids },
      app: APP,
    });
  }

  async function markNotificationRead(id) {
    if (!id || state.notificationRead.has(id)) return;
    state.notificationRead.add(id);
    renderNotifications();

    try {
      await persistNotificationReads([id]);
      // Uma atualização automática pode ter recarregado as confirmações
      // enquanto o bloco era publicado. Reaplica o estado local confirmado.
      state.notificationRead.add(id);
      renderNotifications();
    } catch (error) {
      state.notificationRead.delete(id);
      renderNotifications();
      reportError(error.message);
    }
  }

  async function markAllNotificationsRead() {
    var unread = state.notifications
      .filter(function (notification) {
        return notification && notification.id && !state.notificationRead.has(notification.id);
      })
      .map(function (notification) {
        return notification.id;
      });

    if (unread.length === 0) {
      toast('Nenhuma notificação nova.');
      return;
    }

    var button = byId('mark-notifications-read');
    setBusy(button, true);
    unread.forEach(function (id) {
      state.notificationRead.add(id);
    });
    renderNotifications();

    try {
      await persistNotificationReads(unread);
      unread.forEach(function (id) {
        state.notificationRead.add(id);
      });
      renderNotifications();
      toast(unread.length === 1 ? 'Notificação marcada como lida.' : unread.length + ' notificações marcadas como lidas.');
    } catch (error) {
      unread.forEach(function (id) {
        state.notificationRead.delete(id);
      });
      renderNotifications();
      reportError(error.message);
    } finally {
      setBusy(button, false);
    }
  }

  function toggleReadNotifications() {
    state.showReadNotifications = !state.showReadNotifications;
    var button = byId('toggle-read-notifications');
    if (button) {
      button.textContent = state.showReadNotifications ? 'Ocultar lidas' : 'Mostrar lidas';
      button.setAttribute('aria-pressed', state.showReadNotifications ? 'true' : 'false');
    }
    renderNotifications();
  }

  function renderNotifications() {
    var list = byId('notification-list');
    var empty = byId('notifications-empty');
    if (!list) return;

    clear(list);
    updateNotificationBadge();

    var visible = state.notifications
      .filter(function (notification) {
        if (!notification || !notification.id) return false;
        if (isBlockedPubkey(notification.pubkey)) return false;
        return state.showReadNotifications || !state.notificationRead.has(notification.id);
      })
      .sort(function (a, b) {
        return b.created_at - a.created_at;
      });

    if (visible.length === 0) {
      if (empty) {
        empty.hidden = false;
        var title = empty.querySelector('p');
        if (title) {
          title.textContent = state.showReadNotifications
            ? 'Nenhuma notificação.'
            : 'Nenhuma notificação nova.';
        }
      }
      return;
    }
    if (empty) empty.hidden = true;

    visible.forEach(function (notification) {
      var targetId = queryValue(notification, 'block');
      var interactionId = queryValue(notification, 'interaction');
      var kind = queryValue(notification, 'kind');
      var target = findKnownBlock(targetId);
      var interaction = findKnownBlock(interactionId);
      var targetMode = kind === 'follow' ? 'follow' : target ? target.mode : 'post';
      var unread = !state.notificationRead.has(notification.id);
      var name = displayName(notification.pubkey);

      var item = el('article', 'notification-item' + (unread ? ' unread' : ''));
      item.dataset.action = 'open-notification';
      item.dataset.notification = notification.id;
      item.dataset.block = targetId || '';
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.setAttribute(
        'aria-label',
        name + ' ' + notificationPhrase(kind, targetMode) + (unread ? ' (não lida)' : '')
      );

      var head = el('div', 'notification-head');
      head.appendChild(
        avatarNode(
          name,
          notification.pubkey,
          profileData(profileOf(notification.pubkey)).image
        )
      );

      var text = el('p', 'notification-text');
      text.appendChild(el('strong', '', name));
      text.appendChild(document.createTextNode(' ' + notificationPhrase(kind, targetMode)));
      head.appendChild(text);
      head.appendChild(el('span', 'notification-time', formatRelative(notification.created_at)));
      item.appendChild(head);

      var excerpt =
        kind === 'follow'
          ? ''
          : kind === 'comment' && interaction
            ? blockSnippet(interaction)
            : blockSnippet(target);
      if (excerpt) {
        item.appendChild(el('p', 'notification-quote', '“' + excerpt.slice(0, 240) + '”'));
      }

      if (kind === 'follow' && !state.following.has(notification.pubkey)) {
        var actions = el('div', 'notification-actions');
        var followBack = el('button', 'btn btn-small btn-primary', 'Seguir de volta');
        followBack.type = 'button';
        followBack.dataset.action = 'follow';
        followBack.dataset.pubkey = notification.pubkey;
        actions.appendChild(followBack);
        item.appendChild(actions);
      }

      if (kind !== 'follow') {
        var meta = el('div', 'notification-meta');
        meta.appendChild(el('span', 'block-id', 'interação ' + String(interactionId || '').slice(0, 12)));
        meta.appendChild(el('span', 'block-id', 'bloco ' + String(targetId || '').slice(0, 12)));
        item.appendChild(meta);
      }

      list.appendChild(item);
    });
  }

  async function refreshNotifications() {
    var results = await Promise.all([
      onpostt.list({
        mode: 'notification',
        app: APP,
        query: [['to', state.identity.publicKey]],
        limit: MAX_NOTIFICATIONS,
      }),
      onpostt.list({
        mode: 'notification_read',
        app: APP,
        pubkey: state.identity.publicKey,
        limit: MAX_SOCIAL,
      }),
    ]);

    state.notifications = results[0].filter(function (notification) {
      return notification && notification.mode === 'notification';
    });

    var read = new Set();
    results[1].forEach(function (receipt) {
      var ids = receipt && receipt.content && receipt.content.read;
      if (!Array.isArray(ids)) return;
      ids.forEach(function (id) {
        if (typeof id === 'string' && id) read.add(id);
      });
    });
    state.notificationRead = read;
    renderNotifications();
  }

  async function loadBlockById(id) {
    if (typeof id !== 'string' || !id) return null;
    var modes = ['post', 'repost', 'comment'];
    for (var i = 0; i < modes.length; i += 1) {
      var blocks = await onpostt.list({ mode: modes[i], app: APP, id: id, limit: 1 });
      if (blocks && blocks[0]) return blocks[0];
    }
    return null;
  }

  async function openNotification(notification) {
    if (!notification || !notification.id) return;

    // Aguarda a confirmação de leitura antes de trocar de página. Sem isso,
    // o redirecionamento podia cancelar a publicação e a notificação voltava
    // como não lida ao retornar para a lista.
    await markNotificationRead(notification.id);

    var kind = queryValue(notification, 'kind');
    if (kind === 'follow') {
      window.location.assign('/perfil.html?pubkey=' + encodeURIComponent(notification.pubkey));
      return;
    }

    var targetId = queryValue(notification, 'block');
    var target = findKnownBlock(targetId);

    if (!target) {
      try {
        target = await loadBlockById(targetId);
      } catch (error) {
        reportError(error.message);
      }
    }
    if (!target) {
      toast('O bloco desta notificação não está mais disponível.', true);
      switchView('notifications');
      return;
    }

    if (target.mode === 'repost') {
      window.location.assign(postDetailUrl(queryValue(target, 'block'), target.id));
      return;
    }

    var postId = target.mode === 'comment' ? queryValue(target, 'block') : target.id;
    if (target.mode === 'comment') {
      var parentBlock = findKnownBlock(postId);
      if (!parentBlock) {
        try {
          parentBlock = await loadBlockById(postId);
        } catch (error) {
          reportError(error.message);
        }
      }
      if (parentBlock && parentBlock.mode === 'repost') {
        window.location.assign(postDetailUrl(queryValue(parentBlock, 'block'), parentBlock.id));
        return;
      }

      if (!state.comments.has(postId)) state.comments.set(postId, []);
      var comments = state.comments.get(postId);
      if (!comments.some(function (comment) { return comment.id === target.id; })) {
        comments.push(target);
      }
    }

    if (target.mode === 'post' && !state.posts.some(function (post) { return post.id === target.id; })) {
      state.posts.unshift(target);
    }

    if (!state.posts.some(function (post) { return post.id === postId; })) {
      try {
        var posts = await onpostt.list({ mode: 'post', app: APP, id: postId, limit: 1 });
        if (posts && posts[0]) state.posts.unshift(posts[0]);
      } catch (error) {
        reportError(error.message);
      }
    }

    if (target.mode === 'comment') state.openComments.add(postId);
    switchView('feed');
    renderFeed();

    setTimeout(function () {
      var node = byId('feed-list').querySelector('.post[data-block="' + postId + '"]');
      if (!node) return;
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      node.classList.add('post-flash');
      setTimeout(function () {
        node.classList.remove('post-flash');
      }, 1600);
    }, 60);
  }

  /* ---------------------------------------------------------------------- */
  /* Conversas                                                              */
  /* ---------------------------------------------------------------------- */

  function logicalId(block) {
    return String(block.id || '').replace(/_rcp$/i, '').toLowerCase();
  }

  function peerLabel(pubkey) {
    var profile = profileOf(pubkey);
    var data = profileData(profile);
    return data.name || shortKey(pubkey);
  }

  function inboxMessagesFor(peer) {
    if (!peer) return [];
    var messages = state.inbox.get(peer);
    if (messages) return Array.from(messages.values());

    var found = null;
    state.inbox.forEach(function (candidate, pubkey) {
      if (!found && sameKey(pubkey, peer)) found = candidate;
    });
    return found ? Array.from(found.values()) : [];
  }

  function outboxMessagesFor(peer) {
    if (!peer) return [];
    var messages = state.outbox.get(peer);
    if (messages) return Array.from(messages.values());

    var found = null;
    state.outbox.forEach(function (candidate, pubkey) {
      if (!found && sameKey(pubkey, peer)) found = candidate;
    });
    return found ? Array.from(found.values()) : [];
  }

  function conversationMessagesFor(peer) {
    return inboxMessagesFor(peer).concat(outboxMessagesFor(peer));
  }

  function unreadMessagesFor(peer) {
    if (isChatHidden(peer) || isBlockedPubkey(peer)) return [];
    return inboxMessagesFor(peer).filter(function (block) {
      return !state.messageRead.has(logicalId(block));
    });
  }

  function unreadMessageCount() {
    var total = 0;
    state.inbox.forEach(function (messages, peer) {
      total += unreadMessagesFor(peer).length;
    });
    return total;
  }

  function updateMessageBadge() {
    var badge = byId('message-badge');
    if (!badge) return;
    var total = unreadMessageCount();
    badge.hidden = total === 0;
    badge.textContent = total > 99 ? '99+' : String(total);
  }

  function updateChatHeader() {
    var label = byId('chat-peer-label');
    var key = byId('chat-peer-key');
    var avatar = byId('chat-peer-avatar');
    var input = byId('chat-input');
    var send = byId('chat-send');
    var refresh = byId('refresh-chat');
    var remove = byId('delete-chat');
    var image = byId('chat-image');
    var audio = byId('chat-audio');
    var audioLabel = byId('chat-audio-label');
    var hasPeer = Boolean(state.peer);

    if (label) label.textContent = hasPeer ? peerLabel(state.peer) : 'Nenhuma conversa';
    if (key) key.textContent = hasPeer ? state.peer : 'Escolha um contato ao lado';

    if (avatar) {
      clear(avatar);
      avatar.hidden = !hasPeer;
      if (hasPeer) {
        var peerInfo = profileData(profileOf(state.peer));
        avatar.appendChild(
          avatarNode(peerInfo.name || peerLabel(state.peer), state.peer, peerInfo.image)
        );
      }
    }

    var layout = byId('direct-layout');
    if (layout && !hasPeer) layout.classList.remove('thread-open');

    if (input) input.disabled = !hasPeer;
    if (send) send.disabled = !hasPeer;
    if (refresh) refresh.disabled = !hasPeer;
    if (remove) remove.disabled = !hasPeer || state.chatMediaBusy;
    if (image) {
      image.disabled = !hasPeer || state.chatMediaBusy || Boolean(state.audioRecording);
    }
    if (audio) {
      var audioText = state.audioRecording ? 'Parar e enviar' : 'Gravar áudio';
      audio.disabled = !hasPeer || (state.chatMediaBusy && !state.audioRecording);
      if (audioLabel) audioLabel.textContent = audioText;
      else audio.textContent = audioText;
      audio.title = audioText;
      audio.setAttribute('aria-label', audioText);
      audio.classList.toggle('recording', Boolean(state.audioRecording));
    }
  }

  function renderContacts() {
    var list = byId('contact-list');
    if (!list) return;
    clear(list);

    var peers = new Map();
    state.inbox.forEach(function (messages, pubkey) {
      if (
        !sameKey(pubkey, state.identity.publicKey) &&
        !isChatHidden(pubkey) &&
        !isBlockedPubkey(pubkey)
      ) {
        peers.set(pubkey, peerLabel(pubkey));
      }
    });
    state.outbox.forEach(function (messages, pubkey) {
      if (
        !sameKey(pubkey, state.identity.publicKey) &&
        !isChatHidden(pubkey) &&
        !isBlockedPubkey(pubkey) &&
        !peers.has(pubkey)
      ) {
        peers.set(pubkey, peerLabel(pubkey));
      }
    });
    if (
      state.peer &&
      !isChatHidden(state.peer) &&
      !isBlockedPubkey(state.peer) &&
      !peers.has(state.peer)
    ) {
      peers.set(state.peer, peerLabel(state.peer));
    }

    if (peers.size === 0) {
      list.appendChild(
        el('p', 'faint small mb-0', 'Nenhuma conversa ainda. Envie ou receba uma mensagem.')
      );
      updateMessageBadge();
      return;
    }

    var me = state.identity ? state.identity.publicKey : '';
    var entries = Array.from(peers.entries()).map(function (entry) {
      var pubkey = entry[0];
      var messages = conversationMessagesFor(pubkey);
      var last = messages.length
        ? messages.slice().sort(function (a, b) {
            return (Number(a.created_at) || 0) - (Number(b.created_at) || 0);
          })[messages.length - 1]
        : null;
      var lastAt = last ? Number(last.created_at) || 0 : 0;
      var mineLast = Boolean(last && me && sameKey(queryValue(last, 'from'), me));
      var cached = last ? state.chat.get(logicalId(last)) : null;
      var preview = '';

      if (cached && cached.payload) {
        preview =
          cached.payload.text ||
          (cached.payload.image ? '📷 Imagem' : cached.payload.audio ? '🎙️ Áudio' : '');
      }
      if (!preview) {
        preview = last
          ? mineLast
            ? 'Você: mensagem'
            : 'Mensagem recebida'
          : 'Nenhuma mensagem';
      }

      return {
        pubkey: pubkey,
        name: entry[1],
        unread: unreadMessagesFor(pubkey).length,
        lastAt: lastAt,
        preview: preview,
      };
    });

    var query = state.chatQuery.trim().toLowerCase();
    if (query) {
      entries = entries.filter(function (entry) {
        return (
          entry.name.toLowerCase().includes(query) ||
          entry.pubkey.toLowerCase().includes(query)
        );
      });
    }

    if (entries.length === 0) {
      list.appendChild(el('p', 'faint small mb-0', 'Nenhuma conversa encontrada.'));
      updateMessageBadge();
      return;
    }

    entries
      .sort(function (a, b) {
        if (a.unread !== b.unread) return b.unread - a.unread;
        if (a.lastAt !== b.lastAt) return b.lastAt - a.lastAt;
        return a.name.localeCompare(b.name, 'pt-BR');
      })
      .forEach(function (entry) {
        var pubkey = entry.pubkey;
        var name = entry.name;
        var unread = entry.unread;
        var button = el(
          'button',
          'contact-button' +
            (sameKey(state.peer, pubkey) ? ' active' : '') +
            (unread ? ' has-unread' : '')
        );
        button.type = 'button';
        button.dataset.pubkey = pubkey;
        button.title = name + ' · ' + shortKey(pubkey);
        button.setAttribute(
          'aria-label',
          unread
            ? name + ', ' + unread + (unread === 1 ? ' mensagem não lida' : ' mensagens não lidas')
            : name
        );

        var profileInfo = profileData(profileOf(pubkey));
        button.appendChild(avatarNode(name, pubkey, profileInfo.image));

        var meta = el('div', 'contact-meta');
        meta.appendChild(el('strong', '', name));
        meta.appendChild(
          el(
            'small',
            'contact-preview',
            unread
              ? 'Nova mensagem'
              : entry.preview
          )
        );
        button.appendChild(meta);

        var side = el('div', 'contact-side');
        side.appendChild(
          el('span', 'contact-time', entry.lastAt ? formatRelative(entry.lastAt) : '')
        );
        if (unread) {
          side.appendChild(
            el('span', 'contact-badge', unread > 99 ? '99+' : String(unread))
          );
        }
        button.appendChild(side);

        list.appendChild(button);
      });

    updateMessageBadge();
  }

  function renderNewChatContacts() {
    var list = byId('new-chat-list');
    if (!list) return;

    clear(list);

    var me = state.identity ? state.identity.publicKey : '';
    var entries = Array.from(state.following)
      .filter(function (pubkey) {
        return (
          typeof pubkey === 'string' &&
          onpostt.isValidPublicKey(pubkey) &&
          !sameKey(pubkey, me) &&
          !isBlockedPubkey(pubkey)
        );
      })
      .map(function (pubkey) {
        return {
          pubkey: pubkey,
          name: peerLabel(pubkey),
        };
      });

    var query = state.newChatQuery.trim().toLowerCase();
    if (query) {
      entries = entries.filter(function (entry) {
        return (
          entry.name.toLowerCase().includes(query) ||
          entry.pubkey.toLowerCase().includes(query)
        );
      });
    }

    if (entries.length === 0) {
      list.appendChild(
        el(
          'p',
          'faint small mb-0',
          query
            ? 'Nenhum contato encontrado.'
            : 'Você ainda não segue ninguém. Abra uma conversa pela pubkey acima.'
        )
      );
      return;
    }

    entries
      .sort(function (a, b) {
        return a.name.localeCompare(b.name, 'pt-BR');
      })
      .forEach(function (entry) {
        var button = el(
          'button',
          'contact-button new-chat-contact' +
            (sameKey(state.peer, entry.pubkey) ? ' active' : '')
        );
        button.type = 'button';
        button.dataset.pubkey = entry.pubkey;
        button.title = entry.name + ' · ' + shortKey(entry.pubkey);
        button.setAttribute('aria-label', 'Conversar com ' + entry.name);

        var info = profileData(profileOf(entry.pubkey));
        button.appendChild(avatarNode(entry.name, entry.pubkey, info.image));

        var meta = el('div', 'contact-meta');
        meta.appendChild(el('strong', '', entry.name));
        meta.appendChild(el('small', 'contact-preview mono', shortKey(entry.pubkey)));
        button.appendChild(meta);

        list.appendChild(button);
      });
  }

  function ensureFollowedProfiles() {
    var missing = Array.from(state.following).filter(function (pubkey) {
      return (
        typeof pubkey === 'string' &&
        onpostt.isValidPublicKey(pubkey) &&
        !state.profiles.has(pubkey) &&
        !state.profileLookups.has(pubkey)
      );
    });
    if (!missing.length) return Promise.resolve();

    return loadProfilesForKeys(missing.slice(0, MAX_NEW_CHAT_PROFILE_LOOKUPS)).then(function () {
      renderNewChatContacts();
      renderContacts();
    });
  }

  async function refreshInbox() {
    var me = state.identity.publicKey;
    var results = await Promise.all([
      onpostt.list({ mode: 'message', pubkey: me, app: APP, limit: MAX_INBOX }),
      onpostt.list({ mode: 'message_read', pubkey: me, app: APP, limit: MAX_MESSAGE_READS }),
    ]);

    var inbox = new Map();
    var outbox = new Map();
    results[0].forEach(function (block) {
      if (!block || block.mode !== 'message' || block.app !== APP) return;
      var from = queryValue(block, 'from');
      var to = queryValue(block, 'to');
      if (!from || !to) return;

      var id = logicalId(block);
      if (!id) return;

      if (sameKey(from, me) && !sameKey(to, me)) {
        if (!outbox.has(to)) outbox.set(to, new Map());
        outbox.get(to).set(id, block);
        return;
      }

      if (!sameKey(from, me) && sameKey(to, me)) {
        if (!inbox.has(from)) inbox.set(from, new Map());
        inbox.get(from).set(id, block);
      }
    });

    state.inbox = inbox;
    state.outbox = outbox;

    var read = new Set(state.messageRead);
    results[1].forEach(function (receipt) {
      if (!receipt || receipt.mode !== 'message_read' || receipt.app !== APP) return;
      var content = contentObject(receipt);
      var ids = content && content.read;
      if (!Array.isArray(ids)) return;
      ids.forEach(function (id) {
        if (typeof id === 'string' && id) read.add(id.toLowerCase());
      });
    });
    state.messageRead = read;

    var hiddenChanged = false;
    state.hiddenChats.forEach(function (entry, peer) {
      var hasNew = conversationMessagesFor(peer).some(function (block) {
        var id = logicalId(block);
        return !entry.known.has(id) || (Number(block.created_at) || 0) > entry.cutoff;
      });
      if (hasNew) {
        state.hiddenChats.delete(peer);
        hiddenChanged = true;
      }
    });
    if (hiddenChanged) saveHiddenChats();

    var peers = new Set();
    state.inbox.forEach(function (messages, peer) {
      peers.add(peer);
    });
    state.outbox.forEach(function (messages, peer) {
      peers.add(peer);
    });
    peers.forEach(ensurePeerProfile);
    renderContacts();
  }

  async function persistMessageReads(ids) {
    var unique = [];
    var seen = new Set();
    ids.forEach(function (id) {
      var normalized = typeof id === 'string' ? id.toLowerCase() : '';
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      unique.push(normalized);
    });

    for (var index = 0; index < unique.length; index += MESSAGE_READ_BATCH) {
      await publish({
        mode: 'message_read',
        query: [],
        content: { read: unique.slice(index, index + MESSAGE_READ_BATCH) },
        app: APP,
      });
    }
  }

  async function markMessagesRead(ids) {
    var pending = [];
    ids.forEach(function (id) {
      var normalized = typeof id === 'string' ? id.toLowerCase() : '';
      if (!normalized || state.messageRead.has(normalized)) return;
      pending.push(normalized);
    });
    if (pending.length === 0) return;

    pending.forEach(function (id) {
      state.messageRead.add(id);
    });
    renderContacts();

    try {
      await persistMessageReads(pending);
    } catch (error) {
      pending.forEach(function (id) {
        state.messageRead.delete(id);
      });
      renderContacts();
      reportError(error.message);
    }
  }

  function markConversationRead(peer) {
    if (!peer) return;
    var ids = unreadMessagesFor(peer).map(function (block) {
      return logicalId(block);
    });
    if (ids.length) markMessagesRead(ids);
  }

  function maybeUnhideChat(peer, block) {
    var entry = state.hiddenChats.get(peer);
    if (!entry) return false;

    var id = logicalId(block);
    if (entry.known.has(id) && (Number(block.created_at) || 0) <= entry.cutoff) {
      return false;
    }
    return unhideChat(peer);
  }

  function handleMessageBlock(block) {
    if (!block || block.mode !== 'message' || block.app !== APP) return;

    var me = state.identity.publicKey;
    var from = queryValue(block, 'from');
    var to = queryValue(block, 'to');
    if (!from || !to) return;

    var id = logicalId(block);
    if (!id) return;

    if (sameKey(from, me)) {
      if (sameKey(to, me)) return;
      if (!state.outbox.has(to)) state.outbox.set(to, new Map());
      state.outbox.get(to).set(id, block);
      maybeUnhideChat(to, block);
      ensurePeerProfile(to);
      renderContacts();
      return;
    }

    if (!sameKey(to, me)) return;

    if (!state.inbox.has(from)) state.inbox.set(from, new Map());
    state.inbox.get(from).set(id, block);
    maybeUnhideChat(from, block);
    ensurePeerProfile(from);

    if (state.view === 'chat' && sameKey(state.peer, from)) {
      markMessagesRead([id]);
    } else {
      renderContacts();
    }
  }

  function subscribeInbox() {
    onpostt.sub(
      { mode: 'message', app: APP, pubkey: state.identity.publicKey, limit: 20 },
      function (event) {
        (event.blocks || []).forEach(handleMessageBlock);
      }
    );

    onpostt.sub(
      { mode: 'message_read', app: APP, pubkey: state.identity.publicKey, limit: 1 },
      function () {
        scheduleRefresh();
      }
    );
  }

  function formatAudioDuration(seconds) {
    var total = Math.max(1, Math.round(Number(seconds) || 0));
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  }

  function renderChat() {
    var list = byId('chat-messages');
    if (!list) return;
    clear(list);

    if (!state.peer) {
      list.appendChild(el('p', 'empty-state-inline', 'Abra uma conversa para começar.'));
      return;
    }

    var messages = Array.from(state.chat.values()).sort(function (a, b) {
      return (Number(a.block.created_at) || 0) - (Number(b.block.created_at) || 0);
    });

    if (messages.length === 0) {
      list.appendChild(el('p', 'empty-state-inline', 'Nenhuma mensagem. Diga olá!'));
      return;
    }

    var me = state.identity.publicKey;
    var lastDay = '';

    messages.forEach(function (entry, index) {
      var block = entry.block;
      var mine = sameKey(queryValue(block, 'from'), me);
      var day = formatDayLabel(block.created_at);

      if (day && day !== lastDay) {
        list.appendChild(el('div', 'message-date', day));
        lastDay = day;
      }

      var bubble = el(
        'div',
        'message' + (mine ? ' mine' : '') + (entry.text === null ? ' failed' : '')
      );
      var prev = messages[index - 1];
      var next = messages[index + 1];
      var prevMine = prev && sameKey(queryValue(prev.block, 'from'), me);
      var nextMine = next && sameKey(queryValue(next.block, 'from'), me);

      if (!prev || prevMine !== mine) bubble.classList.add('group-start');
      if (!next || nextMine !== mine) bubble.classList.add('group-end');
      bubble.dataset.mine = mine ? 'true' : 'false';
      bubble.title = formatTime(block.created_at);

      if (entry.text === null) {
        bubble.appendChild(el('span', '', '[não foi possível descriptografar]'));
      } else {
        var payload = entry.payload || messagePayload(entry.text);

        if (payload.image) {
          var image = document.createElement('img');
          image.className = 'message-image';
          image.src = 'data:' + payload.image.mime + ';base64,' + payload.image.data;
          image.alt = 'Imagem enviada na conversa';
          image.width = payload.image.width;
          image.height = payload.image.height;
          image.loading = 'lazy';
          image.decoding = 'async';
          image.referrerPolicy = 'no-referrer';
          bubble.appendChild(image);
        }

        if (payload.audio) {
          var audio = document.createElement('audio');
          audio.className = 'message-audio';
          audio.controls = true;
          audio.preload = 'metadata';
          audio.src = 'data:' + payload.audio.mime + ';base64,' + payload.audio.data;
          bubble.appendChild(audio);
          bubble.appendChild(
            el('span', 'message-duration', 'Áudio · ' + formatAudioDuration(payload.audio.duration))
          );
        }

        if (payload.text) bubble.appendChild(el('span', 'message-text', payload.text));
      }

      bubble.appendChild(
        el(
          'span',
          'message-meta',
          (mine ? 'você' : peerLabel(state.peer)) + ' · ' + formatTime(block.created_at)
        )
      );
      list.appendChild(bubble);
    });

    list.scrollTop = list.scrollHeight;
  }

  function stopChatSubscriptions() {
    state.chatUnsubs.forEach(function (unsubscribe) {
      try {
        unsubscribe();
      } catch (error) {
        /* ignore */
      }
    });
    state.chatUnsubs = [];
  }

  async function consumeMessages(blocks, peer) {
    if (!peer || state.peer !== peer) return;

    for (var i = 0; i < blocks.length; i += 1) {
      var block = blocks[i];
      if (!block || block.mode !== 'message') continue;

      var key = logicalId(block);
      if (!key || state.chat.has(key) || state.chatPending.has(key)) continue;
      if (block.app !== APP) continue;

      state.chatPending.add(key);

      var text = null;
      try {
        text = await onpostt.decryptMessage(state.identity.privateKey, block);
      } catch (error) {
        text = null;
      }

      if (state.peer !== peer) {
        state.chatPending.delete(key);
        return;
      }

      state.chat.set(key, {
        block: block,
        text: text,
        payload: text === null ? null : messagePayload(text),
      });
      state.chatPending.delete(key);

      handleMessageBlock(block);
    }

    renderChat();
  }

  async function loadConversation(peer) {
    var me = state.identity.publicKey;
    var filters = [
      { mode: 'message', app: APP, query: [['from', peer], ['to', me]], limit: 200 },
      { mode: 'message', app: APP, query: [['from', me], ['to', peer]], limit: 200 },
    ];

    var results = await Promise.all(
      filters.map(function (filter) {
        return onpostt.list(filter);
      })
    );

    await consumeMessages(results[0], peer);
    await consumeMessages(results[1], peer);
  }

  function subscribeConversation(peer) {
    var me = state.identity.publicKey;

    var first = onpostt.sub(
      { mode: 'message', app: APP, query: [['from', peer], ['to', me]], limit: 200 },
      function (event) {
        consumeMessages(event.blocks, peer);
      }
    );

    var second = onpostt.sub(
      { mode: 'message', app: APP, query: [['from', me], ['to', peer]], limit: 200 },
      function (event) {
        consumeMessages(event.blocks, peer);
      }
    );

    state.chatUnsubs.push(first, second);
  }

  function setNewChatFormOpen(open) {
    var panel = byId('new-chat-panel');
    if (!panel) return;
    panel.hidden = !open;

    var toggle = byId('toggle-new-chat');
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');

    var search = byId('new-chat-search');

    if (open) {
      renderNewChatContacts();
      ensureFollowedProfiles();
      if (search) search.focus();
      else {
        var input = byId('peer-input');
        if (input) input.focus();
      }
    } else {
      state.newChatQuery = '';
      if (search) search.value = '';
    }
  }

  async function openChat(peer) {
    if (!peer || !onpostt.isValidPublicKey(peer)) {
      toast('Pubkey inválida. Use 66 ou 130 caracteres hex.', true);
      return;
    }
    if (sameKey(peer, state.identity.publicKey)) {
      toast('Você não precisa conversar consigo mesmo.', true);
      return;
    }
    if (isBlockedPubkey(peer)) {
      toast('Não é possível conversar com um usuário bloqueado.', true);
      return;
    }

    // Fora da página dedicada, "Conversar" leva para messages.html em vez de
    // abrir a view interna do index.
    if (!MESSAGES_PAGE) {
      window.location.assign('/messages.html?peer=' + encodeURIComponent(peer));
      return;
    }

    stopAudioRecording(true);
    setNewChatFormOpen(false);
    unhideChat(peer);
    ensurePeerProfile(peer);
    stopChatSubscriptions();
    state.peer = peer;
    state.chat = new Map();
    state.chatPending = new Set();
    state.chatUnsubs = [];

    updateChatHeader();
    var layout = byId('direct-layout');
    if (layout) layout.classList.add('thread-open');
    renderChat();
    renderContacts();
    switchView('chat');

    try {
      await loadConversation(peer);
      subscribeConversation(peer);
    } catch (error) {
      reportError(error.message);
    }
  }

  function deleteConversation() {
    var peer = state.peer;
    if (!peer) return;
    if (state.chatMediaBusy) {
      toast('Aguarde o envio de mídia terminar antes de apagar a conversa.', true);
      return;
    }

    var confirmed = window.confirm(
      'Apagar esta conversa deste dispositivo? As mensagens continuam no relay e novas mensagens podem reabrir o contato.'
    );
    if (!confirmed) return;

    var messages = conversationMessagesFor(peer);
    var cutoff = messages.reduce(function (max, block) {
      return Math.max(max, Number(block.created_at) || 0);
    }, 0);
    var known = new Set(
      messages.map(function (block) {
        return logicalId(block);
      })
    );

    state.hiddenChats.set(peer, { cutoff: cutoff, known: known });
    saveHiddenChats();

    stopAudioRecording(true);
    stopChatSubscriptions();
    state.peer = null;
    state.chat = new Map();
    state.chatPending = new Set();
    state.chatUnsubs = [];

    updateChatHeader();
    var layout = byId('direct-layout');
    if (layout) layout.classList.remove('thread-open');
    renderChat();
    renderContacts();
    toast('Conversa apagada deste dispositivo.');
  }

  function setChatHint(message) {
    var hint = byId('chat-media-hint');
    if (hint) hint.textContent = message || 'Imagem até 500px · áudio até 15s.';
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var result = String(reader.result || '');
        var comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : '');
      };
      reader.onerror = function () {
        reject(new Error('Não foi possível ler o áudio gravado.'));
      };
      reader.readAsDataURL(blob);
    });
  }

  function chooseAudioMime() {
    if (typeof MediaRecorder === 'undefined') return '';
    var candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    for (var i = 0; i < candidates.length; i += 1) {
      if (typeof MediaRecorder.isTypeSupported !== 'function') return candidates[0];
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  async function sendMessageContent(content) {
    if (!state.peer) return null;
    if (isBlockedPubkey(state.peer)) {
      throw new Error('Não é possível enviar mensagens para um usuário bloqueado.');
    }

    var peer = state.peer;
    var serialized = typeof content === 'string' ? content : JSON.stringify(content);
    var output = await publish({
      mode: 'message',
      query: [
        ['from', state.identity.publicKey],
        ['to', peer],
      ],
      content: serialized,
      app: APP,
    });

    var key = logicalId(output.block);
    if (sameKey(state.peer, peer) && !state.chat.has(key)) {
      state.chat.set(key, {
        block: output.block,
        text: serialized,
        payload: messagePayload(serialized),
      });
    }

    handleMessageBlock(output.block);
    if (sameKey(state.peer, peer)) renderChat();
    return output;
  }

  async function handleChatImage(file) {
    if (!state.peer) {
      toast('Abra uma conversa antes de enviar uma imagem.', true);
      return;
    }
    if (!file || state.chatMediaBusy || state.audioRecording) return;

    var input = byId('chat-input');
    var caption = input ? input.value.trim() : '';

    state.chatMediaBusy = true;
    updateChatHeader();
    setChatHint('Preparando imagem…');

    try {
      var image = await onpostt.prepareImage(file, {
        maxDimension: MAX_CHAT_IMAGE_DIMENSION,
        maxBytes: MAX_CHAT_IMAGE_BYTES,
        maxSourceBytes: 12 * 1024 * 1024,
        mime: 'image/jpeg',
      });

      setChatHint('Enviando imagem…');
      await sendMessageContent({
        text: caption,
        image: {
          mime: image.mime,
          data: image.data,
          width: image.width,
          height: image.height,
        },
      });

      if (input) input.value = '';
      toast('Imagem enviada.');
    } catch (error) {
      reportError(error.message);
    } finally {
      state.chatMediaBusy = false;
      updateChatHeader();
      setChatHint('');
      var picker = byId('chat-image');
      if (picker) picker.value = '';
    }
  }

  function cleanupAudioRecording(recording) {
    if (recording.interval) clearInterval(recording.interval);
    if (recording.stream) {
      recording.stream.getTracks().forEach(function (track) {
        track.stop();
      });
    }
    if (state.audioRecording === recording) state.audioRecording = null;
    updateChatHeader();
  }

  async function finishAudioRecording(recording, blob) {
    var duration = Math.min(
      15,
      Math.max(0.5, (Date.now() - recording.startedAt) / 1000)
    );
    var cancelled = recording.cancelled;
    var mime = recording.mimeType || 'audio/webm';
    cleanupAudioRecording(recording);

    if (cancelled) {
      setChatHint('');
      return;
    }

    if (!blob || !blob.size) {
      toast('O áudio ficou vazio. Tente novamente.', true);
      setChatHint('');
      return;
    }

    if (blob.size > MAX_CHAT_AUDIO_BYTES) {
      toast('O áudio ficou grande demais. Tente gravar um trecho menor.', true);
      setChatHint('');
      return;
    }

    state.chatMediaBusy = true;
    updateChatHeader();
    setChatHint('Enviando áudio…');

    try {
      var data = await blobToBase64(blob);
      if (data.length > MAX_CHAT_AUDIO_BASE64) {
        throw new Error('O áudio ficou grande demais para o envelope cifrado.');
      }
      await sendMessageContent({
        text: '',
        audio: {
          mime: mime,
          data: data,
          duration: Math.round(duration * 10) / 10,
        },
      });
      toast('Áudio enviado.');
    } catch (error) {
      reportError(error.message);
    } finally {
      state.chatMediaBusy = false;
      updateChatHeader();
      setChatHint('');
    }
  }

  function stopAudioRecording(cancel) {
    var recording = state.audioRecording;
    if (!recording) return;

    if (cancel) recording.cancelled = true;
    if (recording.stopping) return;
    recording.stopping = true;

    try {
      if (recording.recorder.state !== 'inactive') recording.recorder.stop();
      else finishAudioRecording(recording, null);
    } catch (error) {
      recording.cancelled = true;
      finishAudioRecording(recording, null);
    }
  }

  async function startAudioRecording() {
    if (!state.peer) {
      toast('Abra uma conversa antes de gravar áudio.', true);
      return;
    }
    if (state.audioRecording) {
      stopAudioRecording(false);
      return;
    }
    if (state.chatMediaBusy) {
      toast('Aguarde o envio da imagem terminar.', true);
      return;
    }
    if (
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function' ||
      typeof MediaRecorder === 'undefined'
    ) {
      toast('Este navegador não suporta gravação de áudio.', true);
      return;
    }

    var peer = state.peer;
    state.chatMediaBusy = true;
    updateChatHeader();
    setChatHint('Pedindo acesso ao microfone…');

    try {
      var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!sameKey(state.peer, peer) || state.audioRecording) {
        stream.getTracks().forEach(function (track) {
          track.stop();
        });
        state.chatMediaBusy = false;
        updateChatHeader();
        setChatHint('');
        return;
      }

      var mime = chooseAudioMime();
      var options = { audioBitsPerSecond: 24000 };
      if (mime) options.mimeType = mime;

      var recorder;
      try {
        recorder = new MediaRecorder(stream, options);
      } catch (error) {
        recorder = new MediaRecorder(stream);
      }

      var recording = {
        recorder: recorder,
        stream: stream,
        chunks: [],
        mimeType: recorder.mimeType || mime || 'audio/webm',
        startedAt: Date.now(),
        interval: null,
        cancelled: false,
        stopping: false,
      };
      state.audioRecording = recording;

      recorder.ondataavailable = function (event) {
        if (event.data && event.data.size > 0) recording.chunks.push(event.data);
      };
      recorder.onerror = function () {
        toast('Falha ao gravar áudio.', true);
        stopAudioRecording(true);
      };
      recorder.onstop = function () {
        var blob = recording.chunks.length
          ? new Blob(recording.chunks, { type: recording.mimeType })
          : null;
        finishAudioRecording(recording, blob);
      };

      recorder.start(250);
      state.chatMediaBusy = false;
      updateChatHeader();
      setChatHint('Gravando… 0,0s de 15s. Clique em Parar e enviar.');

      recording.interval = setInterval(function () {
        if (state.audioRecording !== recording) return;
        var elapsed = Date.now() - recording.startedAt;
        if (elapsed >= CHAT_AUDIO_LIMIT_MS) {
          stopAudioRecording(false);
          return;
        }
        setChatHint('Gravando… ' + (elapsed / 1000).toFixed(1) + 's de 15s.');
      }, 200);
    } catch (error) {
      if (state.audioRecording) {
        state.audioRecording.cancelled = true;
        cleanupAudioRecording(state.audioRecording);
      } else if (stream) {
        stream.getTracks().forEach(function (track) {
          track.stop();
        });
      }
      state.chatMediaBusy = false;
      updateChatHeader();
      setChatHint('');
      reportError('Não foi possível acessar o microfone: ' + error.message);
    }
  }

  async function handleSendMessage(event) {
    event.preventDefault();
    if (!state.peer) return;

    var input = byId('chat-input');
    var button = byId('chat-send');
    var content = input ? input.value.trim() : '';
    if (!content) return;

    setBusy(button, true);
    try {
      await sendMessageContent(content);
      if (input) input.value = '';
    } catch (error) {
      reportError(error.message);
    } finally {
      setBusy(button, false);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Carregamento                                                           */
  /* ---------------------------------------------------------------------- */

  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () {
      refreshTimer = null;
      refreshAll();
    }, 450);
  }

  async function refreshFeed() {
    // Mantém a quantidade de páginas que o usuário já pediu. Assim um refresh
    // ao vivo não faz o feed voltar para a primeira página.
    var limit = Math.min(state.feedPageCount * FEED_PAGE_SIZE, MAX_FEED_PAGE_SIZE);
    var posts = await onpostt.list({ mode: 'post', app: APP, limit: limit, offset: 0 });
    state.posts = posts.filter(function (post) {
      return post && post.mode === 'post';
    });
    state.feedOffset = posts.length;
    state.feedHasMore =
      state.feedOffset >= limit && state.feedOffset < MAX_FEED_PAGE_SIZE;
    if (posts.truncated) state.feedHasMore = true;
    renderFeed();
  }

  async function loadMoreFeed() {
    if (state.feedLoadingMore || !state.feedHasMore || state.topicFilter) return;
    state.feedLoadingMore = true;
    updateFeedMoreButton();

    try {
      var posts = await onpostt.list({
        mode: 'post',
        app: APP,
        limit: FEED_PAGE_SIZE,
        offset: state.feedOffset,
      });
      var existing = new Set(
        state.posts
          .map(function (post) {
            return post && post.id;
          })
          .filter(Boolean)
      );
      var added = posts.filter(function (post) {
        return post && post.mode === 'post' && !existing.has(post.id);
      });
      if (added.length) state.posts = state.posts.concat(added);
      state.feedOffset += posts.length;
      state.feedPageCount += 1;
      state.feedHasMore =
        posts.length >= FEED_PAGE_SIZE || Boolean(posts.truncated);
      renderFeed();

      if (added.length) {
        // Só carrega os dados extras dos novos posts quando o usuário pede.
        await Promise.all([refreshSocial(), refreshSuggestedProfiles()]);
        renderPostSurfaces();
      }
    } catch (error) {
      reportError(error.message);
    } finally {
      state.feedLoadingMore = false;
      updateFeedMoreButton();
    }
  }

  async function refreshProfiles() {
    // Antes o app baixava 200 perfis globais em toda atualização. Agora só o
    // próprio perfil é atualizado aqui; os demais são carregados por demanda.
    var me = state.identity.publicKey;
    var profiles = await onpostt.list({ mode: 'profile', app: APP, pubkey: me, limit: 1 });
    if (profiles && profiles[0]) keepProfile(profiles[0]);

    fillProfileForm();
    updateIdentityUi();
    renderProfiles();
    renderContacts();
    updateChatHeader();
  }

  function collectSuggestedPubkeys() {
    var seen = new Set([state.identity.publicKey]);
    var list = [];

    function add(pubkey) {
      if (typeof pubkey !== 'string' || !pubkey || seen.has(pubkey)) return;
      seen.add(pubkey);
      list.push(pubkey);
    }

    // Autores visíveis primeiro, para o feed não ficar só com pubkeys
    // abreviadas; depois entram as relações e demais interações conhecidas.
    state.posts.forEach(function (post) {
      if (post) add(post.pubkey);
    });
    state.topicPosts.forEach(function (post) {
      if (post) add(post.pubkey);
    });
    state.repostBlocks.forEach(function (block) {
      if (block) add(block.pubkey);
    });
    state.repostPosts.forEach(function (post) {
      if (post) add(post.pubkey);
    });
    state.following.forEach(add);
    state.followers.forEach(add);
    state.comments.forEach(function (comments) {
      comments.forEach(function (comment) {
        if (comment) add(comment.pubkey);
      });
    });
    state.notifications.forEach(function (notification) {
      if (notification) add(notification.pubkey);
    });

    return list.slice(0, MAX_PROFILE_SUGGESTIONS);
  }

  async function refreshSuggestedProfiles() {
    var candidates = collectSuggestedPubkeys();
    state.suggestedPubkeys = candidates;

    await loadProfilesForKeys(candidates);

    // Sem relações/feed, mostra ao menos o próprio perfil em vez de uma lista
    // global de desconhecidos.
    if (state.suggestedPubkeys.length === 0 && state.profiles.has(state.identity.publicKey)) {
      state.suggestedPubkeys = [state.identity.publicKey];
    }

    renderProfiles();
  }

  async function refreshSocial() {
    var me = state.identity.publicKey;

    var results = await Promise.all([
      onpostt.list({ mode: 'like', app: APP, limit: MAX_SOCIAL }),
      onpostt.list({ mode: 'comment', app: APP, limit: MAX_COMMENT_INDEX }),
      onpostt.list({ mode: 'reaction', app: APP, limit: MAX_SOCIAL }),
      onpostt.list({ mode: 'repost', app: APP, limit: MAX_SOCIAL }),
      onpostt.list({ mode: 'follow', app: APP, query: [['follower', me]], limit: MAX_SOCIAL }),
      onpostt.list({ mode: 'follow', app: APP, query: [['following', me]], limit: MAX_SOCIAL }),
      onpostt.list({ mode: 'block', app: APP, query: [['blocker', me]], limit: MAX_SOCIAL }),
      onpostt.list({ mode: 'block', app: APP, query: [['blocked', me]], limit: MAX_SOCIAL }),
    ]);

    var likes = new Map();
    var likedByMe = new Set();
    results[0].forEach(function (block) {
      var target = queryValue(block, 'block');
      if (!target) return;
      likes.set(target, (likes.get(target) || 0) + 1);
      if (block.pubkey === me) likedByMe.add(target);
    });

    var comments = new Map();
    results[1].forEach(function (block) {
      var target = queryValue(block, 'block');
      if (!target) return;
      if (!comments.has(target)) comments.set(target, []);
      comments.get(target).push(block);
    });

    // A consulta acima é só um índice recente para contadores. Se uma thread
    // já foi aberta, preserva os comentários completos carregados sob demanda.
    state.commentLoaded.forEach(function (target) {
      var loaded = state.comments.get(target) || [];
      if (!loaded.length) return;
      if (!comments.has(target)) comments.set(target, []);
      var merged = new Map();
      comments.get(target).forEach(function (comment) {
        if (comment && comment.id) merged.set(comment.id, comment);
      });
      loaded.forEach(function (comment) {
        if (comment && comment.id) merged.set(comment.id, comment);
      });
      comments.set(target, Array.from(merged.values()));
    });

    var reactions = new Map();
    var myReactions = new Set();
    results[2].forEach(function (block) {
      var target = queryValue(block, 'block');
      var emoji = queryValue(block, 'reaction');
      if (!target || typeof emoji !== 'string') return;

      if (!reactions.has(target)) reactions.set(target, new Map());
      var targetReactions = reactions.get(target);
      targetReactions.set(emoji, (targetReactions.get(emoji) || 0) + 1);

      if (block.pubkey === me) {
        myReactions.add(target + REACTION_SEP + emoji);
      }
    });

    var repostBlocks = results[3].filter(function (block) {
      return block && block.mode === 'repost';
    });
    var reposts = new Map();
    var repostedByMe = new Set();
    repostBlocks.forEach(function (block) {
      var target = queryValue(block, 'block');
      if (!target) return;
      reposts.set(target, (reposts.get(target) || 0) + 1);
      if (block.pubkey === me) repostedByMe.add(target);
    });

    var following = new Set();
    results[4].forEach(function (block) {
      var target = queryValue(block, 'following');
      if (typeof target === 'string') following.add(target);
    });

    var followers = new Set();
    results[5].forEach(function (block) {
      var target = queryValue(block, 'follower');
      if (typeof target === 'string') followers.add(target);
    });

    var blocked = new Set();
    results[6].forEach(function (block) {
      var target = queryValue(block, 'blocked');
      if (typeof target === 'string') blocked.add(target);
    });

    var blockedBy = new Set();
    results[7].forEach(function (block) {
      var target = queryValue(block, 'blocker');
      if (typeof target === 'string') blockedBy.add(target);
    });

    state.likes = likes;
    state.likedByMe = likedByMe;
    state.reactions = reactions;
    state.myReactions = myReactions;
    state.comments = comments;
    state.reposts = reposts;
    state.repostedByMe = repostedByMe;
    state.repostBlocks = repostBlocks;
    state.following = following;
    state.followers = followers;
    state.blocked = blocked;
    state.blockedBy = blockedBy;
  }

  async function refreshRepostPosts() {
    var posts = new Map();
    state.posts.forEach(function (post) {
      if (post && post.id) posts.set(post.id, post);
    });

    var missing = [];
    var seen = new Set();
    state.repostBlocks
      .slice()
      .sort(function (a, b) {
        return (b.created_at || 0) - (a.created_at || 0);
      })
      .slice(0, MAX_REPOSTS)
      .forEach(function (block) {
        var target = queryValue(block, 'block');
        if (!target || seen.has(target) || posts.has(target)) return;
        seen.add(target);
        missing.push(target);
      });

    var fetched = await Promise.all(
      missing.slice(0, MAX_REPOST_FETCHES).map(function (id) {
        return onpostt
          .list({ mode: 'post', app: APP, id: id, limit: 1 })
          .then(function (list) {
            return list && list[0] && list[0].mode === 'post' ? list[0] : null;
          })
          .catch(function () {
            return null;
          });
      })
    );

    fetched.forEach(function (post) {
      if (post && post.id) posts.set(post.id, post);
    });
    state.repostPosts = posts;
  }

  async function refreshRepostProfiles() {
    var missing = new Set();

    function add(pubkey) {
      if (!pubkey || typeof pubkey !== 'string') return;
      if (state.profiles.has(pubkey) || state.profileLookups.has(pubkey)) return;
      missing.add(pubkey);
    }

    state.repostBlocks.forEach(function (block) {
      if (block) add(block.pubkey);
    });
    state.repostPosts.forEach(function (post) {
      if (post) add(post.pubkey);
    });

    var candidates = Array.from(missing).slice(0, MAX_REPOST_PROFILE_LOOKUPS);
    candidates.forEach(function (candidate) {
      state.profileLookups.add(candidate);
    });

    await Promise.all(
      candidates.map(function (candidate) {
        return onpostt
          .list({ mode: 'profile', pubkey: candidate, limit: 1 })
          .then(function (profiles) {
            if (profiles && profiles[0]) state.profiles.set(candidate, profiles[0]);
          })
          .catch(function () {
            /* perfil ausente: usa as iniciais da pubkey */
          });
      })
    );
  }

  async function loadCommentsFor(blockId) {
    if (!blockId || state.commentLoading.has(blockId)) return;
    state.commentLoading.add(blockId);
    state.commentLoaded.delete(blockId);
    if (state.openComments.has(blockId)) renderPostSurfaces();

    try {
      var comments = await onpostt.list({
        mode: 'comment',
        app: APP,
        query: [['block', blockId]],
        limit: MAX_COMMENTS_PER_POST,
      });
      var list = comments.filter(function (comment) {
        return comment && comment.mode === 'comment';
      });
      state.comments.set(blockId, list);
      state.commentLoaded.add(blockId);
      await refreshCommenterProfiles();
    } catch (error) {
      reportError(error.message);
    } finally {
      state.commentLoading.delete(blockId);
      renderPostSurfaces();
    }
  }

  async function refreshCommenterProfiles() {
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
          !state.profileLookups.has(candidate)
        );
      })
      .slice(0, 50);

    missing.forEach(function (candidate) {
      state.profileLookups.add(candidate);
    });

    await Promise.all(
      missing.map(function (candidate) {
        return onpostt
          .list({ mode: 'profile', pubkey: candidate, limit: 1 })
          .then(function (profiles) {
            if (profiles && profiles[0]) state.profiles.set(candidate, profiles[0]);
          })
          .catch(function () {
            /* sem perfil público: o comentário usa as iniciais da pubkey */
          });
      })
    );
  }

  async function refreshAll() {
    if (state.refreshing) {
      state.refreshQueued = true;
      return;
    }
    state.refreshing = true;

    try {
      // messages.html não precisa baixar feed, trending e notificações.
      if (MESSAGES_PAGE) {
        await Promise.all([refreshProfiles(), refreshSocial(), refreshInbox()]);
        renderContacts();
        renderNewChatContacts();
        var newChatPanel = byId('new-chat-panel');
        if (newChatPanel && !newChatPanel.hidden) ensureFollowedProfiles();
        updateChatHeader();
        return;
      }

      // post.html só precisa da publicação aberta, dos perfis e das interações.
      if (POST_PAGE) {
        await Promise.all([
          refreshProfiles(),
          refreshSocial(),
          refreshNotifications(),
          refreshInbox(),
        ]);
        await refreshCommenterProfiles();
        if (
          state.detail &&
          state.detail.repost &&
          !state.repostBlocks.some(function (block) {
            return block.id === state.detail.repost.id;
          })
        ) {
          state.repostBlocks.unshift(state.detail.repost);
        }
        renderPostDetail();
        return;
      }

      await Promise.all([
        refreshFeed(),
        refreshProfiles(),
        refreshSocial(),
        refreshNotifications(),
        refreshInbox(),
        refreshTrending(),
        state.topicFilter ? refreshTopicPosts() : Promise.resolve(),
      ]);
      await Promise.all([refreshCommenterProfiles(), refreshRepostPosts()]);
      await refreshRepostProfiles();
      await refreshSuggestedProfiles();
      // `refreshFeed` pode terminar antes de curtidas/comentários/reações.
      // Renderiza de novo com todos os estados atualizados.
      renderPostSurfaces();
      renderProfiles();
      renderNotifications();
      renderContacts();
      updateChatHeader();
    } catch (error) {
      reportError(error.message || 'Falha ao atualizar o demo.');
    } finally {
      state.refreshing = false;
      if (state.refreshQueued) {
        state.refreshQueued = false;
        scheduleRefresh();
      }
    }
  }

  function subscribeLive() {
    var filters = [
      { mode: 'post' },
      { mode: 'profile' },
      { mode: 'like' },
      { mode: 'reaction' },
      { mode: 'comment' },
      { mode: 'repost' },
      { mode: 'follow' },
      { mode: 'block' },
      { mode: 'delete' },
    ];

    filters.forEach(function (filter) {
      filter.app = APP;
      filter.limit = 1;
      onpostt.sub(filter, function () {
        scheduleRefresh();
      });
    });

    // Notificações são assinadas por outros usuários. A assinatura fica
    // restrita ao destinatário atual para não baixar notificações de terceiros.
    onpostt.sub(
      {
        mode: 'notification',
        app: APP,
        query: [['to', state.identity.publicKey]],
        limit: 1,
      },
      function () {
        scheduleRefresh();
      }
    );

    onpostt.sub(
      {
        mode: 'notification_read',
        app: APP,
        pubkey: state.identity.publicKey,
        limit: 1,
      },
      function () {
        scheduleRefresh();
      }
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Navegação e eventos                                                    */
  /* ---------------------------------------------------------------------- */

  function switchView(name, options) {
    if (name !== 'chat' && state.audioRecording) stopAudioRecording(true);
    state.view = name;

    document.querySelectorAll('.nav-button').forEach(function (button) {
      button.classList.toggle('active', button.dataset.view === name);
    });
    var identityButton = byId('identity-button');
    if (identityButton) {
      identityButton.classList.toggle('active', name === 'profile-edit' || name === 'settings');
    }
    closeProfileMenu();

    ['feed', 'profiles', 'profile-edit', 'settings', 'notifications', 'chat', 'post', 'about'].forEach(function (view) {
      var section = byId('view-' + view);
      if (section) section.hidden = view !== name;
    });

    if (options && options.skipRender) return;

    if (name === 'post') renderPostDetail();
    if (name === 'profiles') {
      renderProfiles();
    }
    if (name === 'profile-edit') {
      fillProfileForm();
      renderProfilePhoto();
    }
    if (name === 'settings') {
      renderSettings();
    }
    if (name === 'notifications') {
      renderNotifications();
    }
    if (name === 'chat') {
      renderContacts();
      updateChatHeader();
      renderChat();
      if (state.peer) markConversationRead(state.peer);
    }
  }

  function openIdentityDialog() {
    var dialog = byId('key-dialog');
    if (!dialog) return;
    byId('key-public').value = state.identity.publicKey;
    byId('key-private').value = state.identity.privateKey;
    var password = byId('export-password');
    if (password) password.value = '';
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', 'open');
  }

  async function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    var area = document.createElement('textarea');
    area.value = text;
    area.className = 'sr-only';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }

  async function exportIdentityVault() {
    if (!window.onposttAuth) {
      toast('O módulo de sessão não carregou.', true);
      return;
    }

    var passwordInput = byId('export-password');
    var button = byId('export-identity');
    var password = passwordInput ? passwordInput.value : '';

    try {
      window.onposttAuth.validatePassword(password);
    } catch (error) {
      toast(error.message, true);
      if (passwordInput) passwordInput.focus();
      return;
    }

    setBusy(button, true);
    try {
      var vault = await window.onposttAuth.createVault(state.identity, password);
      window.onposttAuth.downloadVault(vault, state.identity.username || vault.username);
      if (passwordInput) passwordInput.value = '';
      toast('Cofre cifrado exportado. Guarde o arquivo e a senha.');
    } catch (error) {
      toast(error.message, true);
    } finally {
      setBusy(button, false);
    }
  }

  async function logoutIdentity() {
    var confirmed = window.confirm(
      'Sair deste dispositivo? A sessão local e a chave lembrada serão apagadas. Baixe o cofre antes de sair.'
    );
    if (!confirmed) return;

    try {
      await window.onposttAuth.logout({
        notice: 'Sessão encerrada neste dispositivo. Entre novamente para continuar.',
      });
    } catch (error) {
      toast(error.message, true);
    }
  }

  function runPostAction(button) {
    if (!button) return;
    if (button.dataset.action === 'topic' && button.dataset.topic) {
      openTopic(button.dataset.topic);
      return;
    }

    var blockId = button.dataset.block;
    if (!blockId) return;
    var commentId = button.dataset.comment;

    if (button.dataset.action === 'like') handleLike(button, blockId);
    if (button.dataset.action === 'repost') handleRepost(button, blockId);
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
  }

  function openPostFromCard(event) {
    if (
      event.target.closest(
        '[data-action], a, button, input, textarea, select, label, form, img, .comment-box, .post-actions, .post-topics'
      )
    ) {
      return;
    }

    var article = event.target.closest('.post[data-block]');
    if (!article) return;
    var postId = article.dataset.block;
    if (!postId) return;
    window.location.assign(postDetailUrl(postId, article.dataset.repost || ''));
  }

  function goBackFromPost() {
    var referrer = document.referrer;
    if (referrer) {
      try {
        if (new URL(referrer).origin === window.location.origin) {
          window.history.back();
          return;
        }
      } catch (error) {
        /* referrer inválido: volta para o feed */
      }
    }
    window.location.assign('/?view=feed');
  }

  function bindEvents() {
    document.querySelectorAll('.nav-button').forEach(function (button) {
      button.addEventListener('click', function () {
        var view = button.dataset.view;

        if (view === 'chat') {
          if (!MESSAGES_PAGE) {
            window.location.assign(
              '/messages.html' +
                (state.peer ? '?peer=' + encodeURIComponent(state.peer) : '')
            );
            return;
          }

          // Na página de conversas, o clique no item do menu volta para a
          // lista no mobile e apenas reforça a view no desktop.
          var layout = byId('direct-layout');
          if (layout) layout.classList.remove('thread-open');
          switchView('chat');
          return;
        }

        if (MESSAGES_PAGE || POST_PAGE) {
          window.location.assign('/?view=' + encodeURIComponent(view));
          return;
        }

        switchView(view);
      });
    });

    document.querySelectorAll('[data-feed-mode]').forEach(function (button) {
      button.addEventListener('click', function () {
        setFeedMode(button.dataset.feedMode);
      });
    });

    var identityButton = byId('identity-button');
    if (identityButton) {
      identityButton.addEventListener('click', function (event) {
        event.stopPropagation();
        toggleProfileMenu();
      });
    }

    var menuKeys = byId('menu-keys');
    if (menuKeys) {
      menuKeys.addEventListener('click', function () {
        closeProfileMenu();
        openIdentityDialog();
      });
    }

    var menuLogout = byId('menu-logout');
    if (menuLogout) {
      menuLogout.addEventListener('click', function () {
        closeProfileMenu();
        logoutIdentity();
      });
    }

    var settingsKeys = byId('settings-keys');
    if (settingsKeys) {
      settingsKeys.addEventListener('click', openIdentityDialog);
    }

    var settingsLogout = byId('settings-logout');
    if (settingsLogout) {
      settingsLogout.addEventListener('click', logoutIdentity);
    }

    document.addEventListener('click', function (event) {
      var menu = byId('profile-menu');
      if (menu && event.target instanceof Node && !menu.contains(event.target)) {
        closeProfileMenu();
      }
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeProfileMenu();
    });

    var aboutIdentity = byId('about-identity');
    if (aboutIdentity) aboutIdentity.addEventListener('click', openIdentityDialog);

    byId('compose-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      if (state.imageBusy) {
        reportError('Aguarde o processamento da foto.');
        return;
      }

      var text = byId('post-content').value.trim();
      if (!text && !state.pendingImage) return;

      var topics = extractTopicsFromText(text).slice(0, MAX_TOPICS);
      state.composeTopics = topics;
      var content = text;
      if (state.pendingImage) {
        content = {
          image: {
            mime: state.pendingImage.mime,
            data: state.pendingImage.data,
            width: state.pendingImage.width,
            height: state.pendingImage.height,
          },
        };
        if (text) content.text = text;
      } else if (topics.length) {
        content = { text: text };
      }
      if (topics.length) content.topics = topics;

      var button = byId('publish-button');
      setBusy(button, true);
      try {
        await publish({
          mode: 'post',
          query: [],
          content: content,
          app: APP,
        });
        byId('post-content').value = '';
        state.composeTopics = [];
        syncComposeTopics();
        if (composePreviewTimer) {
          clearTimeout(composePreviewTimer);
          composePreviewTimer = null;
        }
        var composePreviews = byId('compose-link-previews');
        if (composePreviews) {
          clear(composePreviews);
          composePreviews.hidden = true;
        }
        clearPendingImage();
        state.trendingFetchedAt = 0;
        await refreshAll();
        toast('Post publicado.');
      } catch (error) {
        reportError(error.message);
      } finally {
        setBusy(button, false);
      }
    });

    var composeContent = byId('post-content');
    if (composeContent) {
      composeContent.addEventListener('input', function () {
        syncComposeTopics();
        scheduleComposeLinkPreviews();
      });
    }

    var clearTopicButton = byId('clear-topic');
    if (clearTopicButton) clearTopicButton.addEventListener('click', clearTopicFilter);

    var trendingList = byId('trending-list');
    if (trendingList) {
      trendingList.addEventListener('click', function (event) {
        var button = event.target.closest('[data-topic]');
        if (button) openTopic(button.dataset.topic);
      });
    }

    var refreshTrendingButton = byId('refresh-trending');
    if (refreshTrendingButton) {
      refreshTrendingButton.addEventListener('click', function () {
        refreshTrending(true);
      });
    }

    byId('post-image').addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      if (file) handleImageSelection(file);
    });

    byId('remove-image').addEventListener('click', function () {
      clearPendingImage();
    });

    byId('profile-form').addEventListener('submit', handleProfileSave);

    byId('profile-image').addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      if (file) handleProfileImageSelection(file);
    });

    byId('remove-profile-image').addEventListener('click', removeProfileImage);

    ['profile-name', 'profile-bio'].forEach(function (id) {
      byId(id).addEventListener('input', function () {
        state.profileDirty = true;
        if (id === 'profile-name') renderProfilePhoto();
      });
    });

    byId('feed-list').addEventListener('click', function (event) {
      runPostAction(event.target.closest('[data-action]'));
    });

    // Clicar no corpo do post abre a página de detalhe. Botões, links,
    // formulários, chips e a área de comentários continuam com suas ações.
    byId('feed-list').addEventListener('click', openPostFromCard);

    byId('feed-list').addEventListener('input', function (event) {
      var input = event.target;
      if (input && input.dataset && input.dataset.draft) {
        state.commentDrafts.set(input.dataset.draft, input.value);
      }
    });

    byId('feed-list').addEventListener('submit', function (event) {
      var form = event.target.closest('.comment-form');
      if (!form) return;
      event.preventDefault();
      handleComment(form, form.dataset.block);
    });

    var detailBox = byId('post-detail');
    if (detailBox) {
      detailBox.addEventListener('click', function (event) {
        runPostAction(event.target.closest('[data-action]'));
      });
      detailBox.addEventListener('input', function (event) {
        var input = event.target;
        if (input && input.dataset && input.dataset.draft) {
          state.commentDrafts.set(input.dataset.draft, input.value);
        }
      });
      detailBox.addEventListener('submit', function (event) {
        var form = event.target.closest('.comment-form');
        if (!form) return;
        event.preventDefault();
        handleComment(form, form.dataset.block);
      });
    }

    var postBack = byId('post-back');
    if (postBack) postBack.addEventListener('click', goBackFromPost);

    byId('profiles-list').addEventListener('click', function (event) {
      var button = event.target.closest('[data-action]');
      if (!button) return;
      var pubkey = button.dataset.pubkey;
      if (!pubkey) return;

      if (button.dataset.action === 'chat') openChat(pubkey);
      if (button.dataset.action === 'follow') handleFollow(button, pubkey);
    });

    function openNotificationFromNode(node) {
      if (!node) return;
      var notification = state.notifications.find(function (candidate) {
        return candidate.id === node.dataset.notification;
      });
      if (notification) {
        openNotification(notification).catch(function (error) {
          reportError(error.message);
        });
      }
    }

    byId('notification-list').addEventListener('click', function (event) {
      var followButton = event.target.closest('[data-action="follow"]');
      if (followButton) {
        event.preventDefault();
        event.stopPropagation();
        var item = followButton.closest('[data-notification]');
        if (item && item.dataset.notification) {
          markNotificationRead(item.dataset.notification).catch(function (error) {
            reportError(error.message);
          });
        }
        handleFollow(followButton, followButton.dataset.pubkey);
        return;
      }
      openNotificationFromNode(event.target.closest('[data-action="open-notification"]'));
    });

    byId('notification-list').addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.target.closest('button, a')) return;
      var node = event.target.closest('[data-action="open-notification"]');
      if (!node) return;
      event.preventDefault();
      openNotificationFromNode(node);
    });

    byId('refresh-notifications').addEventListener('click', function () {
      refreshNotifications().catch(function (error) {
        reportError(error.message);
      });
    });

    byId('mark-notifications-read').addEventListener('click', function () {
      markAllNotificationsRead();
    });
    byId('toggle-read-notifications').addEventListener('click', toggleReadNotifications);

    var profilesSearch = byId('profiles-search');
    if (profilesSearch) {
      profilesSearch.addEventListener('input', function (event) {
        state.profileQuery = event.target.value || '';
        scheduleProfileSearch();
      });

      profilesSearch.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          if (profileSearchTimer) {
            clearTimeout(profileSearchTimer);
            profileSearchTimer = null;
          }
          searchProfilesFromRelay(state.profileQuery.trim()).catch(function (error) {
            reportError(error.message);
          });
        }
        if (event.key === 'Escape') {
          profilesSearch.value = '';
          state.profileQuery = '';
          resetProfileSearch();
          renderProfiles();
        }
      });
    }

    var loadMoreProfiles = byId('load-more-profiles');
    if (loadMoreProfiles) {
      loadMoreProfiles.addEventListener('click', function () {
        searchProfilesFromRelay(state.profileQuery.trim(), { append: true }).catch(function (error) {
          reportError(error.message);
        });
      });
    }

    var loadMorePosts = byId('load-more-posts');
    if (loadMorePosts) {
      loadMorePosts.addEventListener('click', function () {
        loadMoreFeed().catch(function (error) {
          reportError(error.message);
        });
      });
    }

    byId('open-chat-form').addEventListener('submit', function (event) {
      event.preventDefault();
      var value = byId('peer-input').value.trim();
      openChat(value);
    });

    var toggleNewChat = byId('toggle-new-chat');
    if (toggleNewChat) {
      toggleNewChat.addEventListener('click', function () {
        var panel = byId('new-chat-panel');
        setNewChatFormOpen(Boolean(panel && panel.hidden));
      });
    }

    var newChatSearch = byId('new-chat-search');
    if (newChatSearch) {
      newChatSearch.addEventListener('input', function () {
        state.newChatQuery = newChatSearch.value || '';
        renderNewChatContacts();
      });
    }

    var newChatList = byId('new-chat-list');
    if (newChatList) {
      newChatList.addEventListener('click', function (event) {
        var button = event.target.closest('[data-pubkey]');
        if (button) {
          openChat(button.dataset.pubkey).catch(function (error) {
            reportError(error.message);
          });
        }
      });
    }

    var contactSearch = byId('contact-search');
    if (contactSearch) {
      contactSearch.addEventListener('input', function () {
        state.chatQuery = contactSearch.value || '';
        renderContacts();
      });
    }

    var chatBack = byId('chat-back');
    if (chatBack) {
      chatBack.addEventListener('click', function () {
        var layout = byId('direct-layout');
        if (layout) layout.classList.remove('thread-open');
        var firstContact = document.querySelector('#contact-list .contact-button');
        if (firstContact) firstContact.focus();
      });
    }

    byId('contact-list').addEventListener('click', function (event) {
      var button = event.target.closest('[data-pubkey]');
      if (button) openChat(button.dataset.pubkey);
    });

    byId('chat-form').addEventListener('submit', handleSendMessage);

    byId('chat-image').addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      if (file) handleChatImage(file);
    });

    byId('chat-audio').addEventListener('click', function () {
      startAudioRecording();
    });

    byId('delete-chat').addEventListener('click', deleteConversation);

    byId('refresh-chat').addEventListener('click', function () {
      if (!state.peer) return;
      state.chat = new Map();
      state.chatPending = new Set();
      loadConversation(state.peer).catch(function (error) {
        reportError(error.message);
      });
    });

    byId('refresh-feed').addEventListener('click', function () {
      refreshAll();
    });

    var refreshProfilesButton = byId('refresh-profiles');
    if (refreshProfilesButton) {
      refreshProfilesButton.addEventListener('click', function () {
        var term = state.profileQuery.trim();
        if (term) {
          searchProfilesFromRelay(term).catch(function (error) {
            reportError(error.message);
          });
          return;
        }

        Promise.all([refreshProfiles(), refreshSocial()])
          .then(refreshSuggestedProfiles)
          .catch(function (error) {
            reportError(error.message);
          });
      });
    }

    byId('copy-private').addEventListener('click', function () {
      copyText(state.identity.privateKey)
        .then(function () {
          toast('Chave privada copiada. Cuidado.');
        })
        .catch(function () {
          toast('Não foi possível copiar.', true);
        });
    });

    byId('export-identity').addEventListener('click', exportIdentityVault);
    byId('logout-identity').addEventListener('click', logoutIdentity);

    window.addEventListener('onpostt:logout', function () {
      window.location.replace(
        '/login.html?next=' + encodeURIComponent('/')
      );
    });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && state.ready) scheduleRefresh();
    });
  }

  async function reconnectRelays() {
    if (!state.ready) return;
    setNet('warn', 'conectando');
    try {
      await onpostt.connect(relayConnectOptions());
      await refreshAll();
      setNet(onpostt.isConnected ? 'ok' : 'warn', onpostt.isConnected ? 'online' : 'offline');
      window.dispatchEvent(new CustomEvent('onpostt:relays-reconnected'));
      toast('Relays atualizados.');
    } catch (error) {
      setNet('warn', 'offline');
      reportError(error.message);
    }
  }

  function bindLibraryEvents() {
    onpostt.on('open', function (event) {
      if (RELAY && typeof RELAY.setHostStatus === 'function' && event && event.url) {
        RELAY.setHostStatus(event.url, true);
      }
      setNet('ok', 'online');
    });

    onpostt.on('close', function (event) {
      if (RELAY && typeof RELAY.setHostStatus === 'function' && event && event.url) {
        RELAY.setHostStatus(event.url, false);
      }
      if (!onpostt.isConnected) setNet('warn', 'offline');
    });

    onpostt.on('reconnect', function (event) {
      if (RELAY && typeof RELAY.setHostStatus === 'function' && event && event.url) {
        RELAY.setHostStatus(event.url, false);
      }
      setNet('warn', 'reconectando em ' + Math.round(event.delay / 1000) + 's');
    });

    onpostt.on('hello', function () {
      setNet('ok', 'online');
    });

    onpostt.on('error', function (event) {
      var message = event && (event.message || (event.error && event.error.message));
      if (message) reportError(message);
    });

    // A lista de relays mudou (interface): reconecta com os hosts atualizados.
    window.addEventListener('onpostt:relays-changed', function () {
      reconnectRelays();
    });
  }

  async function init() {
    if (!window.onpostt) {
      toast('Biblioteca onpostt não carregou.', true);
      return;
    }
    if (!window.onposttAuth) {
      toast('O módulo de sessão não carregou.', true);
      return;
    }

    try {
      state.identity = await window.onposttAuth.ensureSession();
    } catch (error) {
      toast(error.message, true);
    }

    if (!state.identity) {
      var next = window.location.pathname + window.location.search;
      window.location.replace('/login.html?next=' + encodeURIComponent(next));
      return;
    }

    var notice = window.onposttAuth.consumeNotice();
    if (notice) toast(notice);

    var params = new URLSearchParams(window.location.search);

    // Links antigos para /?view=chat passam a abrir a página dedicada.
    if (!MESSAGES_PAGE && params.get('view') === 'chat') {
      var entryPeer = params.get('peer');
      window.location.replace(
        '/messages.html' + (entryPeer ? '?peer=' + encodeURIComponent(entryPeer) : '')
      );
      return;
    }

    loadHiddenChats();
    updateIdentityUi();
    bindEvents();
    bindLibraryEvents();

    // Esconde o feed/composer antes de qualquer chamada de rede. Sem isso,
    // abrir /?view=profiles (por exemplo, pelo menu de outro perfil) mostra o
    // composer por um instante antes de trocar para a busca.
    if (!MESSAGES_PAGE && !POST_PAGE) {
      var earlyView = params.get('view');
      if (
        ['feed', 'profiles', 'profile-edit', 'settings', 'notifications', 'about'].includes(
          earlyView
        )
      ) {
        switchView(earlyView, { skipRender: true });
      }
    }

    try {
      await onpostt.setReaderKey(state.identity.privateKey);
    } catch (error) {
      reportError('Não foi possível preparar a leitura autenticada: ' + error.message);
    }

    setNet('warn', 'conectando');
    if (RELAY && typeof RELAY.probe === 'function') {
      try {
        await RELAY.probe();
      } catch (error) {
        /* segue com a lista configurada */
      }
    }
    try {
      await onpostt.connect(relayConnectOptions());
    } catch (error) {
      reportError(error.message);
    }

    await refreshAll();
    if (!MESSAGES_PAGE) subscribeLive();
    subscribeInbox();
    state.ready = true;

    if (POST_PAGE) {
      var requestedPost = params.get('post');
      var requestedRepost = params.get('repost');
      await openPostDetailPage(requestedPost || '', requestedRepost || '');
    } else {
      var requestedView = MESSAGES_PAGE ? 'chat' : params.get('view');
      if (
        ['feed', 'profiles', 'profile-edit', 'settings', 'notifications', 'chat', 'about'].includes(
          requestedView
        )
      ) {
        switchView(requestedView);
      }
    }

    // Permite abrir uma conversa direto, por exemplo /messages.html?peer=<pubkey>.
    var requestedPeer = params.get('peer');
    if (!POST_PAGE && requestedPeer && onpostt.isValidPublicKey(requestedPeer)) {
      openChat(requestedPeer).catch(function (error) {
        reportError(error.message);
      });
    }

    var requestedTopic = MESSAGES_PAGE || POST_PAGE ? '' : normalizeTopic(params.get('topic'));
    if (requestedTopic) openTopic(requestedTopic);

    // O username local vira um bloco `profile` inicial se a pubkey ainda não
    // tiver perfil público. Um perfil existente nunca é sobrescrito aqui.
    ensureOwnProfileBlock().catch(function () {
      /* o perfil público inicial é opcional; o formulário continua utilizável */
    });

    document.body.classList.add('app-ready');
    window.dispatchEvent(new CustomEvent('onpostt:app-ready'));
  }

  init();
})();
