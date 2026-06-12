// Minimal forward-only migration runner. Applies every *.sql file in ./migrations
// in lexicographic order, tracking applied files in a schema_migrations table.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSystemContext } from './pool.js';
import { logger } from '../logger.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, 'migrations');

async function run() {
  await withSystemContext(async (sql) => {
    await sql.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const { rows } = await sql.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
      if (rows.length) {
        logger.info(`skip  ${file} (already applied)`);
        continue;
      }
      const ddl = await readFile(join(migrationsDir, file), 'utf8');
      logger.info(`apply ${file}`);
      await sql.query('BEGIN');
      try {
        await sql.query(ddl);
        await sql.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [file]);
        await sql.query('COMMIT');
      } catch (err) {
        await sql.query('ROLLBACK');
        logger.error({ err }, `migration failed: ${file}`);
        throw err;
      }
    }
  });
  logger.info('migrations complete');
  process.exit(0);
}

run().catch((err) => {
  logger.error({ err }, 'migration runner error');
  process.exit(1);
});
