import {DatabaseSync} from 'node:sqlite';
import {openStore,insertOnce} from '../server/store.mjs';
import {resolve} from 'node:path';
if(!process.env.MONGODB_URI||!process.argv[2])throw Error('Usage: set MONGODB_URI and run node --env-file-if-exists=.env scripts/migrate-to-mongo.mjs PATH_TO_SQLITE');
// Prepare the additive v2 migration in the source SQLite file, preserving its original tables.
const source=await openStore({...process.env,MONGODB_URI:'',DB_PATH:resolve(process.argv[2])});await source.close();
const db=new DatabaseSync(resolve(process.argv[2]),{readOnly:true}),target=await openStore();
try{
 let count=0;
 for(const row of db.prepare('SELECT collection,id,body FROM documents ORDER BY collection,id').all()){
  const doc=JSON.parse(row.body),old=await target.get(row.collection,row.id);
  if(old){if(JSON.stringify(old)!==JSON.stringify(doc))throw Error('Conflicting record; nothing overwritten: '+row.collection+'/'+row.id);continue;}
  if(row.collection==='sessions')doc.expiresAt=new Date(doc.expires);
  await insertOnce(target,row.collection,doc);count++;
 }
 console.log('Copied records: '+count+'. Keep the original SQLite backup.');
}finally{db.close();await target.close();}
