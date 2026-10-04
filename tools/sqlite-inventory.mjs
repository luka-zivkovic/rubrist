import { readFileSync, writeFileSync } from 'node:fs';
import { inventory } from './sqlite-prototype/inventory.mjs';
const path = new URL('../docs/sqlite/invariant-inventory.json', import.meta.url);
const result = inventory();
const expected = JSON.stringify(result, null, 2) + '\n';
if (process.argv.includes('--write')) writeFileSync(path, expected);
else if (readFileSync(path, 'utf8') !== expected) throw new Error('SQLite inventory drift: regenerate with node tools/sqlite-inventory.mjs --write and review the strategies.');
console.log(JSON.stringify(result.counts));
