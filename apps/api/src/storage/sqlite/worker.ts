import { parentPort, workerData } from 'node:worker_threads';
import { migrateSqlite, openSqlite } from '@rubrist/db/sqlite';
import { createAuth } from '../../lib/auth.js';
import { sqliteCommands } from './commands.js';

const port = parentPort!;
// All messages (including async authentication) run in order. Domain commands
// cannot enter the auth driver's open transaction or block its completion.
const domain = openSqlite(workerData.path);
migrateSqlite(domain);
const authentication = openSqlite(workerData.path);
const auth = createAuth(authentication);
const commands = sqliteCommands(domain);
let pending = Promise.resolve();
port.postMessage({ ready: true });
port.on('message', (message) => {
  pending = pending.then(async () => {
    try {
      let result: unknown;
      if (message.kind === 'close') {
        authentication.close(); domain.close();
        port.postMessage({id:message.id,result:null}); port.close(); return;
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
      const value = error as Error & {statusCode?:number;body?:unknown};
      port.postMessage({id:message.id,error:{name:value.name,message:value.message,statusCode:value.statusCode,body:value.body}});
    }
  });
});
