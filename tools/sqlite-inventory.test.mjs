import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inventory } from './sqlite-prototype/inventory.mjs';

test('PostgreSQL invariant inventory covers every definition and trigger without migration drift', () => {
  const expected = JSON.parse(readFileSync(new URL('../docs/sqlite/invariant-inventory.json', import.meta.url), 'utf8'));
  assert.deepEqual(inventory(), expected);
  assert.deepEqual(expected.counts, { tables: 105, functionDefinitions: 206, distinctFunctions: 205, triggers: 182, deferredTriggers: 19 });
  assert.equal(expected.functions.filter(f => f.effective).length, 205);
  const testIds = [...expected.functions, ...expected.triggers].map(f => f.validation.id);
  assert.equal(new Set(testIds).size, testIds.length);
});
