/** Operator guidance from allowlisted error codes; never echo SQL, paths or credentials. */
export function sqliteDiagnostic(error: unknown): string {
  const value = error as {code?: unknown; errcode?: unknown; message?: unknown} | null;
  const code = typeof value?.errcode === 'number' ? value.errcode & 0xff : undefined;
  if (typeof value?.message==='string' && /existing database directory|persistent mounted local volume/.test(value.message)) return 'SQLite requires an existing directory on a persistent local volume. Check the mounted database directory; no ephemeral fallback is allowed.';
  if (code === 13 || value?.code === 'ENOSPC') return 'SQLite storage is full. Free space on the database volume and retry; preserve the database and WAL files.';
  if (code === 5 || code === 6) return 'SQLite storage is busy. Ensure only one Rubrist API instance uses this local volume; retry after the competing operation completes.';
  if ([3,8,14].includes(code ?? -1) || ['EACCES','EPERM','EROFS','ENOENT'].includes(String(value?.code))) return 'SQLite storage cannot be opened for writing. Check the database directory, volume mount, ownership and permissions.';
  if (code === 10) return 'SQLite storage I/O failed. Check the local volume and available space; preserve the database and WAL files.';
  if (code === 11 || code === 26) return 'SQLite storage is invalid or corrupt. Preserve the files and restore a verified backup into a new path.';
  if (typeof value?.message === 'string' && /migration|Unrecognized SQLite|foreign-key integrity|temporary objects/.test(value.message)) return 'SQLite schema is incompatible or a migration failed. Use the matching application version; preserve this database and restore a backup for rollback.';
  return 'SQLite startup failed. Check the selected database path, local volume and application configuration. Persistent storage will not fall back to demo mode.';
}
