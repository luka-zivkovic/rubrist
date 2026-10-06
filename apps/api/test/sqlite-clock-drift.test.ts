import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateSqlite, openSqlite } from '@rubrist/db/sqlite';
import { COMMAND_CLOCK_DRIFT_TOLERANCE_MS, createCommandClockDriftMonitor } from '../src/storage/sqlite/clock-drift.js';
import { sqliteCommand } from '../src/storage/sqlite/command-context.js';
import { createSqliteRuntime } from '../src/storage/sqlite/runtime.js';
import { createReadiness } from '../src/storage/readiness.js';
import { createApp } from '../src/app.js';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const HOUR = 3_600_000;

it('stays silent within the documented tolerance and warns once per drift episode', () => {
  const log = vi.fn<(message: string) => void>();
  const monitor = createCommandClockDriftMonitor(log);
  for (const healthy of [-5, 0, 1, COMMAND_CLOCK_DRIFT_TOLERANCE_MS - 1, COMMAND_CLOCK_DRIFT_TOLERANCE_MS, undefined, Number.NaN, '9e9'])
    monitor.observe(healthy);
  expect(COMMAND_CLOCK_DRIFT_TOLERANCE_MS).toBe(60_000);
  expect(log).not.toHaveBeenCalled();
  for (const ahead of [HOUR, HOUR - 10_000, 2 * HOUR, 30_000, 1]) monitor.observe(ahead);
  expect(log).toHaveBeenCalledTimes(1);
  const warning = log.mock.calls[0]![0];
  expect(warning).toMatch(/^rubrist\.storage\.clock: .*about 3600 s ahead of host time \(diagnostic tolerance 60 s\)/);
  expect(warning).toMatch(/host time synchronization and pause writes; do not edit the database/);
  expect(warning).not.toMatch(/\/|sqlite:|secret|BETTER_AUTH/i);
  monitor.observe(0);
  expect(log).toHaveBeenCalledTimes(2);
  expect(log.mock.calls[1]![0]).toBe('rubrist.storage.clock: host time has caught up with the persisted SQLite command clock.');
  monitor.observe(-1);monitor.observe(2 * HOUR);monitor.observe(2 * HOUR);
  expect(log).toHaveBeenCalledTimes(3);
});

async function runtimeAt(offsetMs: number) {
  vi.stubEnv('BETTER_AUTH_SECRET', 'synthetic-clock-drift-secret-not-for-deployment');
  const root = mkdtempSync(join(tmpdir(), 'rubrist-clock-'));
  const path = join(root, 'db.sqlite');
  const db = openSqlite(path);
  let persisted = 0;
  try {
    migrateSqlite(db);
    if (offsetMs) persisted = sqliteCommand(db, context => context.milliseconds, () => Date.now() + offsetMs);
  } finally { db.close(); }
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const runtime = await createSqliteRuntime(path, undefined, { seedStarterEvaluators: false });
  return { root, path, persisted, warn, runtime };
}

it('warns once at startup for a future persisted clock while startup and readiness still succeed and nothing rewinds', async () => {
  const { root, path, persisted, warn, runtime } = await runtimeAt(HOUR);
  try {
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/^rubrist\.storage\.clock: .* s ahead of host time/);
    expect(warn.mock.calls[0]![0]).not.toContain(root);
    const readiness = createReadiness(async () => { await runtime.storage.probe(); return true; });
    const app = createApp(runtime.repository, { accounts: runtime.accounts, auth: runtime.auth, runtimeMode: 'persistent', readiness: readiness.check });
    for (let i = 0; i < 3; i++) expect((await app.request('/ready')).status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
  } finally { await runtime.close(); }
  const db = openSqlite(path);
  try {
    // Every probe kept the latched time; detection never caps or rewinds it.
    expect(Number(db.prepare('SELECT last_ms FROM rubrist_command_clock WHERE singleton=1').get()?.last_ms)).toBe(persisted);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

it('does not warn for a healthy clock at startup or during repeated readiness probes', async () => {
  const { root, warn, runtime } = await runtimeAt(0);
  try {
    for (let i = 0; i < 3; i++) await runtime.storage.probe();
    expect(warn).not.toHaveBeenCalled();
  } finally { await runtime.close(); rmSync(root, { recursive: true, force: true }); }
});
