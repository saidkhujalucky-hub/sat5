(()=>{
 const base=(window.SAT_CONFIG?.apiBase||'./api').replace(/\/$/,'');
 window.SATClient={
  async api(path,method='GET',body){
   const session=localStorage.getItem('sat_session'),token=session||localStorage.getItem('sat_guest')||'';
   let response;
   try{response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});}catch{throw Error('API_UNAVAILABLE');}
   let data;try{data=await response.json();}catch{throw Error('API_UNAVAILABLE');}
   if(!response.ok){if(response.status===401){localStorage.removeItem(session?'sat_session':'sat_guest');if(session)localStorage.removeItem('sat_user_id');}const e=Error(data.error||'SERVER_ERROR');e.status=response.status;throw e;}
   return data;
  },
  async ensureGuest(){
   if(localStorage.getItem('sat_session')||localStorage.getItem('sat_guest')){try{return await this.api('/auth/me');}catch(e){if(e.status!==401)throw e;}}
   const r=await this.api('/guest','POST',{});
   if(r.token)localStorage.setItem('sat_guest',r.token);
   if(r.user?.guest)localStorage.setItem('sat_guest_id',r.user.id);
   return r.user;
  },
  lang(){return localStorage.getItem('sat_language')||'ru';},
  setLang(lang){localStorage.setItem('sat_language',lang);document.documentElement.lang=lang;}
 };
})();
