import { isAbsolute } from 'node:path';

export type StorageConfig = { kind: 'demo' } | { kind: 'postgres'; url: string } | { kind: 'sqlite'; path: string };
export type RuntimeMode = 'demo' | 'persistent';

export function storageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const selected = env.RUBRIST_STORAGE;
  const hasUrl = env.DATABASE_URL !== undefined;
  const hasPath = env.RUBRIST_SQLITE_PATH !== undefined;
  if (hasUrl && !env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL must not be empty');
  if (hasPath && !env.RUBRIST_SQLITE_PATH?.trim()) throw new Error('RUBRIST_SQLITE_PATH must not be empty');
  if (hasUrl && hasPath) throw new Error('Configure exactly one persistent database');
  if (selected !== undefined && !['demo','postgres','sqlite'].includes(selected)) throw new Error('Invalid RUBRIST_STORAGE');
  const kind = selected ?? (hasUrl ? 'postgres' : hasPath ? undefined : env.NODE_ENV === 'production' ? undefined : 'demo');
  if (!kind) throw new Error('Select RUBRIST_STORAGE explicitly for this configuration');
  if (kind === 'demo') {
    if (hasUrl || hasPath) throw new Error('Demo cannot use persistent database settings');
    return { kind };
  }
  if (!env.BETTER_AUTH_SECRET?.trim()) throw new Error('BETTER_AUTH_SECRET is required for persistent storage');
  if (kind === 'postgres') {
    if (!hasUrl || hasPath) throw new Error('PostgreSQL requires DATABASE_URL only');
    let url: URL;
    try { url = new URL(env.DATABASE_URL!); } catch { throw new Error('Invalid DATABASE_URL'); }
    if (!['postgres:','postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must use PostgreSQL');
    return { kind, url: env.DATABASE_URL! };
  }
  if (hasUrl || !hasPath || !isAbsolute(env.RUBRIST_SQLITE_PATH!) || env.RUBRIST_SQLITE_PATH!.includes('\0')) {
    throw new Error('SQLite requires an absolute RUBRIST_SQLITE_PATH and no DATABASE_URL');
  }
  return { kind: 'sqlite', path: env.RUBRIST_SQLITE_PATH! };
}
