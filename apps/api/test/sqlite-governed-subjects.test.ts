import { expect,it } from 'vitest';
import { governedFixture } from './helpers/sqlite-governed.js';
import { sqliteGovernedSubjectCommands } from '../src/storage/sqlite/governed-subject-commands.js';
import { stableId } from '../src/governed-review/storage-values.js';
import { governedContentV1Digest } from '../src/lib/governed-content-digest.js';
it('lists only current project participants and preserves retained subject identity across account erasure',async()=>{
 const f=await governedFixture(),commands=sqliteGovernedSubjectCommands(f.db);
 const {user}=await f.runtime.auth.api.signUpEmail({body:{email:'second@example.test',password:'synthetic-long-password',name:'Alice'}});
 f.db.prepare('INSERT INTO project_members VALUES(?,?,?,?,?)').run('member-two',f.projectId,user.id,'member',new Date().toISOString());
 const first=commands.governedAssignableSubjects(f.actor);expect(first.map(s=>s.userId)).toEqual([user.id,f.userId]);
 const member=first[0]!,owner=first[1]!;
 expect(owner.subjectId).toBe('subject');expect(member.subjectId).toBe(stableId('grs',f.projectId,user.id));
 expect(f.db.prepare('SELECT subject_digest FROM governed_reviewer_subjects WHERE id=?').get(member.subjectId)?.subject_digest).toBe(governedContentV1Digest('governed-reviewer-subject/v1',{projectId:f.projectId,subjectId:member.subjectId}));
 expect(commands.governedAssignableSubjects(f.actor)).toEqual(first);
 expect(()=>commands.governedAssignableSubjects({...f.actor,userId:user.id,projectRole:'owner'})).toThrow(expect.objectContaining({code:'governed_review_forbidden'}));
 expect(()=>commands.governedAssignableSubjects({...f.actor,projectRole:'member'})).toThrow();
 f.db.prepare('DELETE FROM "user" WHERE id=?').run(user.id);
 expect(f.db.prepare('SELECT account_user_id FROM governed_reviewer_subjects WHERE id=?').get(member.subjectId)?.account_user_id).toBeNull();
 expect(commands.governedAssignableSubjects(f.actor)).toEqual([owner]);
});

it('rejects corrupt subject digests, rebinding, manual unlink and no-op updates',async()=>{
 const f=await governedFixture();
 expect(()=>f.db.prepare('INSERT INTO governed_reviewer_subjects VALUES(?,?,?,?,?)').run('forged',f.projectId,null,'sha256:'+'0'.repeat(64),new Date().toISOString())).toThrow(/subject digest mismatch/);
 for(const set of ['id=id','account_user_id=NULL',"account_user_id='foreign'","subject_digest='sha256:'||printf('%064d',0)"]){
  expect(()=>f.db.exec('UPDATE governed_reviewer_subjects SET '+set+" WHERE id='subject'")).toThrow(/immutable reviewer subject/);
 }
 expect(()=>f.db.exec("DELETE FROM governed_reviewer_subjects WHERE id='subject'")).toThrow(/project erasure/);
});
