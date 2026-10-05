import { writeFileSync } from 'node:fs';
import { openSqlite, migrateSqlite } from '@rubrist/db/sqlite';
const [path,directory,marker,point]=process.argv.slice(2);
const db=openSqlite(path!);
function pause(name:string) {
  if(name===point) {
    writeFileSync(marker!,name);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
  }
  return 1;
}
db.function('migration_checkpoint',value=>pause(String(value)));
migrateSqlite(db,directory!);
pause('after-commit');
db.close();
