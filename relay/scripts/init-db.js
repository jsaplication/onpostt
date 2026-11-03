'use strict';

/**
 * Aplica `database/schema.sql` no banco configurado.
 *
 * Uso:
 *   npm run db:init
 *
 * O script é idempotente e não apaga dados.
 */

const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/db');
const config = require('../src/config');

async function main() {
  const schemaPath = path.join(config.rootDir, 'database', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  process.stdout.write(`[db:init] aplicando ${schemaPath}\n`);
  await db.query(sql);
  const target = config.db.connectionString
    ? 'DATABASE_URL'
    : `${config.db.host}:${config.db.port}/${config.db.database}`;
  process.stdout.write(`[db:init] schema aplicado com sucesso em ${target}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`[db:init] falhou: ${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await db.close();
    } catch {
      /* ignore */
    }
  });
