import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
const read=path=>JSON.parse(readFileSync(new URL(path,root),'utf8'));
test('every frozen PostgreSQL invariant has a unique current SQLite implementation and evidence mapping',()=>{
 const inventory=read('docs/sqlite/invariant-inventory.json'),map=read('docs/sqlite/invariant-port-map.json');
 const symbols=new Map([...inventory.functions,...inventory.triggers].map(s=>[s.validation.id,s]));
 assert.equal(map.format,'rubrist-sqlite-invariant-port-map/v1');assert.equal(map.entries.length,symbols.size);
 const seen=new Set();
 for(const entry of map.entries){
  assert.ok(!seen.has(entry.inventoryId),entry.inventoryId);seen.add(entry.inventoryId);
  const source=symbols.get(entry.inventoryId);assert.ok(source,entry.inventoryId);
  assert.equal(entry.sourceSha256,source.sha256,entry.inventoryId);
  assert.equal(entry.superseded===true,source.effective===false,entry.inventoryId);
  assert.ok(map.groups[entry.group],entry.group);
 }
 assert.deepEqual([...seen].sort(),[...symbols.keys()].sort());
 for(const [name,group] of Object.entries(map.groups)){
  assert.ok(group.boundary.length>40,name);
  for(const field of ['sqliteMigrations','implementation','tests']){
   assert.ok(group[field].length>0,`${name}:${field}`);
   for(const path of group[field]){assert.ok(!path.includes('..')&&!path.startsWith('/'),path);assert.ok(existsSync(fileURLToPath(new URL(path,root))),`${name}:${path}`);}
  }
 }
});
