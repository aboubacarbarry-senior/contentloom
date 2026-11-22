import { Pool } from 'pg';
import { loadConfig } from './config';
import { migrate, pending } from './migrate';

/** `npm run migrate` (apply) or `npm run migrate -- --dry-run` (list what would run). */
async function main() {
  const cfg = loadConfig();
  if (!cfg.databaseUrl) {
    console.error('DATABASE_URL is not set; nothing to migrate.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: cfg.databaseUrl, max: 1 });
  try {
    if (process.argv.includes('--dry-run')) {
      const todo = await pending(pool);
      console.log(todo.length ? `would apply:\n  ${todo.join('\n  ')}` : 'database is up to date');
      return;
    }
    const r = await migrate(pool, undefined, (m) => console.log(m));
    console.log(r.applied.length ? `applied ${r.applied.length} migration(s)` : 'database is up to date');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
