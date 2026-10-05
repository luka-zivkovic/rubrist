import { readFileSync, readdirSync } from 'node:fs';
import { digest } from './database.mjs';

const root = new URL('../../', import.meta.url);
const defaultMigrationDir = new URL('packages/db/migrations/', root);
const strategies = {
  finalization: 'Mandatory reciprocal deferred foreign key to an immutable finalization row; immediate finalizer checks the complete joined bundle; later child changes rejected. Mutable event-head rules also need a per-command validation obligation, not a one-time finalizer.',
  immutability: 'Immediate UPDATE/DELETE triggers; retain exact permitted project/user erasure exceptions and production deletion audit obligations; recursive triggers ON closes REPLACE bypass.',
  transaction: 'BEGIN IMMEDIATE with private per-command token/time functions; triggers validate context and previously committed evidence; no caller-supplied xmin, snapshot or session setting.',
  locking: 'Short BEGIN IMMEDIATE transaction serializes database mutations; durable fenced ownership replaces session locks across external calls; recheck eligibility in the write transaction.',
  digest: 'Port exact canonicalization to deterministic connection-registered SQL functions called from constraints/triggers; joined aggregates assembled with explicit contract ordering. Missing functions fail closed.',
  mutation: 'Port side effect into an immediate trigger in the caller transaction; enforce project/identity scope and append-only history with the same rollback boundary.',
  guard: 'Immediate SQLite triggers with RAISE(ABORT), explicit NULL handling, strict columns, composite tenant foreign keys and unique indexes; port every predicate, not just its error message.',
  query: 'Backend-specific SQL query/view preserving selection, null semantics, ordering and exact integer handling; if consumed by a guard, run the equivalent query inside that database trigger.'
};
function strategy(name, sql, deferred) {
  const kinds = [];
  if (deferred.has(name)) kinds.push('finalization');
  if (/append_only|immutable|preserve_skill/.test(name)) kinds.push('immutability');
  if (/current_setting|set_config|pg_current_snapshot|pg_current_xact_id|\.xmin\b/.test(sql)) kinds.push('transaction');
  if (/pg_advisory|for update/i.test(sql)) kinds.push('locking');
  if (/digest|canonical|sort_key|timestamp|bounded_text|nonempty_text|payload_v1_is_safe/.test(name) && !/^guard/.test(name)) kinds.push('digest');
  if (/^append_|^claim_|clear_deadline/.test(name)) kinds.push('mutation');
  if (/RETURNS trigger/i.test(sql) || /^guard_|^ensure_/.test(name)) kinds.push('guard');
  return kinds.length ? kinds : ['query'];
}
export function inventory({ migrationDir = defaultMigrationDir } = {}) {
  const migrations = readdirSync(migrationDir).filter(f => f.endsWith('.sql')).sort().map(file => {
    const sql = readFileSync(new URL(file, migrationDir), 'utf8');
    return { file, sql, sha256: digest(Buffer.from(sql)) };
  });
  const triggers = [];
  const definitions = [];
  for (const {file, sql} of migrations) {
    for (const match of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w]+)\s*\([\s\S]*?\bAS\s+(\$\w*\$)[\s\S]*?\2\s*;/gi)) {
      definitions.push({ name: match[1], sql: match[0], file, line: sql.slice(0, match.index).split('\n').length });
    }
    const triggerStart = triggers.length;
    for (const match of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?(CONSTRAINT\s+)?TRIGGER\s+(\w+)\s+([\s\S]*?);/gi)) {
      const fn = match[3].match(/EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(\w+)/i)?.[1];
      const table = match[3].match(/\bON\s+(\w+)/i)?.[1];
      if (!fn || !table) throw new Error(`Unparsed trigger ${match[2]}`);
      triggers.push({ name: match[2], table, function: fn, deferred: /INITIALLY DEFERRED/i.test(match[3]),
        source: `packages/db/migrations/${file}:${sql.slice(0,match.index).split('\n').length}`, sha256: digest(Buffer.from(match[0])) });
    }
    const expectedTriggers = [...sql.matchAll(/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b/gi)].length;
    if (triggers.length - triggerStart !== expectedTriggers) throw new Error(`Unparsed triggers in ${file}`);
    const expected = [...sql.matchAll(/\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/gi)].length;
    if (definitions.filter(d => d.file === file).length !== expected) throw new Error(`Unparsed functions in ${file}`);
  }
  const deferred = new Set(triggers.filter(t => t.deferred).map(t => t.function));
  const names = new Set(definitions.map(d => d.name));
  const functions = definitions.map((entry, index) => {
    const kinds = strategy(entry.name, entry.sql, deferred);
    const rejections = [...entry.sql.matchAll(/raise\s+exception\s+'((?:''|[^'])*)'/gi)].map(m => m[1].replaceAll("''", "'"));
    const subject = entry.name.replace(/^(guard|ensure|append|claim)_/, '').replace(/_v1$/, '').replaceAll('_', ' ');
    const testId = `sqlite:${entry.name}:${entry.file.replace('.sql','')}`;
    return {
      name: entry.name, source: `packages/db/migrations/${entry.file}:${entry.line}`,
      sha256: digest(Buffer.from(entry.sql)),
      effective: !definitions.slice(index+1).some(d => d.name === entry.name),
      businessPurpose: rejections.length ? `Enforce ${subject}: ${rejections.join('; ')}` : `${kinds.includes('digest') ? 'Compute or validate the exact representation for' : kinds.includes('query') ? 'Derive the scoped database projection for' : 'Maintain'} ${subject}.`,
      rejectionPredicates: rejections,
      dependencies: [...names].filter(n => n !== entry.name && new RegExp(`\\b${n}\\s*\\(`).test(entry.sql)).sort(),
      sqliteStrategies: kinds,
      validation: { id: testId, status: 'planned-domain-port',
        positive: `Exercise ${entry.name} with a valid scoped fixture and compare its PostgreSQL result or persisted effect.`,
        negative: rejections.length ? rejections.map((reason, i) => ({ id: `${testId}:reject-${i+1}`, reason, test: 'Violate each underlying predicate independently through direct SQL; assert rejection and full rollback.' })) : [
          { id: `${testId}:boundary`, test: kinds.includes('immutability') ? 'Reject update/delete/replacement while parent exists; permit only the documented erasure/anonymization exceptions.' : 'Compare null, empty, cross-project, Unicode, integer-boundary, historical and malformed inputs with PostgreSQL golden fixtures.' }
        ],
        concurrency: kinds.some(k => ['finalization','locking','mutation','transaction'].includes(k)) ? 'Overlap independent connections; inject abort/restart at the mutation boundary; assert no partial evidence, branch or stale ownership.' : null
      }
    };
  });
  for (const t of triggers) {
    const fn = functions.findLast(f => f.name === t.function);
    if (!fn) throw new Error(`Missing function for ${t.name}`);
    t.businessPurpose = `Apply ${t.function} to ${t.table} at the declared SQL event/timing boundary.`;
    t.sqliteStrategies = fn.sqliteStrategies;
    t.validation = { id: `sqlite:trigger:${t.table}:${t.name}`, functionTest: fn.validation.id,
      status: 'planned-domain-port', test: 'Exercise every declared INSERT/UPDATE/DELETE event directly on this table; shared function coverage alone is insufficient.' };
  }
  return { format: 'rubrist-sqlite-invariant-inventory/v1', status: 'CURRENT PostgreSQL source inventory; ASSUMPTION SQLite strategies; domain tests remain planned',
    baseline: '8cabae2ac7a4c70e5812cd85b35b5cfc7c678311',
    counts: { tables: migrations.reduce((n,m) => n + [...m.sql.matchAll(/^CREATE TABLE\b/gim)].length,0), functionDefinitions: functions.length, distinctFunctions: names.size, triggers: triggers.length, deferredTriggers: triggers.filter(t => t.deferred).length },
    migrations: migrations.map(({file,sha256}) => ({file,sha256})), strategies, functions, triggers };
}
