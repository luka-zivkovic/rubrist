#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareInstallation} from '../self-host/install.mjs';
const [apiImage,webImage]=process.argv.slice(2);
if(!apiImage||!webImage)throw Error('Usage: postgres-deployment.mjs API_IMAGE WEB_IMAGE');
const root=mkdtempSync(join(tmpdir(),'rubrist-pg-deployment-')),directory=join(root,'installation');
const port=await new Promise((resolve,reject)=>{const server=createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(error=>error?reject(error):resolve(port));});});
const origin=`http://127.0.0.1:${port}`;
prepareInstallation({backend:'postgres',version:'0.0.0',directory,publicUrl:origin});
const project=/^COMPOSE_PROJECT_NAME=(rubrist-[a-f0-9]{16})$/m.exec(readFileSync(join(directory,'.env'),'utf8'))?.[1];
if(!project)throw Error('Missing generated disposable project name');
writeFileSync(join(directory,'compose.override.yaml'),`services:\n  api:\n    image: ${JSON.stringify(apiImage)}\n    pull_policy: never\n  web:\n    image: ${JSON.stringify(webImage)}\n    pull_policy: never\n    ports: !override\n      - '127.0.0.1:${port}:80'\n`);
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^COMPOSE_|^RUBRIST_|^(DATABASE_URL|BETTER_AUTH_SECRET)$/.test(key)));
function run(command,args){try{return execFileSync(command,args,{cwd:directory,env,encoding:'utf8',timeout:900_000,stdio:['ignore','pipe','pipe']}).trim();}catch(error){throw Error(`${command} ${args[0]} failed: ${error.stderr?.toString()??error.message}`);}}
function compose(...args){return run('docker',['compose','--project-name',project,'--env-file',join(directory,'.env'),'--file',join(directory,'compose.yaml'),'--file',join(directory,'compose.override.yaml'),...args]);}
const smoke=fileURLToPath(new URL('./deployment-smoke.mjs',import.meta.url)),state=join(root,'state.json');
try{
 compose('up','-d','--wait','--wait-timeout','900');console.log(run(process.execPath,[smoke,'create',origin,state]));
 compose('restart');compose('up','-d','--wait','--wait-timeout','900');console.log(run(process.execPath,[smoke,'verify',origin,state]));
 compose('up','-d','--force-recreate','--wait','--wait-timeout','900');console.log(run(process.execPath,[smoke,'verify',origin,state]));
 console.log('PostgreSQL template installation, readiness, restart and replacement passed.');
}finally{try{compose('down','--volumes','--remove-orphans');}finally{rmSync(root,{recursive:true,force:true});}}
