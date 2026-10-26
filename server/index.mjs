import http from 'node:http';
import { scrypt as scryptCb, randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, insertOnce } from './store.mjs';
import { billing } from './billing.mjs';
import { lessons, lessonMap } from './content.mjs';
import { catalog, refs, lessonForRef, questionService, correct, fault as fail } from './questions.mjs';
import { examService } from './exams.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),store=await openStore(),bill=billing(store),questions=questionService(),exams=examService(store,questions,bill);
const day=86400000,scrypt=promisify(scryptCb),hash=x=>createHash('sha256').update(x).digest('hex');
const origins=(process.env.ALLOWED_ORIGINS||'').split(',').map(v=>v.trim()).filter(Boolean),limits=new Map();
function limit(key,max,ms=600000){const now=Date.now(),old=limits.get(key);if(!old||old.until<now){limits.set(key,{until:now+ms,n:1});return;}if(++old.n>max)fail(429,'RATE_LIMIT');}
setInterval(()=>{for(const [k,v] of limits)if(v.until<Date.now())limits.delete(k);},60000).unref();
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
async function body(req){let raw='';for await(const c of req){raw+=c;if(Buffer.byteLength(raw)>262144)fail(413,'BODY_TOO_LARGE');}try{const d=raw?JSON.parse(raw):{};if(!d||typeof d!=='object'||Array.isArray(d))fail(400,'INVALID_JSON');return d;}catch{fail(400,'INVALID_JSON');}}
async function userOf(req,optional=false){
  const token=(req.headers.authorization||'').replace(/^Bearer /,'');
  const s=token&&await store.get('sessions',hash(token)),u=s&&s.expires>Date.now()&&await store.get('users',s.userId);
  if(!u&&!optional)fail(401,'LOGIN_REQUIRED');return u||null;
}
async function publicUser(u){return{id:u.id,email:u.email||'',name:u.name,guest:!!u.guest,settings:u.settings||{},subscription:await bill.subscription(u.id)};}
async function session(u){const token=randomBytes(32).toString('hex'),expires=Date.now()+30*day;await store.insert('sessions',{id:hash(token),userId:u.id,expires,expiresAt:new Date(expires)});return{token,user:await publicUser(u)};}
const realUser=u=>{if(u.guest)fail(401,'LOGIN_REQUIRED');};
const canLesson=async(u,id)=>{realUser(u);if(!bill.config().freeLessons.includes(id))await bill.requirePremium(u.id);};
const sorted=xs=>xs.sort((a,b)=>(b.updatedAt||b.created||b.startedAt||0)-(a.updatedAt||a.created||a.startedAt||0));
async function stats(uid){
  const ev=sorted(await store.list('events',{userId:uid})),groups=new Map();
  for(const e of ev){const key=e.lesson||e.skill;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(e);}
  return [...groups].map(([skill,items])=>{const distinct=new Set(items.map(e=>e.question)).size,n=items.length,c=items.reduce((s,e)=>s+e.correct,0),bad=items.filter(e=>!e.correct);return{skill,lessonId:items.find(e=>e.lesson)?.lesson||null,solved:n,distinct,correct:c,accuracy:Math.round(c/n*100),status:distinct<3?'insufficient':c/n<.75?'weak':'improving',priority:bad.reduce((s,e)=>s+Math.exp(-(Date.now()-e.created)/(7*day)),0),lastError:bad[0]?.created||null};}).sort((a,b)=>b.priority-a.priority);
}
async function progress(u){
  const attempts=sorted(await store.list('exams',{userId:u.id}));
  // Reconcile deterministic event IDs after a restart halfway through recording.
  for(const a of attempts.filter(a=>a.stage==='done'))await exams.ensureEvents(a);
  const premium=(await bill.subscription(u.id)).active;
  return{history:attempts.map(exams.summary),learned:await store.list('learned',{userId:u.id}),topics:premium?await stats(u.id):[],reviews:premium?(await store.list('reviews',{userId:u.id})).sort((a,b)=>a.due-b.due):[],premiumLocked:!premium,legacyHistory:[]};
}
async function plan(u){
  realUser(u);await bill.requirePremium(u.id);
  const p=await progress(u),mins=u.settings?.minutes||20,remaining=u.settings?.examDate?Math.ceil((Date.parse(u.settings.examDate+'T00:00:00+05:00')-Date.now())/day):null;
  const due=p.reviews.filter(r=>r.due<=Date.now()),weak=p.topics.filter(t=>t.lessonId&&t.status==='weak');
  const ids=[...new Set([...due.map(r=>r.skill),...weak.map(t=>t.lessonId),...lessons.filter(l=>!p.learned.some(v=>v.lesson===l.id)).map(l=>l.id)])];
  return{minutes:mins,daysRemaining:remaining,expired:remaining!==null&&remaining<0,tasks:ids.slice(0,Math.max(1,Math.floor(mins/10))).map(id=>({lesson:id,minutes:10,due:due.some(r=>r.skill===id)}))};
}
async function recordDrill(row){
  const id=row.userId+':'+row.skill;
  for(const[qid,result]of Object.entries(row.results)){
    const ref=refs.get(qid);
    await insertOnce(store,'events',{id:row.id+':'+qid,userId:row.userId,question:qid,skill:ref.topic,lesson:row.skill,correct:result.correct?1:0,created:result.created,source:'drill:'+row.id,reason:null});
  }
  let previous=await store.get('reviews',id);
  if(!previous){await insertOnce(store,'reviews',{id,userId:row.userId,skill:row.skill,stage:0,due:Date.now()+day,lastEvent:0});previous=await store.get('reviews',id);}
  const wrong=Object.values(row.results).filter(r=>!r.correct),lastWrong=Math.max(0,...wrong.map(r=>r.created));
  if(lastWrong>(previous.lastEvent||0))await store.change('reviews',id,r=>lastWrong>(r.lastEvent||0)?{...r,stage:0,due:lastWrong+day,lastEvent:lastWrong}:r);
  if(Object.keys(row.results).length===row.questions.length){
    await store.change('reviews',id,r=>{
      if(r.lastSession===row.id||r.lastCompletedAt>=row.completedAt)return r;
      const ok=row.questions.length>=2&&Object.values(row.results).every(v=>v.correct),advance=ok&&r.due<=row.created;
      const stage=ok?(advance?Math.min(4,r.stage+1):r.stage):0;
      return{...r,stage,due:ok&&!advance?r.due:row.completedAt+[1,3,7,14,14][stage]*day,lastSession:row.id,lastCompletedAt:row.completedAt};
    });
  }
}
async function drillView(row){
  const qs=await Promise.all(row.questions.map(id=>questions.load(id)));
  return{id:row.id,skill:row.skill,questions:qs.map(questions.safe),answers:row.answers,results:row.results,reviewed:Object.fromEntries(qs.filter(q=>row.results[q.id]).map(q=>[q.id,{...row.results[q.id],question:questions.review(q),eventId:row.id+':'+q.id}]))};
}

