#!/usr/bin/env node
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export function assertReleaseTemplateImages(config,{owner,version,template}) {
  for(const service of ['api','web']) {
    assert.equal(config.services?.[service]?.image,`ghcr.io/${owner}/rubrist-${service}:${version}`,
      `${template}: ${service} must reference the published release image`);
  }
}

export function verifyReleaseTemplateImages({owner,tag}) {
  if(!/^[a-z0-9][a-z0-9-]*$/.test(owner??'')||!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag??'')) {
    throw Error('IMAGE_OWNER and an exact RELEASE_TAG vX.Y.Z are required');
  }
  const version=tag.slice(1),root=fileURLToPath(new URL('../../',import.meta.url));
  const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^COMPOSE_|^RUBRIST_|^SERVICE_|^POSTGRES_/.test(key))),
    RUBRIST_VERSION:version,RUBRIST_AUTH_SECRET:'synthetic-release-render-secret-at-least-32-bytes',
    RUBRIST_POSTGRES_PASSWORD:'synthetic-render-password',SERVICE_PASSWORD_POSTGRES:'synthetic-render-password',
    SERVICE_REALBASE64_64_AUTHSECRET:'synthetic-release-render-secret-at-least-32-bytes',
    SERVICE_URL_WEB:'http://localhost:8081',SERVICE_URL_WEB_80:'http://localhost:8081',
    SERVICE_PASSWORD_64_BOOTSTRAP:'synthetic-render-bootstrap'};
  for(const template of ['deploy/self-host/compose.yaml','deploy/self-host/compose.sqlite.yaml','deploy/coolify.yaml','deploy/coolify.sqlite.yaml']) {
    // Render the shipped file alone, without the image overrides used by local drills.
    const config=JSON.parse(execFileSync('docker',['compose','--env-file','/dev/null','-f',template,'config','--format','json'],
      {cwd:root,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
    assertReleaseTemplateImages(config,{owner,version,template});
    console.log(`${template}: published API and web image references verified`);
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  verifyReleaseTemplateImages({owner:process.env.IMAGE_OWNER,tag:process.env.RELEASE_TAG});
}
