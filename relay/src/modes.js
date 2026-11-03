'use strict';

/**
 * Modos suportados pelo relay.
 *
 * - transport: transporte preferencial usado pela biblioteca oficial.
 * - query: regras da query declarativa.
 *   - free: qualquer par válido é aceito.
 *   - required: chaves obrigatórias.
 *   - optional: chaves aceitas além das obrigatórias.
 * - contentRequired: se o conteúdo é obrigatório para o modo.
 * - appRequired: se o identificador da aplicação é obrigatório.
 * - public: o conteúdo pode ser lido por qualquer cliente. Mensagens são
 *   cifradas de ponta a ponta, então o relay só vê o envelope.
 */
const queryRule = (free, required = [], optional = []) =>
  Object.freeze({
    free,
    required: Object.freeze(required),
    optional: Object.freeze(optional),
  });

const NOTIFICATION_KINDS = Object.freeze(['like', 'reaction', 'comment', 'repost', 'follow']);

const MODES = Object.freeze({
  post: Object.freeze({
    name: 'post',
    description: 'Publicação pública',
    transport: 'http',
    query: queryRule(true),
    contentRequired: true,
    appRequired: true,
    public: true,
  }),
  follow: Object.freeze({
    name: 'follow',
    description: 'Relação seguir/deixar de seguir (toggle)',
    transport: 'http',
    query: queryRule(false, ['follower', 'following']),
    contentRequired: false,
    appRequired: true,
    public: true,
  }),
  block: Object.freeze({
    name: 'block',
    description: 'Bloqueio/desbloqueio de um usuário (toggle; filtra leitura e mensagens)',
    transport: 'http',
    query: queryRule(false, ['blocker', 'blocked']),
    contentRequired: false,
    appRequired: true,
    public: true,
  }),
  message: Object.freeze({
    name: 'message',
    description: 'Mensagem direta cifrada (E2E)',
    transport: 'websocket',
    query: queryRule(false, ['from', 'to']),
    contentRequired: true,
    appRequired: true,
    public: false,
  }),
  message_read: Object.freeze({
    name: 'message_read',
    description: 'Confirmação de leitura de mensagens (por pubkey)',
    transport: 'http',
    query: queryRule(false, []),
    contentRequired: true,
    appRequired: true,
    public: false,
  }),
  like: Object.freeze({
    name: 'like',
    description: 'Curtida/descurtida (toggle)',
    transport: 'http',
    query: queryRule(false, ['block']),
    contentRequired: false,
    appRequired: true,
    public: true,
  }),
  reaction: Object.freeze({
    name: 'reaction',
    description: 'Reação com emoji em um bloco (toggle)',
    transport: 'http',
    query: queryRule(false, ['block', 'reaction']),
    contentRequired: false,
    appRequired: true,
    public: true,
  }),
  comment: Object.freeze({
    name: 'comment',
    description: 'Comentário ou resposta em um bloco',
    transport: 'http',
    query: queryRule(false, ['block'], ['parent']),
    contentRequired: true,
    appRequired: true,
    public: true,
  }),
  repost: Object.freeze({
    name: 'repost',
    description: 'Repost de um bloco (toggle)',
    transport: 'http',
    query: queryRule(false, ['block']),
    contentRequired: false,
    appRequired: true,
    public: true,
  }),
  profile: Object.freeze({
    name: 'profile',
    description: 'Perfil público (último por pubkey)',
    transport: 'http',
    query: queryRule(true),
    contentRequired: true,
    appRequired: true,
    public: true,
  }),
  notification: Object.freeze({
    name: 'notification',
    description: 'Notificação de interação em um bloco',
    transport: 'http',
    query: queryRule(false, ['to', 'block', 'interaction', 'kind']),
    contentRequired: false,
    appRequired: true,
    public: true,
  }),
  notification_read: Object.freeze({
    name: 'notification_read',
    description: 'Confirmação de leitura de notificações (por pubkey)',
    transport: 'http',
    query: queryRule(false, []),
    contentRequired: true,
    appRequired: true,
    public: true,
  }),
  delete: Object.freeze({
    name: 'delete',
    description: 'Tombstone de exclusão',
    transport: 'http',
    query: queryRule(false, ['block']),
    contentRequired: false,
    appRequired: false,
    public: true,
  }),
});

const list = Object.freeze(Object.keys(MODES));

function isValidMode(mode) {
  return typeof mode === 'string' && Object.prototype.hasOwnProperty.call(MODES, mode);
}

function getMode(mode) {
  return isValidMode(mode) ? MODES[mode] : null;
}

/**
 * Formato público (seguro) para a página de status e para /api/status.
 */
function publicModes() {
  return list.map((name) => {
    const mode = MODES[name];
    return {
      name,
      description: mode.description,
      transport: mode.transport,
      query: {
        free: mode.query.free,
        required: [...mode.query.required],
        optional: [...mode.query.optional],
      },
      contentRequired: mode.contentRequired,
      appRequired: mode.appRequired,
      public: mode.public,
    };
  });
}

module.exports = {
  MODES,
  NOTIFICATION_KINDS,
  list,
  isValidMode,
  getMode,
  publicModes,
};
