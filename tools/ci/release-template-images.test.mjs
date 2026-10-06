import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertReleaseTemplateImages} from './release-template-images.mjs';

test('release image validation rejects wrong owners, repositories, tags and missing services',()=>{
  const options={owner:'release-owner',version:'1.2.3',template:'synthetic-template'};
  const config={services:{api:{image:'ghcr.io/release-owner/rubrist-api:1.2.3'},web:{image:'ghcr.io/release-owner/rubrist-web:1.2.3'}}};
  assert.doesNotThrow(()=>assertReleaseTemplateImages(config,options));
  for(const service of ['api','web']) {
    for(const image of [`ghcr.io/wrong-owner/rubrist-${service}:1.2.3`,`ghcr.io/release-owner/wrong-repository:1.2.3`,`ghcr.io/release-owner/rubrist-${service}:0.0.0`,undefined]) {
      const invalid=structuredClone(config);invalid.services[service].image=image;
      assert.throws(()=>assertReleaseTemplateImages(invalid,options),/must reference the published release image/);
    }
    const missing=structuredClone(config);delete missing.services[service];
    assert.throws(()=>assertReleaseTemplateImages(missing,options),/must reference the published release image/);
  }
});
