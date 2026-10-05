import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync, backup } from 'node:sqlite';
import { digest, openPrototype } from './sqlite-prototype/database.mjs';
import { claim, start, finish, recover } from './sqlite-prototype/ownership.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rubrist-sqlite-m0-'));
  const path = join(dir, 'prototype.sqlite');
  let now = 100;
  const handles = [];
  function open(initialize = false) {
    const store = openPrototype(path, { initialize, clock: () => now });
    handles.push(store);
    return store;
  }
  const store = open(true);
  store.db.exec("INSERT INTO projects VALUES('p'),('other'); INSERT INTO attempts(id) VALUES('job');");
  t.after(() => {
    for (const handle of handles) { if (handle.db.isOpen) handle.close(); }
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, open, path, dir, time: value => { now = value; } };
}
const bytes = Buffer.from('["synthetic α","second"]');
function parent(db, id = 'bundle', artifact = bytes, hash = digest(artifact)) {
  db.prepare(`INSERT INTO bundles(id,project_id,expected_count,canonical_bytes,bytes_digest,finalized_id)
    VALUES(?,'p',2,?,?,?)`).run(id, artifact, hash, id);
}
function members(db, id = 'bundle') {
  const insert = db.prepare('INSERT INTO members VALUES(?,?,?,?)');
  insert.run(id, 'p', 0, 'synthetic α');
  insert.run(id, 'p', 1, 'second');
}
function complete(store, id = 'bundle') {
  store.transaction(db => {
    parent(db, id); members(db, id);
    db.prepare("INSERT INTO finalizations VALUES(?,'p')").run(id);
  });
}

test('completeness: incomplete COMMIT and nested savepoint bypass fail, valid finalization persists', t => {
  const { store, open } = fixture(t);
  assert.throws(() => store.transaction(db => parent(db)), /FOREIGN KEY/);
  assert.equal(store.db.prepare('SELECT count(*) n FROM bundles').get().n, 0);
  assert.throws(() => store.transaction(db => {
    parent(db); db.exec('SAVEPOINT inner_write'); members(db); db.exec('RELEASE inner_write');
  }), /FOREIGN KEY/);
  complete(store);
  assert.deepEqual(Buffer.from(open().db.prepare('SELECT canonical_bytes FROM bundles').get().canonical_bytes), bytes);
});

test('completeness: raw writes reject early finalization, omissions, wrong positions, project and byte digest', t => {
  const { store } = fixture(t);
  assert.throws(() => store.transaction(db => {
    parent(db); db.exec("INSERT INTO finalizations VALUES('bundle','p')");
  }), /complete member set/);
  assert.throws(() => store.transaction(db => parent(db, 'bad', bytes, '0'.repeat(64))), /CHECK/);
  for (const row of [['bundle','p',2,'second'], ['bundle','other',0,'synthetic α'], ['bundle','p',0,'wrong']]) {
    assert.throws(() => store.transaction(db => {
      parent(db); db.prepare('INSERT INTO members VALUES(?,?,?,?)').run(...row);
    }), /exact artifact position/);
  }
  assert.throws(() => store.transaction(db => {
    parent(db); members(db); db.exec("INSERT INTO members VALUES('bundle','p',1,'second')");
  }), /UNIQUE/);
});

