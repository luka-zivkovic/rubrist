#!/usr/bin/env node
// Owns only newly generated, disposable Compose projects and synthetic data.
import {createServer} from 'node:net';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {prepareInstallation} from '../self-host/install.mjs';
const args=process.argv.slice(2),apiImage=args[0],webImage=args[1],previousImage=args[2];
if(!apiImage||!webImage)throw Error('Usage: sqlite-deployment.mjs API_IMAGE WEB_IMAGE [SYNTHETIC_PREDECESSOR_IMAGE]');
const root=mkdtempSync(join(tmpdir(),'rubrist-deployment-')),first=join(root,'first'),restored=join(root,'restored');
const owned=[],helpers=[];
const port=await new Promise((resolve,reject)=>{const server=createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(error=>error?reject(error):resolve(port));});});
const origin=`http://127.0.0.1:${port}`;
const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^COMPOSE_|^RUBRIST_|^(DATABASE_URL|BETTER_AUTH_SECRET)$/.test(key)));
function run(command,args,cwd){try{return execFileSync(command,args,{cwd,env:environment,encoding:'utf8',timeout:900_000,stdio:['ignore','pipe','pipe']}).trim();}catch(error){throw Error(`${command} ${args[0]} failed: ${error.stderr?.toString()??error.message}`);}}
function compose(directory,...args){const project=/^COMPOSE_PROJECT_NAME=(rubrist-[a-f0-9]{16})$/m.exec(readFileSync(join(directory,'.env'),'utf8'))?.[1];if(!project)throw Error('Missing generated disposable project name');return run('docker',['compose','--project-name',project,'--env-file',join(directory,'.env'),'--file',join(directory,'compose.yaml'),'--file',join(directory,'compose.override.yaml'),...args],directory);}
function configure(directory,image){writeFileSync(join(directory,'compose.override.yaml'),`services:\n  api:\n    image: ${JSON.stringify(image)}\n    pull_policy: never\n  web:\n    image: ${JSON.stringify(webImage)}\n    pull_policy: never\n    ports: !override\n      - '127.0.0.1:${port}:80'\n`);}
function endpoint(){return origin;}
const smoke=fileURLToPath(new URL('./deployment-smoke.mjs',import.meta.url));
const state=join(root,'state.json');
function verify(directory,mode){return run(process.execPath,[smoke,mode,endpoint(directory),state]);}
try{
 prepareInstallation({backend:'sqlite',version:'0.0.0',directory:first,publicUrl:origin});owned.push(first);configure(first,previousImage??apiImage);
 compose(first,'up','-d','--wait','--wait-timeout','900');
 function pinPort(directory,image){configure(directory,image);}
 console.log(verify(first,'create'));
 compose(first,'cp','auth-recovery.json','api:/tmp/recovery.json');
 compose(first,'exec','-T','api','node','tools/storage/sqlite-backup.mjs','backup','--source','/var/lib/rubrist/rubrist.sqlite','--output','/var/lib/rubrist-backups/pre-upgrade','--recovery-file','/tmp/recovery.json');
 compose(first,'cp','api:/var/lib/rubrist-backups/pre-upgrade',join(root,'backup'));
 compose(first,'exec','-T','api','rm','/tmp/recovery.json');
 compose(first,'restart');compose(first,'up','-d','--wait','--wait-timeout','900');console.log(verify(first,'verify'));
 pinPort(first,apiImage,port);compose(first,'up','-d','--force-recreate','--wait','--wait-timeout','900');console.log(verify(first,'verify'));
 compose(first,'stop');
 if(previousImage){
  // The synthetic predecessor must reject the newer history; never run it concurrently.
  pinPort(first,previousImage,port);
  let rejected=false;try{compose(first,'run','--rm','--no-deps','api');}catch(error){rejected=/schema|migration/i.test(error.message);}if(!rejected)throw Error('Older image did not reject upgraded schema');
  pinPort(first,apiImage,port);
 }
 prepareInstallation({backend:'sqlite',version:'0.0.0',directory:restored,publicUrl:origin,recoveryFile:join(first,'auth-recovery.json')});owned.push(restored);pinPort(restored,previousImage??apiImage,port);
 const helper='rubrist-restore-'+randomBytes(6).toString('hex');helpers.push(helper);
 compose(restored,'run','-d','--no-deps','--name',helper,'api','sleep','infinity');
 run('docker',['cp',join(root,'backup'),helper+':/restore']);run('docker',['cp',join(restored,'auth-recovery.json'),helper+':/run/recovery.json']);
 run('docker',['exec',helper,'node','tools/storage/sqlite-backup.mjs','restore','--backup','/restore','--target','/var/lib/rubrist/rubrist.sqlite','--recovery-file','/run/recovery.json']);
 run('docker',['rm','-f',helper]);helpers.splice(helpers.indexOf(helper),1);
 compose(restored,'up','-d','--wait','--wait-timeout','900');console.log(verify(restored,'verify'));
 console.log('SQLite installation, restart, replacement, backup and restore passed'+(previousImage?', including synthetic predecessor upgrade and rollback.':'.'));
}finally{
 for(const helper of helpers)try{run('docker',['rm','-f',helper]);}catch{}
 for(const directory of owned.reverse())try{compose(directory,'down','--volumes','--remove-orphans');}catch(error){console.error('Disposable project cleanup failed:',error.message);}
 rmSync(root,{recursive:true,force:true});
}
