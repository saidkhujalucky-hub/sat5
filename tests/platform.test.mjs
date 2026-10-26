import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {catalog,refs,lessonForRef} from '../server/questions.mjs';
import {openStore} from '../server/store.mjs';
import {billing} from '../server/billing.mjs';
const dir=mkdtempSync(resolve(tmpdir(),'sat-v2-')),dbpath=resolve(dir,'test.sqlite'),fixture=resolve(dir,'questions.json');
// Deliberately artificial HTTP fixtures. Never shipped as SAT content or used outside NODE_ENV=test.
writeFileSync(fixture,JSON.stringify(Object.fromEntries([...refs.keys()].map(id=>[id,{type:'mcq',stem:'TEST FIXTURE — choose A.',stimulus:'',answerOptions:['A','B','C','D'].map(content=>({content})),correct_answer:['A'],rationale:'TEST FIXTURE: the subject is singular, so choose A.'}]))));
let child,base,token,uid,store;
async function req(path,method='GET',body,bearer=token){const r=await fetch(base+'/api'+path,{method,headers:{'Content-Type':'application/json',...(bearer?{Authorization:'Bearer '+bearer}:{})},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,data:await r.json()};}
async function ok(path,method='GET',body,bearer=token){const r=await req(path,method,body,bearer);assert.ok(r.status<300,JSON.stringify(r));return r.data;}
async function approve(id){const b=billing(store,{PAYMENT_MODE:'manual'});return b.approveManual(id);}
before(async()=>{
 child=spawn(process.execPath,['server/index.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,NODE_ENV:'test',PORT:'0',DB_PATH:dbpath,MONGODB_URI:'',PAYMENT_MODE:'manual',QUESTION_FIXTURE:fixture,ALLOWED_ORIGINS:'https://frontend.example'},stdio:['ignore','pipe','pipe']});
 base=await new Promise((resolve,reject)=>{child.stdout.on('data',c=>{const m=c.toString().match(/http:\/\/localhost:(\d+)/);if(m)resolve('http://localhost:'+m[1]);});child.stderr.on('data',c=>{if(!c.toString().includes('ExperimentalWarning')&&!c.toString().includes('trace-warnings'))process.stderr.write(c);});child.on('exit',code=>reject(Error('Server exit '+code)));setTimeout(()=>reject(Error('Startup timeout')),10000).unref();});
 store=await openStore({DB_PATH:dbpath});const r=await ok('/auth/register','POST',{email:'learner@example.com',name:'Learner',password:'a-strong-test-password'},'');token=r.token;uid=r.user.id;
});
after(async()=>{child?.kill();await store?.close();setTimeout(()=>rmSync(dir,{recursive:true,force:true}),250).unref();});

test('accounts, CORS, source removal and private assets',async()=>{
 assert.equal((await req('/progress','GET',undefined,'')).status,401);
 const login=await ok('/auth/login','POST',{email:'learner@example.com',password:'a-strong-test-password'});assert.equal(login.user.id,uid);assert.notEqual(login.token,token);
 assert.equal((await req('/auth/login','POST',{email:'learner@example.com',password:'wrong'})).status,401);
 assert.equal((await req('/auth/register','POST',{email:'learner@example.com',name:'x',password:'another-long-password'})).status,409);
 assert.equal((await fetch(base+'/api/health',{headers:{Origin:'https://malicious.example'}})).status,403);
 for(const path of ['/official-variants.json','/questions.json','/app.js','/engine.js','/server/private/official-variants.json','/data/sat.sqlite','/.env'])assert.equal((await fetch(base+path)).status,404,path);
 assert.equal((await req('/attempts','POST',{variant:1})).status,410);
 const source=readFileSync(new URL('../public/official.js',import.meta.url),'utf8');assert.ok(source.includes('tel:+998955705566'));assert.ok(!source.includes('Авторские тренировочные варианты'));
});

test('free access is enforced on the server, no paid content in catalog or lesson index',async()=>{
 const c=await ok('/catalog');assert.equal(c.variants.length,10);assert.ok(c.variants[0].sections);assert.ok(!c.variants[1].sections);assert.equal(c.variants[1].locked,true);
 assert.equal((await req('/exams','POST',{variant:2})).status,403);
 assert.equal((await req('/plan')).status,403);assert.equal((await req('/settings','PUT',{minutes:20})).status,403);
 const ls=await ok('/lessons');assert.equal(ls.length,6);assert.ok(ls.every(l=>!l.rules&&!l.explain));assert.equal(ls.filter(l=>!l.locked).length,2);
 assert.equal((await req('/lessons/slope')).status,403);assert.equal((await req('/drills','POST',{skill:'slope'})).status,403);
 assert.equal((await ok('/lessons/linear')).id,'linear');
 const guest=await ok('/guest','POST',{},'');assert.ok(guest.token);assert.equal((await req('/exams','POST',{variant:2},guest.token)).status,401);assert.equal((await req('/billing/orders','POST',{idempotencyKey:'guest-attempt-0001'},guest.token)).status,401);
 assert.ok((await ok('/exams','POST',{variant:1},guest.token)).id);
});

test('manual orders cannot self-activate; owner approval is idempotent; cross-user orders stay private',async()=>{
 const first=await ok('/billing/orders','POST',{idempotencyKey:'initial-order-0001',price:1,days:99999});assert.equal(first.price,19000);assert.equal(first.days,30);assert.equal(first.state,0);
 assert.equal((await ok('/billing/orders','POST',{idempotencyKey:'initial-order-0001'})).id,first.id);
 assert.equal((await ok('/billing/subscription')).active,false);
 assert.equal((await req('/billing/orders/'+first.id+'/demo','POST',{success:true})).status,404);
 const other=await ok('/auth/register','POST',{email:'other@example.com',name:'Other',password:'another-long-password'});
 assert.equal((await req('/billing/orders/'+first.id,'GET',undefined,other.token)).status,404);
 const a=await approve(first.id),b=await approve(first.id);assert.equal(a.paidAt,b.paidAt);
 const sub=await ok('/billing/subscription');assert.equal(sub.active,true);assert.ok(Math.abs(sub.until-Date.now()-30*86400000)<5000);
 assert.equal((await ok('/catalog')).variants[1].locked,false);assert.ok((await ok('/catalog')).variants[1].sections);
});

test('full official-bank exam, server grading, hidden keys, routing, cross-device resume and ownership',async()=>{
 const a=await ok('/exams','POST',{variant:2}),id=a.id;
 assert.ok(a.endsAt>Date.now());const first=catalog.variants[1].sections.rw.mixed[0].id;
 const q=await ok('/exams/'+id+'/question/'+first);assert.equal(q.answers,undefined);assert.equal(q.explanation,undefined);
 await ok('/exams/'+id+'/state','PUT',{index:0,answers:{[first]:'A'}});
 const cleared=await ok('/exams/'+id+'/state','PUT',{index:0,answers:{[first]:null}});assert.equal(cleared.answers[first],undefined);
 const math=catalog.variants[1].sections.math.mixed[0].id;assert.equal((await req('/exams/'+id+'/question/'+math)).status,403);
 const other=await ok('/auth/login','POST',{email:'other@example.com',password:'another-long-password'});assert.equal((await req('/exams/'+id,'GET',undefined,other.token)).status,404);
 let current=a;
 for(let index=0;index<4;index++){
  const section=catalog.modules[index].section,qs=catalog.variants[1].sections[section][index%2?current.routing[section]:'mixed'];
  current=await ok('/exams/'+id+'/state','PUT',{index,answers:Object.fromEntries(qs.map(q=>[q.id,index===0?'A':'B'])),endsAt:Date.now()+999999999});assert.equal(current.endsAt,index===0?a.endsAt:current.endsAt);
  const oldEnd=current.endsAt;current=await ok('/exams/'+id+'/finish','POST',{index});
  const repeated=await ok('/exams/'+id+'/finish','POST',{index});assert.equal(repeated.index,current.index);assert.equal(repeated.endsAt,current.endsAt);
  if(index===0)assert.equal(current.routing.rw,'hard');
  if(index===1){assert.equal(current.stage,'break');current=await ok('/exams/'+id+'/continue','POST',{});assert.equal(current.index,2);}
 }
 assert.equal(current.stage,'done');assert.equal(current.grades.reduce((n,g)=>n+g.total,0),98);
 const review=await ok('/exams/'+id+'/question/'+first);assert.deepEqual(review.answers,['A']);assert.ok(review.explanation);
 const p=await ok('/progress');assert.ok(p.history.some(h=>h.id===id));assert.equal((await store.list('events',{userId:uid})).filter(e=>e.source==='exam:'+id).length,98);
 await ok('/progress');assert.equal((await store.list('events',{userId:uid})).filter(e=>e.source==='exam:'+id).length,98);
 const login=await ok('/auth/login','POST',{email:'learner@example.com',password:'a-strong-test-password'});assert.equal((await ok('/exams/'+id,'GET',undefined,login.token)).stage,'done');
});

test('official-bank drills, lesson completion, reason/report persistence and 1/3/7/14-day repetition',async()=>{
 await ok('/lessons/linear/complete','POST',{});
 const skill='linear',rid=uid+':'+skill;let previousIds=new Set();
 for(const[stage,days]of[[1,3],[2,7],[3,14],[4,14]]){
  await store.change('reviews',rid,r=>({...r,due:Date.now()-1000}));
  const drill=await ok('/drills','POST',{skill});assert.equal(drill.questions.length,3);
  for(let i=0;i<drill.questions.length;i++){
   const q=drill.questions[i];assert.ok(refs.has(q.id));assert.ok(!previousIds.has(q.id));previousIds.add(q.id);assert.equal(q.answers,undefined);
   const r=await ok('/drills/'+drill.id+'/answer','POST',{questionId:q.id,value:'A'});assert.equal(r.correct,true);assert.ok(r.question.method.ru.length);
   if(i===0)assert.equal((await store.get('reviews',rid)).stage,stage-1);
  }
  let r=await store.get('reviews',rid);assert.equal(r.stage,stage);assert.ok(Math.abs(r.due-Date.now()-days*86400000)<5000);
  const due=r.due;await ok('/drills/'+drill.id+'/answer','POST',{questionId:drill.questions[2].id,value:'B'});assert.equal((await store.get('reviews',rid)).due,due);
 }
 const early=await ok('/drills','POST',{skill}),due=(await store.get('reviews',rid)).due;
 for(const q of early.questions)await ok('/drills/'+early.id+'/answer','POST',{questionId:q.id,value:'A'});
 assert.equal((await store.get('reviews',rid)).due,due);
 const wrong=await ok('/drills','POST',{skill});const result=await ok('/drills/'+wrong.id+'/answer','POST',{questionId:wrong.questions[0].id,value:'B'});
 assert.equal((await store.get('reviews',rid)).stage,0);
 await ok('/reasons','POST',{eventId:result.eventId,reason:'careless'});assert.equal((await store.get('events',result.eventId)).reason,'careless');
 const report=await ok('/reports','POST',{kind:'question',materialId:wrong.questions[0].id,message:'Please check this question.'});assert.equal((await store.get('reports',report.id)).material,wrong.questions[0].id);
 assert.equal((await req('/reports','POST',{kind:'question',materialId:'fake-id',message:'Unknown question'})).status,400);
});

test('expired Premium blocks previously-created paid exams, lessons and practice; free exam stays available',async()=>{
 const a=await ok('/exams','POST',{variant:3});
 const order=(await store.list('orders',{userId:uid})).find(o=>o.state===2);await store.change('orders',order.id,o=>({...o,performTime:Date.now()-31*86400000}));
 assert.equal((await ok('/billing/subscription')).active,false);
 assert.equal((await req('/exams/'+a.id)).status,403);assert.equal((await req('/lessons/slope')).status,403);
 assert.equal((await ok('/progress')).premiumLocked,true);assert.deepEqual((await ok('/progress')).topics,[]);
 assert.ok((await ok('/exams','POST',{variant:1})).id);
});

test('Payme authentication, amounts, duplicate IDs, concurrent performs, timeout, cancellation and statement',async()=>{
 let now=1800000000000;const b=billing(store,{PAYMENT_MODE:'payme',PAYME_MERCHANT_ID:'merchant-fixture',PAYME_KEY:'private-fixture-key',FRONTEND_URL:'https://example.test/SAT/'},()=>now);
 const u={id:'billing-test',guest:false},auth='Basic '+Buffer.from('Paycom:private-fixture-key').toString('base64');
 const o=await b.order(u,'uz','payme-test-order-01');assert.ok(o.checkoutUrl.startsWith('https://checkout.paycom.uz/'));const encoded=Buffer.from(o.checkoutUrl.split('/').at(-1),'base64').toString();assert.ok(encoded.includes('a=1900000'));assert.ok(encoded.includes('https://example.test/SAT/hub.html#premium/order/'));
 const rpc=(method,params,authorization=auth)=>b.rpc({id:1,method,params},authorization);
 assert.equal((await rpc('CheckPerformTransaction',{account:{order_id:o.id},amount:1900000},'bad')).error.code,-32504);
 assert.equal((await rpc('CheckPerformTransaction',{account:{order_id:o.id},amount:19000})).error.code,-31001);
 const p={id:'provider-transaction-1',time:now,amount:1900000,account:{order_id:o.id}};
 assert.equal((await rpc('CreateTransaction',p)).result.state,1);assert.equal((await rpc('CreateTransaction',p)).result.state,1);assert.equal((await b.subscription(u.id)).active,false);
 const other=await b.order(u,'ru','payme-test-order-02');assert.equal((await rpc('CreateTransaction',{...p,account:{order_id:other.id}})).error.code,-31008);
 const results=await Promise.all([rpc('PerformTransaction',{id:p.id}),rpc('PerformTransaction',{id:p.id})]);assert.ok(results.every(r=>r.result.state===2));assert.equal(results[0].result.perform_time,results[1].result.perform_time);
 const until=(await b.subscription(u.id)).until;assert.equal(until,now+30*86400000);now+=1000;await rpc('PerformTransaction',{id:p.id});assert.equal((await b.subscription(u.id)).until,until);
 assert.equal((await rpc('CheckTransaction',{id:p.id})).result.state,2);
 const statement=await rpc('GetStatement',{from:p.time,to:p.time});assert.equal(statement.result.transactions.length,1);assert.equal(statement.result.transactions[0].id,p.id);
 assert.equal((await rpc('CancelTransaction',{id:p.id,reason:5})).result.state,-2);assert.equal((await b.subscription(u.id)).active,false);assert.equal((await rpc('CancelTransaction',{id:p.id,reason:5})).result.state,-2);
 const p2={...p,id:'provider-transaction-2',time:now,account:{order_id:other.id}};await rpc('CreateTransaction',p2);now+=43200001;assert.equal((await rpc('PerformTransaction',{id:p2.id})).error.code,-31008);assert.equal((await rpc('CheckTransaction',{id:p2.id})).result.reason,4);
 assert.throws(()=>billing(store,{PAYMENT_MODE:'demo',NODE_ENV:'production'}),/forbidden/);
});

test('SQLite v1 migration preserves accounts, sessions, original tables and is repeatable',async()=>{
 const path=resolve(dir,'v1.sqlite'),db=new DatabaseSync(path);
 db.exec("CREATE TABLE users(id TEXT,email TEXT,name TEXT,password TEXT,created INTEGER,settings TEXT);CREATE TABLE sessions(token TEXT,user_id TEXT,expires INTEGER);CREATE TABLE learned(user_id TEXT,lesson TEXT,created INTEGER);");
 db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run('old-user','old@example.com','Old','salt:key',1,'{}');db.prepare('INSERT INTO sessions VALUES(?,?,?)').run('old-token','old-user',9999999999999);db.close();
 let migrated=await openStore({DB_PATH:path});assert.equal((await migrated.get('users','old-user')).email,'old@example.com');assert.equal((await migrated.get('sessions','old-token')).userId,'old-user');await migrated.close();
 migrated=await openStore({DB_PATH:path});assert.equal((await migrated.list('users')).length,1);await migrated.close();
 const original=new DatabaseSync(path,{readOnly:true});assert.equal(original.prepare('SELECT COUNT(*) AS n FROM users').get().n,1);original.close();
});


test('demo success and cancellation are explicit and idempotent; real payment mode cannot use demo',async()=>{
 let now=1800000000000;const b=billing(store,{PAYMENT_MODE:'demo',NODE_ENV:'development'},()=>now),u={id:'demo-user',guest:false};
 const order=await b.order(u,'en','demo-success-order1');assert.equal((await b.subscription(u.id)).active,false);
 await b.demo(order.id,u.id,true);const until=(await b.subscription(u.id)).until;assert.equal(until,now+30*86400000);
 now+=1000;await b.demo(order.id,u.id,true);assert.equal((await b.subscription(u.id)).until,until);
 const failed=await b.order(u,'en','demo-cancel-order01');await b.demo(failed.id,u.id,false);assert.equal((await store.get('orders',failed.id)).state,-1);assert.equal((await b.subscription(u.id)).until,until);
 const second=await b.order(u,'en','demo-renew-order001');await b.demo(second.id,u.id,true);assert.equal((await b.subscription(u.id)).until,until+30*86400000);
 await assert.rejects(b.demo(order.id,'different-user',true),/ORDER_NOT_FOUND/);
});
