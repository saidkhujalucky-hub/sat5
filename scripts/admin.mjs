import {openStore} from '../server/store.mjs';
import {billing} from '../server/billing.mjs';
const store=await openStore();
try{
 const[command,id]=process.argv.slice(2);
 if(command==='reports'){
  for(const r of (await store.list('reports')).sort((a,b)=>b.created-a.created))console.log(JSON.stringify(r));
 }else if(command==='orders'){
  const b=billing(store);
  for(const o of (await store.list('orders')).sort((a,b)=>b.created-a.created))console.log(JSON.stringify({...b.view(o),userId:o.userId}));
 }else if(command==='approve'&&id){
  // Run only after independently verifying the actual incoming payment.
  console.log(JSON.stringify(await billing(store).approveManual(id)));
 }else throw Error('Usage: npm run admin -- reports | orders | approve ORDER_ID');
}finally{await store.close();}
