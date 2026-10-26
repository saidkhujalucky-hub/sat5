import { randomUUID } from 'node:crypto';
import { catalog, correct, fault, numberValue } from './questions.mjs';
import { insertOnce } from './store.mjs';

const DAY=86400000;
export const variantOf = a => catalog.variants.find(v=>v.id===a.test);
export const moduleRefs = (a,index=a.index) => {
  const section=catalog.modules[index].section;
  return variantOf(a).sections[section][index%2?a.routing[section]:'mixed'];
};
export function examService(store,questions,bill) {
  async function check(user,variant) { if(!Number.isInteger(variant)||!catalog.variants.some(v=>v.id===variant))fault(400,'INVALID_VARIANT');if(variant!==1){if(user.guest)fault(401,'LOGIN_REQUIRED');await bill.requirePremium(user.id);} }
  async function create(user,variant) {
    await check(user,variant);
    const existing=(await store.list('exams',{userId:user.id})).filter(a=>a.test===variant&&a.stage!=='done').sort((a,b)=>b.startedAt-a.startedAt)[0];
    if(existing)return existing;
    const a={id:randomUUID(),userId:user.id,test:variant,stage:'module',index:0,answers:{},flags:{},crossed:{},routing:{rw:null,math:null},grades:[],startedAt:Date.now(),endsAt:Date.now()+catalog.modules[0].seconds*1000,breakEnd:null,current:0,updatedAt:Date.now()};
    await store.insert('exams',a);return a;
  }
  async function get(user,id) {
    const a=await store.get('exams',id);if(!a||a.userId!==user.id)fault(404,'ATTEMPT_NOT_FOUND');await check(user,a.test);return a;
  }
  async function update(user,id,d) {
    await get(user,id);
    return store.change('exams',id,a=>{
      if(a.stage!=='module')return a;
      if(d.index!==a.index)fault(409,'STALE_MODULE');
      if(Date.now()>a.endsAt)fault(409,'MODULE_EXPIRED');
      const refs=moduleRefs(a);
      for(const ref of refs){
        if(d.answers&&Object.hasOwn(d.answers,ref.id)){
          const val=d.answers[ref.id];
          if(val===null||val==='')delete a.answers[ref.id];
          else if(typeof val==='string'&&val.length<=24&&(['A','B','C','D'].includes(val)||Number.isFinite(numberValue(val))))a.answers[ref.id]=val;
          else fault(400,'INVALID_ANSWER');
        }
        if(d.flags&&Object.hasOwn(d.flags,ref.id))a.flags[ref.id]=!!d.flags[ref.id];
        if(d.crossed&&Object.hasOwn(d.crossed,ref.id))a.crossed[ref.id]=Array.isArray(d.crossed[ref.id])?d.crossed[ref.id].filter(x=>['A','B','C','D'].includes(x)).slice(0,4):[];
      }
      a.current=Math.max(0,Math.min(Number.isInteger(d.current)?d.current:0,refs.length-1));a.updatedAt=Date.now();return a;
    });
  }
  async function finish(user,id,index) {
    const before=await get(user,id);
    if(before.stage!=='module'||before.index!==index)return before;
    const refs=moduleRefs(before),loaded=new Map();
    // Fetch before committing: a failed content request never loses the attempt.
    for(let i=0;i<refs.length;i+=4)await Promise.all(refs.slice(i,i+4).map(async r=>loaded.set(r.id,await questions.load(r.id))));
    const next=await store.change('exams',id,a=>{
      if(a.stage!=='module'||a.index!==index)return a;
      const items=refs.map(r=>({id:r.id,correct:correct(loaded.get(r.id),a.answers[r.id])}));
      const grade={correct:items.filter(v=>v.correct).length,total:refs.length,items};a.grades[index]=grade;
      if(index%2===0)a.routing[catalog.modules[index].section]=grade.correct>=(index===0?19:16)?'hard':'easy';
      a.current=0;a.updatedAt=Date.now();
      if(index===3){a.stage='done';a.endsAt=null;a.completedAt=Date.now();}
      else if(index===1){a.stage='break';a.endsAt=null;a.breakEnd=Date.now()+600000;}
      else{a.index++;a.endsAt=Date.now()+catalog.modules[a.index].seconds*1000;}
      return a;
    });
    if(next.stage==='done')await ensureEvents(next);
    return next;
  }
  async function resume(user,id) {
    await get(user,id);
    return store.change('exams',id,a=>a.stage==='break'?{...a,index:2,stage:'module',endsAt:Date.now()+catalog.modules[2].seconds*1000,breakEnd:null,current:0,updatedAt:Date.now()}:a);
  }
  async function ensureEvents(a) {
    if(a.stage!=='done'||a.eventsRecorded)return;
    for(let index=0;index<4;index++)for(const ref of moduleRefs(a,index)){
      const event={id:a.id+':'+ref.id,userId:a.userId,question:ref.id,skill:ref.topic,lesson:questionsLesson(ref),correct:a.grades[index].items.find(i=>i.id===ref.id)?.correct?1:0,created:a.completedAt,source:'exam:'+a.id,reason:null};
      await insertOnce(store,'events',event);
      if(!event.correct&&event.lesson){
        const id=a.userId+':'+event.lesson,old=await store.get('reviews',id);
        if(!old)await insertOnce(store,'reviews',{id,userId:a.userId,skill:event.lesson,stage:0,due:a.completedAt+DAY,lastEvent:a.completedAt});
        else if((old.lastEvent||0)<a.completedAt)await store.change('reviews',id,r=>(r.lastEvent||0)<a.completedAt?{...r,stage:0,due:a.completedAt+DAY,lastEvent:a.completedAt}:r);
      }
    }
    await store.change('exams',a.id,current=>({...current,eventsRecorded:true}));
  }
  async function question(user,id,qid) {
    const a=await get(user,id),allowed=a.stage==='done'?catalog.modules.flatMap((_,i)=>moduleRefs(a,i)):a.stage==='module'?moduleRefs(a):[];
    if(!allowed.some(q=>q.id===qid))fault(403,'QUESTION_NOT_IN_MODULE');
    const q=await questions.load(qid);return a.stage==='done'?questions.review(q):questions.safe(q);
  }
  function summary(a) {
    const result={id:a.id,variant:a.test,stage:a.stage,date:a.completedAt||a.startedAt};
    if(a.stage==='done'){
      const score=section=>{const idx=section==='rw'?[0,1]:[2,3],c=idx.reduce((s,i)=>s+a.grades[i].correct,0),n=idx.reduce((s,i)=>s+a.grades[i].total,0);return Math.min(a.routing[section]==='hard'?800:600,Math.round((200+600*c/n)/10)*10);};
      Object.assign(result,{score:score('rw')+score('math'),correct:a.grades.reduce((s,g)=>s+g.correct,0),total:98,approximate:true});
    }
    return result;
  }
  return {check,create,get,update,finish,resume,question,ensureEvents,summary};
}
import { lessonForRef as questionsLesson } from './questions.mjs';
