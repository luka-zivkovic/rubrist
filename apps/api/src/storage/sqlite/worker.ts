import { sqliteDiagnostic } from './diagnostics.js';
import { acquireSqliteInstance } from './instance-lock.js';
import { sqliteCommand } from './command-context.js';
import { parentPort, workerData } from 'node:worker_threads';
import { migrateSqlite, openSqlite } from '@rubrist/db/sqlite';
import { createAuth } from '../../lib/auth.js';
import { serializeSqliteError } from './error-transport.js';
import { seedExistingSqliteStarterEvaluators } from './starter-evaluator.js';
import { sqliteCommands } from './commands.js';

const port = parentPort!;
// All messages (including async authentication) run in order. Domain commands
// cannot enter the auth driver's open transaction or block its completion.
const {domain, authentication, auth, commands, instance} = (() => {
  try {
    const instance = workerData.exclusiveInstance ? acquireSqliteInstance(workerData.path,process.env.RUBRIST_REQUIRE_PERSISTENT_MOUNT==='1') : null;
    const migration = openSqlite(workerData.path);
    try { migrateSqlite(migration); } finally { if (migration.isOpen) migration.close(); }
    const domain = openSqlite(workerData.path);
    const authentication = openSqlite(workerData.path);
    const auth = createAuth(authentication);
    const commands = sqliteCommands(domain,{seedStarterEvaluators:workerData.seedStarterEvaluators});
    if(workerData.seedStarterEvaluators)seedExistingSqliteStarterEvaluators(domain);
    return {domain, authentication, auth, commands, instance};
  } catch (error) { throw new Error(sqliteDiagnostic(error)); }
})();
let pending = Promise.resolve();
port.postMessage({ ready: true });
port.on('message', (message) => {
  pending = pending.then(async () => {
    try {
      let result: unknown;
      if (message.kind === 'close') {
        authentication.close(); domain.close(); instance?.close();
        port.postMessage({id:message.id,result:null}); port.close(); return;
      } else if (message.kind === 'probe') {
        result = sqliteCommand(domain, () => true);
      } else if (message.kind === 'auth-handler') {
        const req = message.request;
        const response = await auth.handler(new Request(req.url,{method:req.method,headers:req.headers,...(req.body === null ? {} : {body:req.body})}));
        result = {status:response.status,headers:[...response.headers],cookies:response.headers.getSetCookie(),body:await response.text()};
      } else if (message.kind === 'auth-api') {
        if (!['getSession','signUpEmail','signInEmail'].includes(message.name)) throw new Error('Unknown auth command');
        const input = {...message.input,...(message.input.headers ? {headers:new Headers(message.input.headers)} : {})};
        const api = auth.api[message.name as 'getSession'|'signUpEmail'|'signInEmail'] as (arg: never) => Promise<unknown>;
        const response = await api(input as never);
        if (input.returnHeaders) {
          const withHeaders = response as {headers:Headers;response:unknown};
          result = {headers:[...withHeaders.headers],cookies:withHeaders.headers.getSetCookie(),response:withHeaders.response};
        } else result = response;
      } else if (message.kind === 'command') {
        if (!Object.hasOwn(commands,message.name)) throw new Error('Unknown storage command');
        const fn = commands[message.name as keyof typeof commands] as (...args: never[]) => unknown;
        result = fn(...message.args as never[]);
      } else throw new Error('Unknown storage message');
      port.postMessage({id:message.id,result});
    } catch(error) {
      port.postMessage({id:message.id,error:serializeSqliteError(error)});
    }
  });
});
