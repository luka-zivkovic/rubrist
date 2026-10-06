#!/usr/bin/env node
import {secretRecord} from '../storage/sqlite-backup.mjs';
import {randomBytes} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';

export function packageVersion(){return JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8')).version;}
/** Prepares a fresh operator directory; does not start Docker or alter an installation. */
export function prepareInstallation({backend,version,directory,publicUrl='http://localhost:8081',recoveryFile}) {
  if(!['sqlite','postgres'].includes(backend))throw Error('Choose --backend sqlite or postgres');
  if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version??''))throw Error('Choose an exact --version X.Y.Z');
  // The template comes from this checkout or image, so it must name the same release.
  if(version!==packageVersion())throw Error(`--version must match this installer's release (${packageVersion()}); run the installer from the image or checkout of the release you install`);
  if(!directory)throw Error('--directory is required and must not already exist');
  let url;try{url=new URL(publicUrl);}catch{throw Error('Invalid --public-url');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/'||/[\s$'"\\]/.test(publicUrl))throw Error('--public-url must be an HTTP(S) origin');
  const template=readFileSync(new URL(`../../deploy/self-host/compose${backend==='sqlite'?'.sqlite':''}.yaml`,import.meta.url));
  const root=resolve(directory);
  // Exclusive directory creation prevents overwriting existing env, data or customizations.
  const secret=recoveryFile?secretRecord(recoveryFile):randomBytes(32).toString('hex');
  if(!/^[a-zA-Z0-9_+\/=-]{32,}$/.test(secret))throw Error('Recovered secret requires manual protected environment configuration');
  mkdirSync(root,{mode:0o700});
  const env=[`COMPOSE_PROJECT_NAME=rubrist-${randomBytes(8).toString('hex')}`,`RUBRIST_VERSION=${version}`,`RUBRIST_PUBLIC_URL=${url.origin}`,`RUBRIST_AUTH_SECRET=${secret}`,`RUBRIST_BOOTSTRAP_TOKEN=${randomBytes(32).toString('hex')}`];
  if(backend==='postgres')env.push(`RUBRIST_POSTGRES_PASSWORD=${randomBytes(32).toString('hex')}`);
  writeFileSync(join(root,'.env'),env.join('\n')+'\n',{flag:'wx',mode:0o600});
  writeFileSync(join(root,'compose.yaml'),template,{flag:'wx',mode:0o600});
  writeFileSync(join(root,'auth-recovery.json'),JSON.stringify({format:'rubrist-auth-recovery-v1',betterAuthSecret:secret},null,2)+'\n',{flag:'wx',mode:0o600});
  return root;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const options={};
    for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i];if(!['--backend','--version','--directory','--public-url','--recovery-file'].includes(key)||!process.argv[i+1])throw Error('Usage: install.mjs --backend sqlite|postgres --version X.Y.Z --directory NEW_DIRECTORY [--public-url ORIGIN]');const name=key==='--public-url'?'publicUrl':key==='--recovery-file'?'recoveryFile':key.slice(2);if(Object.hasOwn(options,name))throw Error('Duplicate option');options[name]=process.argv[i+1];}
    prepareInstallation(options);
    console.log('Prepared a new installation. Securely retain auth-recovery.json off-host, then run docker compose up -d --wait from the installation directory.');
  }catch(error){console.error(error.code==='EEXIST'?'Installation directory already exists; nothing was overwritten.':error.code?'Cannot prepare installation files; check destination permissions and space.':error.message);process.exitCode=1;}
}
