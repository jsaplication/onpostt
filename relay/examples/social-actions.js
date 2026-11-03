'use strict';

/**
 * Demonstra as ações sociais do onpostt de ponta a ponta:
 * post, like, reaction, comment, reply, notification, follow, block e delete.
 *
 * Uso:
 *   node examples/social-actions.js [http://localhost:3000]
 *
 * Gera duas identidades efêmeras em memória (Alice e Bob). Nenhuma chave
 * privada é enviada ao relay. No fim, o exemplo desfaz as ações e remove o
 * post para não deixar lixo no banco.
 */

globalThis.elliptic = require('elliptic');

const onpostt = require('../public/onpostt.js');

const host = (process.env.ONPOSTT_HOST || process.argv[2] || 'http://localhost:3000')
  .replace(/\/+$/, '');
const app = process.env.ONPOSTT_APP || 'examples';

const alice = onpostt.generateKeys();
const bob = onpostt.generateKeys();

async function sign(mode, query, content, identity) {
  const block = await onpostt.signBlock(
    {
      mode,
      query,
      ...(content === undefined ? {} : { content }),
      app,
    },
    identity.privateKey
  );

  if (typeof block === 'string') throw new Error(block);
  return block;
}

async function save(label, block) {
  const responses = await onpostt.sendBlock(block);
  const success = responses.find((response) => response.status === 'success');

  if (!success) {
    throw new Error(label + ': ' + JSON.stringify(responses));
  }

  console.log(
    `${label.padEnd(14)} ${String(success.action || 'created').padEnd(8)} ${block.id.slice(0, 12)}…`
  );
  return success;
}

function notificationFor(owner, targetId, interaction, kind, identity) {
  return sign(
    'notification',
    [
      ['to', owner.publicKey],
      ['block', targetId],
      ['interaction', interaction.id],
      ['kind', kind],
    ],
    undefined,
    identity
  );
}

async function main() {
  onpostt.connect({ host: [host] });

  console.log('relay:', host);
  console.log('alice:', alice.publicKey.slice(0, 20) + '…');
  console.log('bob:  ', bob.publicKey.slice(0, 20) + '…');
  console.log('');

  const post = await sign(
    'post',
    [['topic', 'onpostt']],
    'Exemplo de ações sociais — ' + new Date().toISOString(),
    alice
  );
  await save('post', post);

  const like = await sign('like', [['block', post.id]], undefined, bob);
  await save('like', like);

  const likeNotification = await notificationFor(alice, post.id, like, 'like', bob);
  await save('notif like', likeNotification);

  const reaction = await sign(
    'reaction',
    [
      ['block', post.id],
      ['reaction', '🔥'],
    ],
    undefined,
    bob
  );
  await save('reaction', reaction);

  const reactionNotification = await notificationFor(alice, post.id, reaction, 'reaction', bob);
  await save('notif reaction', reactionNotification);

  const comment = await sign(
    'comment',
    [['block', post.id]],
    'Comentário do Bob.',
    bob
  );
  await save('comment', comment);

  const commentNotification = await notificationFor(alice, post.id, comment, 'comment', bob);
  await save('notif comment', commentNotification);

  const reply = await sign(
    'comment',
    [
      ['block', post.id],
      ['parent', comment.id],
    ],
    'Resposta do Bob ao próprio comentário.',
    bob
  );
  await save('reply', reply);

  const follow = await sign(
    'follow',
    [
      ['follower', alice.publicKey],
      ['following', bob.publicKey],
    ],
    undefined,
    alice
  );
  await save('follow', follow);

  // O follow é o próprio alvo e a própria interação da notificação.
  const followNotification = await notificationFor(
    bob,
    follow.id,
    follow,
    'follow',
    alice
  );
  await save('notif follow', followNotification);

  // Bob bloqueia Alice. A lista é pública; a remoção é outro toggle assinado.
  const block = await sign(
    'block',
    [
      ['blocker', bob.publicKey],
      ['blocked', alice.publicKey],
    ],
    undefined,
    bob
  );
  await save('block', block);

  const [likes, reactions, comments, notifications, bobNotifications, blocks] = await Promise.all([
    onpostt.list({ mode: 'like', app, query: [['block', post.id]], limit: 100 }),
    onpostt.list({ mode: 'reaction', app, query: [['block', post.id]], limit: 100 }),
    onpostt.list({ mode: 'comment', app, query: [['block', post.id]], limit: 100 }),
    onpostt.list({ mode: 'notification', app, query: [['to', alice.publicKey]], limit: 100 }),
    onpostt.list({ mode: 'notification', app, query: [['to', bob.publicKey]], limit: 100 }),
    onpostt.list({
      mode: 'block',
      app,
      query: [['blocker', bob.publicKey], ['blocked', alice.publicKey]],
      limit: 100,
    }),
  ]);

  console.log('');
  console.log('curtidas: ', likes.length);
  console.log('reações:  ', reactions.length);
  console.log('comentários (inclui resposta):', comments.length);
  console.log('notificações da Alice:', notifications.length);
  console.log('notificações do Bob:', bobNotifications.length);
  console.log('bloqueios Bob→Alice:', blocks.length);

  // Remove as notificações antes de desfazer as interações que elas referenciam.
  await save(
    'delete notif like',
    await sign('delete', [['block', likeNotification.id]], undefined, bob)
  );
  await save(
    'delete notif reaction',
    await sign('delete', [['block', reactionNotification.id]], undefined, bob)
  );
  await save(
    'delete notif comment',
    await sign('delete', [['block', commentNotification.id]], undefined, bob)
  );
  await save(
    'delete notif follow',
    await sign('delete', [['block', followNotification.id]], undefined, alice)
  );

  // Desfaz os toggles.
  await save('unblock', await sign('block', block.query, undefined, bob));
  await save('unfollow', await sign('follow', follow.query, undefined, alice));
  await save('unlike', await sign('like', like.query, undefined, bob));
  await save('unreact', await sign('reaction', reaction.query, undefined, bob));

  // Remove resposta, comentário e post (somente o autor pode excluir).
  await save('delete reply', await sign('delete', [['block', reply.id]], undefined, bob));
  await save('delete comment', await sign('delete', [['block', comment.id]], undefined, bob));
  await save('delete post', await sign('delete', [['block', post.id]], undefined, alice));
}

main().catch((error) => {
  console.error('falhou:', error.message);
  process.exitCode = 1;
});
