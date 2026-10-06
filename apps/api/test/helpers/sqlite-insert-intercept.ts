import {vi} from 'vitest';
import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
/** Change only the raw row submitted by an otherwise valid owning command. */
export function interceptSqliteInsert(db:DatabaseSync,table:string,mutate:(row:Record<string,SQLInputValue>)=>Record<string,SQLInputValue>|null){
 const prepare=db.prepare.bind(db);
 return vi.spyOn(db,'prepare').mockImplementation(sql=>{
  const statement=prepare(sql),match=new RegExp(`^INSERT INTO ${table}\\(([^)]+)\\)`, 'i').exec(sql);if(!match)return statement;
  return new Proxy(statement,{get(target,key){
   if(key==='run')return (...values:SQLInputValue[])=>{const columns=match[1]!.split(',').map(s=>s.trim()),row=mutate(Object.fromEntries(columns.map((k,i)=>[k,values[i]!])));return row?target.run(...columns.map(k=>row[k]!)):{changes:0,lastInsertRowid:0};};
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
 });
}
