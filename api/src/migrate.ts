import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';

/**
 * Forward-only SQL migrations from api/migrations, applied in file-name order. Each file runs in its own
 * transaction under an advisory lock, so two deploys starting at once don't race. A checksum per file
 * catches migrations edited after they were applied.
 */
export interface Migration {
  version: string;
  file: string;
  sql: string;
  checksum: string;
}

export const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');
const LOCK_KEY = 0x636c6f6d; // "clom"

export function checksum(sql: string): string {
  // Line endings differ between Windows checkouts and CI; they must not change the checksum.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n').trim()).digest('hex');
}

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  const seen = new Set<string>();
  return files.map((file) => {
    const version = file.slice(0, 3);
    if (seen.has(version)) throw new Error(`two migrations share version ${version}`);
    seen.add(version);
    const sql = readFileSync(join(dir, file), 'utf8');
    return { version, file, sql, checksum: checksum(sql) };
  });
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(pool: Pool, migrations = loadMigrations(), log: (msg: string) => void = () => undefined): Promise<MigrationResult> {
  const c = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await c.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    await c.query(`create table if not exists schema_migrations (
      version text primary key,
      file text not null,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`);
    const done = new Map<string, { file: string; checksum: string }>(
      (await c.query('select version, file, checksum from schema_migrations')).rows.map((r) => [r.version, { file: r.file, checksum: r.checksum }]),
    );
    for (const m of migrations) {
      const prev = done.get(m.version);
      if (prev) {
        if (prev.checksum !== m.checksum) {
          throw new Error(`migration ${m.file} was changed after it was applied (expected checksum ${prev.checksum.slice(0, 12)}…); add a new migration instead`);
        }
        skipped.push(m.file);
        continue;
      }
      log(`applying ${m.file}`);
      try {
        await c.query('begin');
        await c.query(m.sql);
        await c.query('insert into schema_migrations (version, file, checksum) values ($1, $2, $3)', [m.version, m.file, m.checksum]);
        await c.query('commit');
      } catch (e) {
        await c.query('rollback').catch(() => undefined);
        throw new Error(`migration ${m.file} failed: ${(e as Error).message}`);
      }
      applied.push(m.file);
    }
    return { applied, skipped };
  } finally {
    await c.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    c.release();
  }
}

/** Versions that exist on disk but not in the database: what `migrate` would apply. */
export async function pending(pool: Pool, migrations = loadMigrations()): Promise<string[]> {
  const exists = await pool.query(`select to_regclass('public.schema_migrations') as t`);
  if (!exists.rows[0].t) return migrations.map((m) => m.file);
  const done = new Set((await pool.query('select version from schema_migrations')).rows.map((r) => r.version as string));
  return migrations.filter((m) => !done.has(m.version)).map((m) => m.file);
}