test('immutability: update, delete, replacement and late append rejected; tenant erasure cascades', t => {
  const { store } = fixture(t); complete(store);
  store.transaction(db => db.exec("INSERT INTO handoffs VALUES('h','bundle')"));
  assert.throws(() => store.db.exec('DELETE FROM handoffs'), /immutable handoff/);
  for (const table of ['bundles', 'members', 'finalizations']) {
    assert.throws(() => store.db.exec(`DELETE FROM ${table}`), /erasure only/);
    assert.throws(() => store.db.exec(`UPDATE ${table} SET project_id=project_id`), /immutable/);
  }
  assert.throws(() => store.db.exec("INSERT OR REPLACE INTO members VALUES('bundle','p',0,'synthetic α')"), /finalized/);
  assert.throws(() => store.db.exec("INSERT INTO members VALUES('bundle','p',2,'late')"), /finalized/);
  store.transaction(db => db.exec("DELETE FROM projects WHERE id='p'"));
  assert.equal(store.db.prepare('SELECT count(*) n FROM handoffs').get().n, 0);
  for (const table of ['bundles', 'members', 'finalizations']) {
    assert.equal(store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  }
});

test('transaction context: same-command handoff and unmanaged writes fail, committed handoff succeeds', t => {
  const { store, open } = fixture(t);
  assert.throws(() => store.transaction(db => {
    parent(db); members(db); db.exec("INSERT INTO finalizations VALUES('bundle','p')");
    db.exec("INSERT INTO handoffs VALUES('h','bundle')");
  }), /previously committed/);
  complete(store);
  open().transaction(db => db.exec("INSERT INTO handoffs VALUES('h','bundle')"));
  assert.throws(() => store.transaction(db => {
    parent(db, 'new'); members(db, 'new'); db.exec("INSERT INTO finalizations VALUES('new','p')");
    db.exec("UPDATE handoffs SET bundle_id='new' WHERE id='h'");
  }), /immutable handoff/);
  assert.throws(() => store.transaction(db => db.exec("INSERT OR REPLACE INTO handoffs VALUES('h','bundle')")), /immutable handoff/);
  assert.throws(() => store.db.exec("INSERT INTO handoffs VALUES('outside','bundle')"), /managed transaction/);
  assert.throws(() => store.transaction(async () => {}), /synchronous/);
  assert.throws(() => store.transaction(() => store.transaction(() => {})), /nested/);
});

test('managed SQL cannot commit or roll back outside its owner, including prepared statements', t => {
  const { store } = fixture(t);
  for (const sql of ['COMMIT', 'END TRANSACTION', 'ROLLBACK', 'BEGIN']) {
    const prepared = store.db.prepare(sql);
    for (const escape of [db => db.exec(sql), () => prepared.run()]) {
      assert.throws(() => store.transaction(db => {
        db.exec("INSERT INTO attempts(id) VALUES('must-roll-back')");
        escape(db);
        db.exec("INSERT INTO attempts(id) VALUES('escaped-autocommit')");
        throw new Error('later failure');
      }), /not authorized/);
      assert.equal(store.db.isTransaction, false);
      assert.equal(store.db.prepare('SELECT count(*) n FROM attempts').get().n, 1);
      assert.throws(() => store.db.prepare('SELECT command_token()').get(), /managed transaction/);
    }
  }
  store.transaction(db => {
    assert.equal(db.setAuthorizer, undefined);
    assert.equal(db.close, undefined);
    db.exec("SAVEPOINT inner_write; INSERT INTO attempts(id) VALUES('discard'); ROLLBACK TO inner_write; RELEASE inner_write");
    db.exec("INSERT INTO attempts(id) VALUES('kept')");
  });
  assert.deepEqual(store.db.prepare('SELECT id FROM attempts ORDER BY id').all().map(r => r.id), ['job', 'kept']);
});

test('implicit rollback and stale command statements cannot escape managed ownership', t => {
  const { store } = fixture(t);
  for (const method of ['exec', 'run', 'get', 'all']) {
    assert.throws(() => store.transaction(db => {
      const sql = "INSERT INTO attempts(id) VALUES('escaped') RETURNING id";
      const write = db.prepare(sql);
      assert.throws(() => db.exec("INSERT OR ROLLBACK INTO attempts(id) VALUES('job')"), /UNIQUE/);
      if (method === 'exec') db.exec(sql);
      else write[method]();
    }), /ownership lost/);
    assert.equal(store.db.isTransaction, false);
    assert.equal(store.db.prepare('SELECT count(*) n FROM attempts').get().n, 1);
  }
  let oldCommand, oldStatement;
  store.transaction(db => {
    oldCommand = db;
    oldStatement = db.prepare("INSERT INTO attempts(id) VALUES('stale')");
  });
  for (const use of [() => oldCommand.exec("INSERT INTO attempts(id) VALUES('stale')"), () => oldStatement.run()]) {
    assert.throws(use, /ownership lost/);
    assert.throws(() => store.transaction(use), /ownership lost/);
  }
  assert.equal(store.db.prepare('SELECT count(*) n FROM attempts').get().n, 1);
});

test('clock initialization failure rolls back and releases the writer for subsequent commands', t => {
  const { path, store } = fixture(t);
  let fail = true;
  const failing = openPrototype(path, { clock() { if (fail) throw new Error('clock unavailable'); return 100; } });
  try {
    assert.throws(() => failing.transaction(() => assert.fail('callback must not run')), /clock unavailable/);
    assert.equal(failing.db.isTransaction, false);
    assert.throws(() => failing.db.prepare('SELECT command_token()').get(), /managed transaction/);
    store.transaction(db => db.exec("INSERT INTO attempts(id) VALUES('other-writer')"));
    fail = false;
    failing.transaction(db => db.exec("INSERT INTO attempts(id) VALUES('recovered')"));
    assert.equal(store.db.prepare('SELECT count(*) n FROM attempts').get().n, 3);
  } finally { failing.close(); }
});

test('unregistered direct SQL connection fails closed on byte and transaction functions', t => {
  const { path } = fixture(t);
  const raw = new DatabaseSync(path);
  try {
    raw.exec('PRAGMA foreign_keys=ON');
    assert.throws(() => parent(raw), /unknown function|no such function/);
  } finally { raw.close(); }
});

test('WAL readers retain a snapshot, writers serialize, backup restores exact committed bytes', async t => {
  const { store, open, dir } = fixture(t);
  complete(store);
  const reader = open();
  reader.db.exec('BEGIN');
  assert.equal(reader.db.prepare('SELECT count(*) n FROM attempts').get().n, 1);
  store.transaction(db => db.exec("INSERT INTO attempts(id) VALUES('second')"));
  assert.equal(reader.db.prepare('SELECT count(*) n FROM attempts').get().n, 1);
  reader.db.exec('COMMIT');
  assert.equal(reader.db.prepare('SELECT count(*) n FROM attempts').get().n, 2);
  store.transaction(() => assert.throws(() => reader.transaction(() => {}), /locked/));
  await backup(store.db, join(dir, 'backup.sqlite'));
  const restored = openPrototype(join(dir, 'backup.sqlite'));
  try {
    assert.deepEqual(Buffer.from(restored.db.prepare('SELECT canonical_bytes FROM bundles').get().canonical_bytes), bytes);
    assert.deepEqual(restored.db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(restored.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(restored.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(restored.db.prepare('PRAGMA synchronous').get().synchronous, 2);
  } finally { restored.close(); }
});

test('ownership: competing claims fence stale workers before dispatch and after replacement', t => {
  const { store, open, time } = fixture(t);
  const competitor = open();
  const old = claim(store, 'job', 'old', 100);
  assert.equal(claim(competitor, 'job', 'new', 100), undefined);
  time(200);
  assert.equal(start(store, old), false);
  const replacement = claim(competitor, 'job', 'new', 100);
  assert.equal(replacement.epoch, old.epoch + 1);
  assert.equal(start(store, old), false);
  assert.equal(start(competitor, replacement), true);
  assert.equal(finish(store, old, Buffer.from('stale')), false);
  assert.equal(finish(competitor, replacement, Buffer.from('result')), true);
  assert.equal(finish(competitor, replacement, Buffer.from('duplicate')), false);
  assert.equal(claim(store, 'job', 'third', 100), undefined);
});

test('lease predicates use one command timestamp even when the clock advances on each read', t => {
  const { store, path } = fixture(t);
  store.db.exec("INSERT INTO attempts(id) VALUES('recover-clock')");
  let now = 100;
  const advancing = openPrototype(path, { clock: () => now++ });
  try {
    const short = claim(advancing, 'job', 'short', 1); // time 100
    assert.ok(short);
    assert.equal(now, 101);
    assert.equal(start(advancing, short), false); // exactly expires, time 101
    const replacement = claim(advancing, 'job', 'replacement', 3); // time 102
    assert.ok(replacement);
    assert.equal(start(advancing, replacement), true); // time 103
    assert.equal(finish(advancing, replacement, Buffer.from('done')), true); // time 104
    assert.equal(finish(advancing, replacement, Buffer.from('duplicate')), false); // time 105
    const interrupted = claim(advancing, 'recover-clock', 'interrupted', 2); // time 106
    assert.equal(start(advancing, interrupted), true); // time 107
    assert.equal(finish(advancing, interrupted, Buffer.from('late')), false); // time 108
    assert.equal(recover(advancing), 1); // time 109
    assert.equal(now, 110);
  } finally { advancing.close(); }
});

test('model boundary: unrelated writes progress during overlapping calls and expiry records permanent uncertainty', async t => {
  const { store, open, time } = fixture(t);
  const second = open();
  store.db.exec("INSERT INTO attempts(id) VALUES('parallel')");
  const a = claim(store, 'job', 'a', 100);
  const b = claim(second, 'parallel', 'b', 100);
  assert.equal(start(store, a), true);
  assert.equal(start(second, b), true);
  let release;
  const network = new Promise(resolve => { release = resolve; });
  store.transaction(db => db.exec("INSERT INTO attempts(id) VALUES('during-network')"));
  assert.equal(store.db.isTransaction, false);
  assert.equal(second.db.isTransaction, false);
  assert.equal(finish(second, b, Buffer.from('parallel result')), true);
  time(200);
  assert.equal(finish(store, a, Buffer.from('late result')), false);
  assert.equal(recover(second), 1);
  release(); await network;
  assert.equal(recover(store), 0);
  assert.equal(start(store, a), false);
  assert.equal(claim(store, 'job', 'retry', 100), undefined);
  const row = store.db.prepare("SELECT * FROM attempts WHERE id='job'").get();
  assert.equal(row.state, 'outcome_unknown'); assert.equal(row.calls, 1); assert.equal(row.result, null);
  assert.throws(() => store.db.exec("UPDATE attempts SET state='claimed',calls=0,owner='x',expires_at=400 WHERE id='job'"), /invalid attempt transition/);
});

for (const boundary of ['claimed','started','uncommitted']) {
  test(`SIGKILL recovery: ${boundary}`, async t => {
    const { store, path, open, time } = fixture(t);
    store.close();
    const child = fork(new URL('./sqlite-prototype/crash-worker.mjs', import.meta.url), [path, boundary], { stdio: ['ignore','ignore','pipe','ipc'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(([code]) => { throw new Error(`child exited ${code}: ${stderr}`); })
    ]);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    time(1000);
    const restarted = open();
    if (boundary === 'started') {
      assert.equal(recover(restarted), 1);
      assert.equal(claim(restarted, 'job', 'restart', 100), undefined);
    } else {
      assert.equal(recover(restarted), 0);
      assert.ok(claim(restarted, 'job', 'restart', 100));
    }
    assert.equal(restarted.db.prepare("SELECT count(*) n FROM attempts WHERE id='rolled-back'").get().n, 0);
  });
}

test('mutable completeness: every command validates its final head; earlier validation cannot cover later events', t => {
  const { store } = fixture(t);
  const append = db => db.exec("INSERT INTO stream_events(scope,sequence,state) VALUES('lineage',1,'open')");
  const validate = (db, head) => db.prepare("INSERT INTO stream_validations(scope,head) VALUES('lineage',?)").run(head);
  assert.throws(() => store.transaction(append), /FOREIGN KEY/);
  store.transaction(db => { append(db); validate(db, 1); });
  assert.throws(() => store.transaction(db => {
    db.exec("INSERT INTO stream_events(scope,sequence,state) VALUES('lineage',2,'closed')");
  }), /FOREIGN KEY/);
  assert.throws(() => store.transaction(db => {
    db.exec("INSERT INTO stream_events(scope,sequence,state) VALUES('lineage',2,'open')");
    validate(db, 2);
    db.exec("INSERT INTO stream_events(scope,sequence,state) VALUES('lineage',3,'closed')");
  }), /invalid stream append/);
  store.transaction(db => {
    db.exec("INSERT INTO stream_events(scope,sequence,state) VALUES('lineage',2,'closed')"); validate(db, 2);
  });
  assert.throws(() => store.transaction(db => {
    db.exec("INSERT INTO stream_events(scope,sequence,state) VALUES('lineage',3,'open')");
  }), /invalid stream append/);
});