async function api(req,res,path){
  const method=req.method,d=['POST','PUT'].includes(method)?await body(req):{};
  if(path==='/health')return json(res,200,{ok:true,payments:bill.config().mode,database:store.kind});
  if(path==='/billing/config'&&method==='GET')return json(res,200,bill.config());
  if(path==='/payments/payme'&&method==='POST')return json(res,200,await bill.rpc(d,req.headers.authorization));
  if(path==='/catalog'&&method==='GET'){
    const u=await userOf(req,true),premium=u&&(await bill.subscription(u.id)).active;
    return json(res,200,{modules:catalog.modules,variants:catalog.variants.map(v=>({id:v.id,locked:v.id!==1&&!premium,...(v.id===1||premium?{sections:v.sections}:{})}))});
  }
  if(path==='/guest'&&method==='POST'){
    limit('guest:'+req.socket.remoteAddress,30);
    const current=await userOf(req,true);if(current)return json(res,200,{user:await publicUser(current)});
    const u={id:randomUUID(),name:'Guest',guest:true,settings:{},created:Date.now()};await store.insert('users',u);return json(res,201,await session(u));
  }
  if(path==='/auth/register'&&method==='POST'){
    limit('auth:'+req.socket.remoteAddress,30);
    const email=String(d.email||'').trim().toLowerCase(),name=String(d.name||'').trim();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||name.length<1||name.length>80||typeof d.password!=='string'||d.password.length<10||d.password.length>128)fail(400,'INVALID_REGISTRATION');
    const salt=randomBytes(16).toString('hex'),key=(await scrypt(d.password,salt,64)).toString('hex');
    const u={id:randomUUID(),email,name,password:salt+':'+key,guest:false,settings:{},created:Date.now()};
    try{await store.insert('users',u);}catch(e){if(e.code===11000||(String(e.code).includes('SQLITE_CONSTRAINT') || [1555,2067].includes(e.errcode)))fail(409,'EMAIL_EXISTS');throw e;}
    return json(res,201,await session(u));
  }
  if(path==='/auth/login'&&method==='POST'){
    limit('auth:'+req.socket.remoteAddress,30);
    if(typeof d.password!=='string'||d.password.length>128)fail(400,'INVALID_LOGIN');
    const u=(await store.list('users',{email:String(d.email||'').trim().toLowerCase(),guest:false}))[0];
    const[salt,key]=(u?.password||'00000000000000000000000000000000:'+'0'.repeat(128)).split(':');
    const candidate=await scrypt(d.password,salt,64);if(!u||!timingSafeEqual(candidate,Buffer.from(key,'hex')))fail(401,'INVALID_LOGIN');
    return json(res,200,await session(u));
  }
  const u=await userOf(req);limit('api:'+u.id,1500,60000);
  if(path==='/auth/me'&&method==='GET')return json(res,200,await publicUser(u));
  if(path==='/auth/logout'&&method==='POST'){await store.remove('sessions',hash(req.headers.authorization.replace(/^Bearer /,'')));return json(res,200,{ok:true});}
  if(path==='/billing/subscription'&&method==='GET')return json(res,200,await bill.subscription(u.id));
  if(path==='/billing/orders'&&method==='GET'){realUser(u);return json(res,200,sorted(await store.list('orders',{userId:u.id})).map(bill.view));}
  if(path==='/billing/orders'&&method==='POST'){limit('orders:'+u.id,30);return json(res,201,await bill.order(u,d.lang,d.idempotencyKey));}
  const om=path.match(/^\/billing\/orders\/([\w-]+)(?:\/(demo))?$/);
  if(om){realUser(u);if(om[2]&&method==='POST')return json(res,200,await bill.demo(om[1],u.id,d.success===true));if(method!=='GET')fail(405,'METHOD_NOT_ALLOWED');const o=await store.get('orders',om[1]);if(!o||o.userId!==u.id)fail(404,'ORDER_NOT_FOUND');return json(res,200,{...bill.view(o),subscription:await bill.subscription(u.id)});}
  if(path==='/exams'&&method==='POST')return json(res,201,await exams.create(u,Number(d.variant)));
  const em=path.match(/^\/exams\/([\w-]+)(?:\/(state|finish|continue|question\/([\w-]+)))?$/);
  if(em){
    if(!em[2]&&method==='GET')return json(res,200,await exams.get(u,em[1]));
    if(em[2]==='state'&&method==='PUT')return json(res,200,await exams.update(u,em[1],d));
    if(em[2]==='finish'&&method==='POST')return json(res,200,await exams.finish(u,em[1],d.index));
    if(em[2]==='continue'&&method==='POST')return json(res,200,await exams.resume(u,em[1]));
    if(em[3]&&method==='GET')return json(res,200,await exams.question(u,em[1],em[3]));
    fail(405,'METHOD_NOT_ALLOWED');
  }
  realUser(u);
  if(path==='/progress'&&method==='GET')return json(res,200,await progress(u));
  if(path==='/plan'&&method==='GET')return json(res,200,await plan(u));
  if(path==='/settings'&&method==='PUT'){
    await bill.requirePremium(u.id);const minutes=Number(d.minutes);
    if(!Number.isInteger(minutes)||minutes<10||minutes>180||d.examDate&&(!/^\d{4}-\d{2}-\d{2}$/.test(d.examDate)||!Number.isFinite(Date.parse(d.examDate))||new Date(d.examDate).toISOString().slice(0,10)!==d.examDate))fail(400,'INVALID_SETTINGS');
    await store.change('users',u.id,v=>({...v,settings:{minutes,examDate:d.examDate||null,lang:['ru','uz','en'].includes(d.lang)?d.lang:'ru'}}));return json(res,200,{ok:true});
  }
  if(path==='/lessons'&&method==='GET'){
    const premium=(await bill.subscription(u.id)).active;
    return json(res,200,lessons.map(({explain,rules,example,mistakes,...rest})=>({...rest,locked:!premium&&!bill.config().freeLessons.includes(rest.id)})));
  }
  const lm=path.match(/^\/lessons\/([a-z]+)(?:\/(complete))?$/);
  if(lm){
    const l=lessonMap.get(lm[1]);if(!l)fail(404,'LESSON_NOT_FOUND');await canLesson(u,l.id);
    if(lm[2]&&method==='POST'){await insertOnce(store,'learned',{id:u.id+':'+l.id,userId:u.id,lesson:l.id,created:Date.now()});await insertOnce(store,'reviews',{id:u.id+':'+l.id,userId:u.id,skill:l.id,stage:0,due:Date.now()+day});return json(res,200,{ok:true});}
    if(!lm[2]&&method==='GET')return json(res,200,l);fail(405,'METHOD_NOT_ALLOWED');
  }
  if(path==='/drills'&&method==='POST'){
    const skill=String(d.skill||'');if(!lessonMap.has(skill))fail(404,'LESSON_NOT_READY');await canLesson(u,skill);
    const previous=await store.list('drills',{userId:u.id}),used=new Set(previous.flatMap(v=>v.questions));
    const selected=[];
    for(const ref of refs.values()){
      if(lessonForRef(ref)!==skill||used.has(ref.id))continue;
      // The grammar topic is broader than this lesson: choose actual agreement items.
      if(skill==='agreement'){const q=await questions.load(ref.id);if(!/\b(subject|singular|plural|agreement)\b/i.test(q.explanation))continue;}
      selected.push(ref.id);if(selected.length===3)break;
    }
    if(!selected.length)return json(res,200,{skill,questions:[],exhausted:true});
    const loaded=await Promise.all(selected.map(id=>questions.load(id)));
    const row={id:randomUUID(),userId:u.id,skill,questions:selected,answers:{},results:{},created:Date.now()};await store.insert('drills',row);
    return json(res,201,{id:row.id,skill,questions:loaded.map(questions.safe),results:{},answers:{},reviewed:{},exhausted:false});
  }
  const dm=path.match(/^\/drills\/([\w-]+)(?:\/(answer))?$/);
  if(dm){
    let row=await store.get('drills',dm[1]);if(!row||row.userId!==u.id)fail(404,'DRILL_NOT_FOUND');await canLesson(u,row.skill);
    if(dm[2]&&method==='POST'){
      if(!row.questions.includes(d.questionId)||typeof d.value!=='string'||d.value.length>24)fail(400,'INVALID_ANSWER');
      const q=await questions.load(d.questionId);if(q.type==='mcq'&&!['A','B','C','D'].includes(d.value))fail(400,'INVALID_ANSWER');
      row=await store.change('drills',row.id,current=>{if(!current.results[q.id]){current.answers[q.id]=d.value;current.results[q.id]={correct:correct(q,d.value),value:d.value,created:Date.now()};if(Object.keys(current.results).length===current.questions.length)current.completedAt=Date.now();}return current;});
      await recordDrill(row);return json(res,200,{...row.results[q.id],question:questions.review(q),eventId:row.id+':'+q.id,complete:!!row.completedAt});
    }
    if(!dm[2]&&method==='GET'){await recordDrill(row);return json(res,200,await drillView(row));}fail(405,'METHOD_NOT_ALLOWED');
  }
  if(path==='/reasons'&&method==='POST'){
    if(!['topic','careless','time','guessed'].includes(d.reason))fail(400,'INVALID_REASON');const event=await store.get('events',String(d.eventId));if(!event||event.userId!==u.id)fail(404,'EVENT_NOT_FOUND');await store.change('events',event.id,v=>({...v,reason:d.reason}));return json(res,200,{ok:true});
  }
  if(path==='/reports'&&method==='POST'){
    limit('reports:'+u.id,20);const message=String(d.message||'').trim();
    if(message.length<5||message.length>3000||!(d.kind==='lesson'&&lessonMap.has(d.materialId)||d.kind==='question'&&refs.has(d.materialId)))fail(400,'INVALID_REPORT');
    const id=randomUUID();await store.insert('reports',{id,userId:u.id,kind:d.kind,material:d.materialId,message,created:Date.now()});return json(res,201,{ok:true,id});
  }
  if(path.startsWith('/attempts')||path.startsWith('/legacy')||path==='/meta')fail(410,'REMOVED');
  fail(404,'NOT_FOUND');
}
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8','.svg':'image/svg+xml'};
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('X-Frame-Options','DENY');
  const origin=req.headers.origin,same=origin===(process.env.PUBLIC_ORIGIN||'http://'+req.headers.host);
  if(origin&&!same&&!origins.includes(origin)){json(res,403,{error:'ORIGIN_DENIED'});return;}
  if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');res.setHeader('Access-Control-Allow-Methods','GET, POST, PUT, OPTIONS');}
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  try{
    const path=new URL(req.url,'http://localhost').pathname;
    if(path.startsWith('/api/'))return await api(req,res,path.slice(4));
    if(!['GET','HEAD'].includes(req.method))fail(405,'METHOD_NOT_ALLOWED');
    const file=resolve(root,'public','.'+decodeURIComponent(path==='/'?'/index.html':path));
    if(!file.startsWith(resolve(root,'public')+'/')||!existsSync(file)||!statSync(file).isFile())fail(404,'NOT_FOUND');
    res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:readFileSync(file));
  }catch(e){if(!e.status)console.error(e);json(res,e.status||500,{error:e.status?e.message:'SERVER_ERROR'});}
});
const portFlag=process.argv.indexOf('--port');
const port=Number(portFlag>=0?process.argv[portFlag+1]:process.env.PORT||3000);
server.listen(port,process.env.HOST||'0.0.0.0',()=>console.log(`SAT Practice listening on http://localhost:${server.address().port}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(async()=>{await store.close();process.exit(0);}));
