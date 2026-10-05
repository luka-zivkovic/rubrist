import { initializeGovernedSqliteFunctions } from './governed-functions.js';
import { randomUUID } from 'node:crypto';
import { constants, type DatabaseSync, type SQLInputValue } from 'node:sqlite';

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
interface ConnectionState { current:SqliteCommandContext|null; callbackActive:boolean; advancingClock:boolean }
const connections=new WeakMap<DatabaseSync,ConnectionState>();
function stateFor(db:DatabaseSync):ConnectionState {
  const existing=connections.get(db);if(existing)return existing;
  initializeGovernedSqliteFunctions(db);
  const state:ConnectionState={current:null,callbackActive:false,advancingClock:false};
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
    db.setAuthorizer(action=>state.callbackActive&&(action===constants.SQLITE_TRANSACTION||action===constants.SQLITE_SAVEPOINT)?constants.SQLITE_DENY:constants.SQLITE_OK);
    state.callbackActive=true;
    const result=work(context);
    if(result&&typeof (result as {then?:unknown}).then==='function')throw new Error('Synchronous SQLite command required');
    assertOwned();state.callbackActive=false;db.exec('COMMIT');return result;
  } catch(error) {
    state.callbackActive=false;state.advancingClock=false;if(db.isTransaction)db.exec('ROLLBACK');throw error;
  } finally {state.current=null;state.callbackActive=false;state.advancingClock=false;}
}
