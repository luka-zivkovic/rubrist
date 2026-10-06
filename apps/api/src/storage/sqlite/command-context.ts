import { initializeGovernedSqliteFunctions } from './governed-functions.js';
import { randomUUID } from 'node:crypto';
import { constants, type DatabaseSync, type SQLOutputValue, type SQLInputValue } from 'node:sqlite';

export interface SqliteCommandDatabase {
  exec(sql:string):void;
  prepare(sql:string):{
    run(...values:SQLInputValue[]):ReturnType<ReturnType<DatabaseSync['prepare']>['run']>;
    get(...values:SQLInputValue[]):ReturnType<ReturnType<DatabaseSync['prepare']>['get']>;
    all(...values:SQLInputValue[]):ReturnType<ReturnType<DatabaseSync['prepare']>['all']>;
  };
}
export interface SqliteCommandContext {
  readonly token:string;
  readonly milliseconds:number;
  readonly timestamp:string;
  readonly db:SqliteCommandDatabase;
}
export interface SqliteValidatorReader {
  get(sql:string,...values:SQLInputValue[]):Record<string,SQLOutputValue>|undefined;
  iterate(sql:string,...values:SQLInputValue[]):IterableIterator<Record<string,SQLOutputValue>>;
}
interface ConnectionState { current:SqliteCommandContext|null; callbackActive:boolean; advancingClock:boolean; validatorActive:boolean; validators:Map<string,ReadonlySet<string>> }
// Domain commands never change schema, attachments or connection pragmas. Such
// changes are administrative and cannot shadow a validator trigger mid-command.
const administrativeActions=new Set([
  constants.SQLITE_CREATE_INDEX,constants.SQLITE_CREATE_TABLE,constants.SQLITE_CREATE_TEMP_INDEX,constants.SQLITE_CREATE_TEMP_TABLE,
  constants.SQLITE_CREATE_TEMP_TRIGGER,constants.SQLITE_CREATE_TEMP_VIEW,constants.SQLITE_CREATE_TRIGGER,constants.SQLITE_CREATE_VIEW,
  constants.SQLITE_DROP_INDEX,constants.SQLITE_DROP_TABLE,constants.SQLITE_DROP_TEMP_INDEX,constants.SQLITE_DROP_TEMP_TABLE,
  constants.SQLITE_DROP_TEMP_TRIGGER,constants.SQLITE_DROP_TEMP_VIEW,constants.SQLITE_DROP_TRIGGER,constants.SQLITE_DROP_VIEW,
  constants.SQLITE_PRAGMA,constants.SQLITE_ATTACH,constants.SQLITE_DETACH,constants.SQLITE_ALTER_TABLE,constants.SQLITE_REINDEX,
  constants.SQLITE_ANALYZE,constants.SQLITE_CREATE_VTABLE,constants.SQLITE_DROP_VTABLE
]);
const connections=new WeakMap<DatabaseSync,ConnectionState>();
function stateFor(db:DatabaseSync):ConnectionState {
  const existing=connections.get(db);if(existing)return existing;
  initializeGovernedSqliteFunctions(db);
  const state:ConnectionState={current:null,callbackActive:false,advancingClock:false,validatorActive:false,validators:new Map()};
  const current=()=>{if(!state.current||!state.callbackActive||!db.isTransaction)throw new Error('Managed SQLite command required');return state.current;};
  db.function('sqlite_command_token',()=>current().token);
  db.function('sqlite_command_time',()=>current().timestamp);
  db.function('sqlite_command_milliseconds',()=>current().milliseconds);
  db.function('sqlite_clock_write_allowed',()=>Number(state.advancingClock&&db.isTransaction));
  connections.set(db,state);return state;
}
export function initializeSqliteCommandContext(db:DatabaseSync):void {stateFor(db);}
export function assertSqliteCommandOwnership(db:DatabaseSync):void {
  const state=connections.get(db);
  if(state?.current&&(!state.callbackActive||!db.isTransaction))throw new Error('SQLite command ownership lost');
}

