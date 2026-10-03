import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import { getDbs } from '../db.ts';
import type { Log } from '../setup.ts';

// Refresh the shadow from the target with pg_dump | psql. For real databases, point SHADOW_URL at a
// restored backup or a branch instead; this is the simple path for small/dev databases.

function findBinary(name: string): string {
  const dirs = [process.env.PGBIN, '/opt/homebrew/opt/postgresql@17/bin', '/usr/local/opt/postgresql@17/bin', '/usr/lib/postgresql/17/bin'];
  for (const d of dirs) if (d && existsSync(join(d, name))) return join(d, name);
  return name; // rely on PATH
}

export async function syncShadow(opts: { schemaOnly: boolean }, log: Log = console.log): Promise<void> {
  if (!config.shadowUrl) throw new Error('SHADOW_URL is not set');
  const dumpArgs = ['--no-owner', '--no-privileges', '--clean', '--if-exists', ...(opts.schemaOnly ? ['--schema-only'] : []), config.targetUrl];
  const dump = spawn(findBinary('pg_dump'), dumpArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  const restore = spawn(findBinary('psql'), ['-q', '-v', 'ON_ERROR_STOP=1', config.shadowUrl], { stdio: ['pipe', 'ignore', 'pipe'] });
  dump.stdout.pipe(restore.stdin);
  let errors = '';
  dump.stderr.on('data', (d) => (errors += d));
  restore.stderr.on('data', (d) => (errors += d));
  const done = (p: ReturnType<typeof spawn>, name: string) =>
    new Promise<void>((resolve, reject) => {
      p.on('error', (e) => reject(new Error(`${name}: ${e.message}`)));
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${name} exited with ${code}: ${errors.trim().slice(-800)}`))));
    });
  const started = Date.now();
  await Promise.all([done(dump, 'pg_dump'), done(restore, 'psql')]);
  await getDbs().shadow!.query('ANALYZE');
  log(`shadow refreshed from target (${opts.schemaOnly ? 'schema only' : 'schema + data'}) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
