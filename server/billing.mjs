import { randomUUID, timingSafeEqual } from 'node:crypto';

const DAY = 86400000, TIMEOUT = 43200000;
const rpcFail = (code, en, data) => { const e = Error(en); e.rpc = { code, message: { en, ru: en, uz: en }, ...(data ? { data } : {}) }; throw e; };
const apiFail = (status, message) => { const e = Error(message); e.status = status; throw e; };
const equal = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export function billing(store, env = process.env, now = Date.now) {
  const mode = env.PAYMENT_MODE || 'manual';
  if (!['manual', 'payme', 'demo', 'off'].includes(mode)) throw Error('Invalid PAYMENT_MODE');
  if (mode === 'demo' && env.NODE_ENV === 'production') throw Error('Demo payments are forbidden in production');
  if (mode === 'payme' && (!env.PAYME_MERCHANT_ID || !env.PAYME_KEY || !env.FRONTEND_URL)) throw Error('Payme requires PAYME_MERCHANT_ID, PAYME_KEY and FRONTEND_URL');
  const price = Number(env.PREMIUM_PRICE_UZS || 19000);
  if (!Number.isSafeInteger(price) || price < 1000 || price > 100000000) throw Error('Invalid PREMIUM_PRICE_UZS');
  const config = () => ({ mode, price, currency: 'UZS', days: 30, autoRenew: false, phone: '+998 95 570 55 66', freeLessons: ['linear', 'transitions'], freeTest: 1 });

  async function subscription(userId) {
    const paid = (await store.list('orders', { userId, state: 2 })).sort((a, b) => a.performTime - b.performTime || a.id.localeCompare(b.id));
    let until = 0;
    for (const o of paid) until = Math.max(until, o.performTime) + o.days * DAY;
    return { active: until > now(), until: until || null, plan: until > now() ? 'premium' : 'free', autoRenew: false };
  }
  async function requirePremium(userId) {
    if (!(await subscription(userId)).active) apiFail(403, 'PREMIUM_REQUIRED');
  }
  function view(o) { return { id: o.id, price: o.amount / 100, days: o.days, created: o.created, state: o.state, provider: o.provider, paidAt: o.performTime || null, cancelledAt: o.cancelTime || null }; }
  async function order(user, lang = 'ru', key = '') {
    if (mode === 'off') apiFail(503, 'PAYMENTS_DISABLED');
    if (user.guest) apiFail(401, 'LOGIN_REQUIRED');
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(key)) apiFail(400, 'INVALID_IDEMPOTENCY_KEY');
    const existing = (await store.list('orders', { userId: user.id, requestKey: key }))[0];
    let o = existing;
    if (!o) {
      o = { id: randomUUID(), userId: user.id, requestKey: key, amount: price * 100, days: 30, created: now(), state: 0, provider: mode, createTime: 0, performTime: 0, cancelTime: 0, reason: null };
      // Deterministic request ID also protects concurrent retries across instances.
      o.id = user.id + '-' + key;
      try { await store.insert('orders', o); } catch (e) { o = await store.get('orders', o.id); if (!o) throw e; }
    }
    let checkoutUrl = null;
    if (o.provider === 'payme' && o.state >= 0 && o.state < 2) {
      const returnURL = new URL('hub.html', env.FRONTEND_URL.replace(/\/?$/, '/'));
      returnURL.hash = 'premium/order/' + o.id;
      const params = `m=${env.PAYME_MERCHANT_ID};ac.order_id=${o.id};a=${o.amount};l=${['ru','uz','en'].includes(lang)?lang:'ru'};c=${returnURL.href}`;
      checkoutUrl = 'https://checkout.paycom.uz/' + Buffer.from(params).toString('base64');
    }
    return { ...view(o), checkoutUrl };
  }
  async function expire(o) {
    if (o?.state === 1 && now() - o.providerTime >= TIMEOUT) {
      return store.change('orders', o.id, current => current.state === 1 && now() - current.providerTime >= TIMEOUT ? { ...current, state: -1, cancelTime: now(), reason: 4 } : current);
    }
    return o;
  }
  async function rpc(req, authorization) {
    const id = req?.id ?? null;
    try {
      if (mode !== 'payme' || !equal(authorization || '', 'Basic ' + Buffer.from('Paycom:' + env.PAYME_KEY).toString('base64'))) rpcFail(-32504, 'Unauthorized');
      const p = req.params || {}, method = req.method;
      if (req.jsonrpc && req.jsonrpc !== '2.0') rpcFail(-32600, 'Invalid request');
      if (method === 'GetStatement') {
        if (!Number.isSafeInteger(p.from) || !Number.isSafeInteger(p.to) || p.from > p.to) rpcFail(-32602, 'Invalid period');
        const orders = (await store.list('orders', { provider: 'payme' })).filter(o => o.providerId && o.providerTime >= p.from && o.providerTime <= p.to).sort((a,b) => a.providerTime-b.providerTime);
        const transactions = [];
        for (let o of orders) { o = await expire(o); transactions.push({ id: o.providerId, time: o.providerTime, amount: o.amount, account: { order_id: o.id }, create_time: o.createTime, perform_time: o.performTime, cancel_time: o.cancelTime, transaction: o.id, state: o.state, reason: o.reason }); }
        return { jsonrpc: '2.0', id, result: { transactions } };
      }
      let o;
      if (['CheckPerformTransaction', 'CreateTransaction'].includes(method)) {
        if (typeof p.account?.order_id !== 'string') rpcFail(-31050, 'Invalid order', 'order_id');
        o = await expire(await store.get('orders', p.account.order_id));
        if (!o || o.provider !== 'payme') rpcFail(-31050, 'Order not found', 'order_id');
        if (!Number.isSafeInteger(p.amount) || p.amount !== o.amount) rpcFail(-31001, 'Incorrect amount');
        if (method === 'CheckPerformTransaction') {
          if (o.state < 0 || o.state === 2) rpcFail(-31008, 'Order unavailable');
          return { jsonrpc: '2.0', id, result: { allow: true } };
        }
        if (typeof p.id !== 'string' || !/^[\w-]{1,100}$/.test(p.id) || !Number.isSafeInteger(p.time) || p.time <= 0 || p.time > now() + 300000) rpcFail(-32602, 'Invalid transaction');
        if (now() - p.time >= TIMEOUT) rpcFail(-31008, 'Transaction expired');
        const other = (await store.list('orders', { providerId: p.id }))[0];
        if (other && (other.id !== o.id || other.providerTime !== p.time)) rpcFail(-31008, 'Transaction already used');
        o = await store.change('orders', o.id, current => {
          if (current.state < 0 || current.providerId && (current.providerId !== p.id || current.providerTime !== p.time)) rpcFail(-31008, 'Order unavailable');
          if (current.providerId === p.id) return current;
          if (current.state !== 0) rpcFail(-31008, 'Order unavailable');
          return { ...current, providerId: p.id, providerTime: p.time, createTime: now(), state: 1 };
        });
        return { jsonrpc: '2.0', id, result: { transaction: o.id, create_time: o.createTime, state: o.state } };
      }
      if (!['PerformTransaction','CancelTransaction','CheckTransaction'].includes(method)) rpcFail(-32601, 'Method not found');
      if (typeof p.id !== 'string') rpcFail(-32602, 'Invalid transaction');
      o = await expire((await store.list('orders', { providerId: p.id }))[0]);
      if (!o) rpcFail(-31003, 'Transaction not found');
      if (method === 'PerformTransaction') {
        o = await store.change('orders', o.id, current => {
          if (current.state === 2) return current;
          if (current.state !== 1 || now() - current.providerTime >= TIMEOUT) rpcFail(-31008, 'Transaction unavailable');
          return { ...current, state: 2, performTime: now() };
        });
        return { jsonrpc:'2.0',id,result:{transaction:o.id,state:o.state,perform_time:o.performTime} };
      }
      if (method === 'CancelTransaction') {
        if (!Number.isInteger(p.reason) || p.reason < 1 || p.reason > 10) rpcFail(-32602, 'Invalid cancellation reason');
        o = await store.change('orders', o.id, current => current.state < 0 ? current : { ...current, state: current.state === 2 ? -2 : -1, cancelTime: now(), reason: p.reason });
        return {jsonrpc:'2.0',id,result:{transaction:o.id,state:o.state,cancel_time:o.cancelTime}};
      }
      return { jsonrpc:'2.0',id,result:{transaction:o.id,state:o.state,create_time:o.createTime,perform_time:o.performTime,cancel_time:o.cancelTime,reason:o.reason} };
    } catch (e) {
      if (!e.rpc && ![11000].includes(e.code) && !(String(e.code).includes('SQLITE_CONSTRAINT') || [1555,2067].includes(e.errcode))) console.error('Payme callback failed:', e.message);
      return { jsonrpc:'2.0',id,error:e.rpc || {code:-31008,message:{ru:'Операция недоступна',uz:'Amal bajarilmadi',en:'Operation unavailable'}} };
    }
  }
  async function approveManual(id) {
    const o = await store.change('orders', id, current => {
      if (current.provider !== 'manual' || ![0,2].includes(current.state)) throw Error('Only manual orders can be approved');
      return current.state === 2 ? current : { ...current, state: 2, performTime: now() };
    });
    if (!o) throw Error('Order not found');
    return view(o);
  }
  async function demo(id, userId, success) {
    if (mode !== 'demo') apiFail(404,'NOT_FOUND');
    const old = await store.get('orders',id);
    if (!old || old.userId !== userId || old.provider !== 'demo') apiFail(404,'ORDER_NOT_FOUND');
    const o = await store.change('orders',id,current => current.state === 0 ? {...current,state:success?2:-1,performTime:success?now():0,cancelTime:success?0:now()} : current);
    return view(o);
  }
  return { config, subscription, requirePremium, order, rpc, view, approveManual, demo };
}
