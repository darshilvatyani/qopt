import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Content-addressed disk cache for LLM calls. Re-running the eval costs nothing and returns the
// same answers, which makes results reproducible and keeps free-tier rate limits out of the way.

export class DiskCache {
  constructor(private readonly dir: string) {}

  key(parts: unknown): string {
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(join(this.dir, `${key}.json`), 'utf8')) as T;
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${key}.json`), JSON.stringify(value));
  }
}
