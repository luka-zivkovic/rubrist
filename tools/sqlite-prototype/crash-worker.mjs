import { openPrototype } from './database.mjs';
import { claim, start } from './ownership.mjs';
const store = openPrototype(process.argv[2], { clock: () => 100 });
const ownership = claim(store, 'job', 'crashed-worker', 100);
if (process.argv[3] === 'started') start(store, ownership);
if (process.argv[3] === 'uncommitted') {
  store.db.exec('BEGIN IMMEDIATE');
  store.db.prepare("INSERT INTO attempts(id) VALUES('rolled-back')").run();
}
process.send({ ready: true });
setInterval(() => {}, 1000);
