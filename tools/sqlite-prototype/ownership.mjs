// All predicates use database time; a queue delivery never authorizes a new call.
export function claim(store, id, owner, ttl) {
  if (!owner || !Number.isSafeInteger(ttl) || ttl <= 0) throw new Error('invalid claim');
  return store.transaction(db => db.prepare(`UPDATE attempts SET state='claimed',
    owner=?,epoch=epoch+1,expires_at=command_time()+?
    WHERE id=? AND (state='ready' OR (state='claimed' AND expires_at <= command_time()))
    RETURNING id, owner, epoch`).get(owner, ttl, id));
}
export function start(store, claim) {
  return store.transaction(db => db.prepare(`UPDATE attempts SET state='started',calls=1
    WHERE id=? AND owner=? AND epoch=? AND state='claimed' AND expires_at > command_time()`)
    .run(claim.id, claim.owner, claim.epoch).changes === 1);
}
export function finish(store, claim, result) {
  return store.transaction(db => db.prepare(`UPDATE attempts SET state='completed',result=?,owner=NULL,expires_at=NULL
    WHERE id=? AND owner=? AND epoch=? AND state='started' AND expires_at > command_time()`)
    .run(result, claim.id, claim.owner, claim.epoch).changes === 1);
}
export function recover(store) {
  return store.transaction(db => db.prepare(`UPDATE attempts SET state='outcome_unknown',owner=NULL,expires_at=NULL
    WHERE state='started' AND expires_at <= command_time()`).run().changes);
}