/** All callbacks are synchronous internal commands; no network or auth awaits. */
export function sqliteCommand<T>(db:DatabaseSync,work:(context:SqliteCommandContext)=>T,clock=Date.now):T {
  const state=stateFor(db);
  if(state.current||db.isTransaction)throw new Error('Nested SQLite command');
  if(work.constructor.name==='AsyncFunction')throw new Error('Synchronous SQLite command required');
  try {
    db.exec('BEGIN IMMEDIATE');
    const sampled=clock();if(!Number.isSafeInteger(sampled)||sampled<0)throw new Error('Invalid SQLite command clock');
    state.advancingClock=true;
    const row=db.prepare('UPDATE rubrist_command_clock SET last_ms=max(last_ms,?) WHERE singleton=1 RETURNING last_ms').get(sampled);
    state.advancingClock=false;
    if(!row)throw new Error('SQLite command clock missing');
    const milliseconds=Number(row.last_ms),token=randomUUID();
    let context:SqliteCommandContext;
    const assertOwned=()=>{if(state.current!==context||!state.callbackActive||!db.isTransaction)throw new Error('SQLite command ownership lost');};
    const commandDb:SqliteCommandDatabase={
      exec(sql){assertOwned();db.exec(sql);},
      prepare(sql){assertOwned();const statement=db.prepare(sql);return {
        run(...values){assertOwned();return statement.run(...values);},
        get(...values){assertOwned();return statement.get(...values);},
        all(...values){assertOwned();return statement.all(...values);}
      };}
    };
    context=Object.freeze({token,milliseconds,timestamp:new Date(milliseconds).toISOString(),db:Object.freeze(commandDb)});
    state.current=context;
    // Resetting invalidates cached transaction statements from before the command.
    db.setAuthorizer((action,_arg1,arg2,_dbName,source)=>{
      if(action===constants.SQLITE_FUNCTION&&arg2&&state.validators.has(arg2)){
        if(state.validatorActive||!source||!state.validators.get(arg2)!.has(source))return constants.SQLITE_DENY;
      }
      if(state.validatorActive&&![constants.SQLITE_READ,constants.SQLITE_SELECT,constants.SQLITE_FUNCTION,constants.SQLITE_RECURSIVE].includes(action))return constants.SQLITE_DENY;
      return state.callbackActive&&(action===constants.SQLITE_TRANSACTION||action===constants.SQLITE_SAVEPOINT||administrativeActions.has(action))?constants.SQLITE_DENY:constants.SQLITE_OK;
    });
    state.callbackActive=true;
    const result=work(context);
    if(result&&typeof (result as {then?:unknown}).then==='function')throw new Error('Synchronous SQLite command required');
    assertOwned();state.callbackActive=false;db.exec('COMMIT');return result;
  } catch(error) {
    state.callbackActive=false;state.advancingClock=false;if(db.isTransaction)db.exec('ROLLBACK');throw error;
  } finally {state.current=null;state.callbackActive=false;state.advancingClock=false;}
}

/** Trigger-only database re-derivation. The callback receives no mutation/connection API. */
export function registerSqliteValidator(db:DatabaseSync,name:string,triggers:readonly string[],validate:(reader:SqliteValidatorReader,...args:SQLOutputValue[])=>boolean):void {
 const state=stateFor(db);
 if(validate.constructor.name==='AsyncFunction'||!/^analysis_[a-z0-9_]+_valid_v[1-9][0-9]*$/.test(name)||!triggers.length||state.validators.has(name)||state.current)throw new Error('Invalid SQLite validator registration');
 state.validators.set(name,new Set(triggers));
 db.function(name,{varargs:true},(...args)=>{
  if(!state.current||!state.callbackActive||!db.isTransaction||state.validatorActive)return 0;
  state.validatorActive=true;let active=true;
  const cursors=new Set<IterableIterator<Record<string,SQLOutputValue>>>();
  const assertActive=()=>{if(!active||!state.validatorActive||!state.callbackActive||!db.isTransaction)throw new Error('SQLite validator scope expired');};
  const reader:SqliteValidatorReader=Object.freeze({
   get(sql:string,...values:SQLInputValue[]){assertActive();return db.prepare(sql).get(...values);},
   iterate(sql:string,...values:SQLInputValue[]){assertActive();const cursor=db.prepare(sql).iterate(...values);cursors.add(cursor);
    const wrapped:IterableIterator<Record<string,SQLOutputValue>>={
     next(){assertActive();const value=cursor.next();if(value.done)cursors.delete(cursor);return value;},
     return(){assertActive();cursors.delete(cursor);return cursor.return!();},
     [Symbol.iterator](){return this;}
    };return Object.freeze(wrapped);
   }
  });
  try{return validate(reader,...args)===true?1:0;}catch{return 0;}
  finally{for(const cursor of cursors){try{cursor.return?.();}catch{/* Preserve the guard verdict. */}}active=false;state.validatorActive=false;}
 });
}
