import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { inventory } from './sqlite-prototype/inventory.mjs';

test('PostgreSQL invariant inventory covers every definition and trigger without migration drift', () => {
  const expected = JSON.parse(readFileSync(new URL('../docs/sqlite/invariant-inventory.json', import.meta.url), 'utf8'));
  assert.deepEqual(inventory(), expected);
  assert.deepEqual(expected.counts, { tables: 105, functionDefinitions: 206, distinctFunctions: 205, triggers: 182, deferredTriggers: 19 });
  assert.equal(expected.functions.filter(f => f.effective).length, 205);
  const testIds = [...expected.functions, ...expected.triggers].map(f => f.validation.id);
  assert.equal(new Set(testIds).size, testIds.length);
});


test('inventory parses replacement triggers and rejects source declarations it cannot inventory', t => {
  const dir = mkdtempSync(`${tmpdir()}/rubrist-inventory-parser-`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const migrationDir = pathToFileURL(`${dir}/`);
  const fn = 'CREATE FUNCTION guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;\n';
  for (const qualifier of ['', 'OR REPLACE ', 'CONSTRAINT ']) {
    writeFileSync(`${dir}/0001_test.sql`, `${fn}CREATE ${qualifier}TRIGGER valid AFTER INSERT ON examples FOR EACH ROW EXECUTE FUNCTION guard();`);
    assert.equal(inventory({ migrationDir }).counts.triggers, 1);
  }
  // Quoted trigger names are outside this parser's supported source syntax.
  // Their declaration must fail inventory generation instead of disappearing.
  writeFileSync(`${dir}/0001_test.sql`, `${fn}  CREATE OR REPLACE TRIGGER "missed" AFTER INSERT ON examples FOR EACH ROW EXECUTE FUNCTION guard();`);
  assert.throws(() => inventory({ migrationDir }), /Unparsed triggers in 0001_test.sql/);
  writeFileSync(`${dir}/0001_test.sql`, `${fn.trim()} CREATE TRIGGER "missed" AFTER INSERT ON examples FOR EACH ROW EXECUTE FUNCTION guard();`);
  assert.throws(() => inventory({ migrationDir }), /Unparsed triggers in 0001_test.sql/);
});
