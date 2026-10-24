// Loads the repo-root .env (then cwd .env as fallback) before anything reads process.env.
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
dotenv.config({ path: join(ROOT, '.env'), quiet: true });
dotenv.config({ quiet: true });

/** Resolve a repo-relative path (e.g. runs/demo.jsonl) against the repo root. */
export function fromRoot(p: string): string {
  return isAbsolute(p) ? p : join(ROOT, p);
}
