'use strict';

/**
 * Visibilidade de conteúdo em tempo real.
 *
 * Consultas iniciais já são filtradas no SQL (`buildBlocksQuery`). Esta camada
 * cobre os blocos transmitidos ao vivo: antes de entregar um evento, o relay
 * confere a relação de bloqueio atual no banco. Blocos do modo `block` são
 * sempre entregues, pois são metadados usados pela interface para detectar o
 * bloqueio.
 */

const db = require('./db');
const { isValidPublicKey } = require('./crypto');

const BLOCKED_QUERY_VALUE =
  `lower(jsonb_path_query_first(rel.query, 'strict $[*] ? (@[0] == "blocked")') ->> 1)`;

function queryValue(block, key) {
  if (!Array.isArray(block?.query)) return undefined;
  const found = block.query.find((pair) => Array.isArray(pair) && pair[0] === key);
  return found ? found[1] : undefined;
}

/**
 * Pubkeys cujo conteúdo precisa ser comparado com a relação de bloqueio.
 * Em mensagens, as duas pontas contam (o remetente e o destinatário).
 */
function participantKeys(block) {
  if (!block || block.mode === 'block') return [];

  if (block.mode === 'message') {
    return Array.from(
      new Set(
        [queryValue(block, 'from'), queryValue(block, 'to')]
          .filter((key) => isValidPublicKey(key))
          .map((key) => key.toLowerCase())
      )
    );
  }

  return isValidPublicKey(block.pubkey) ? [block.pubkey.toLowerCase()] : [];
}

/**
 * Retorna `true` se o bloco pode ser entregue ao leitor.
 *
 * - leitor autenticado: esconde conteúdo de qualquer relação de bloqueio
 *   entre leitor e autor (nas duas direções);
 * - leitor anônimo: esconde conteúdo de autores que participam de qualquer
 *   bloqueio ativo, evitando bypass por omissão do token;
 * - modo `block`: sempre visível para a interface detectar o estado.
 *
 * Em caso de erro de banco, o chamador deve tratar como invisível (fail
 * closed) para não vazar conteúdo.
 *
 * @param {object} block
 * @param {string | null | undefined} viewer
 * @returns {Promise<boolean>}
 */
async function isVisibleTo(block, viewer) {
  if (!block || block.mode === 'block') return true;

  const keys = participantKeys(block);
  if (keys.length === 0) return true;

  if (viewer) {
    const viewerKey = String(viewer).toLowerCase();
    if (!isValidPublicKey(viewerKey)) return false;

    const result = await db.query(
      `SELECT 1
       FROM blocks rel
       WHERE rel.mode = 'block'
         AND (
           (lower(rel.pubkey) = lower($1) AND ${BLOCKED_QUERY_VALUE} = ANY($2::text[]))
           OR
           (${BLOCKED_QUERY_VALUE} = lower($1) AND lower(rel.pubkey) = ANY($2::text[]))
         )
       LIMIT 1`,
      [viewerKey, keys]
    );
    return result.rowCount === 0;
  }

  const result = await db.query(
    `SELECT 1
     FROM blocks rel
     WHERE rel.mode = 'block'
       AND (
         lower(rel.pubkey) = ANY($1::text[])
         OR ${BLOCKED_QUERY_VALUE} = ANY($1::text[])
       )
     LIMIT 1`,
    [keys]
  );
  return result.rowCount === 0;
}

module.exports = {
  participantKeys,
  isVisibleTo,
};
