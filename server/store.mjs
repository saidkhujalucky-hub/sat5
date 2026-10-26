import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => doc[k] === v);
const clean = ({ _id, _rev, ...doc }) => doc;

// Both adapters expose atomic single-document changes. No data lives in RAM only.
export async function openStore(env = process.env) {
  if (env.MONGODB_URI) {
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 12000 });
    await client.connect();
    const db = client.db(env.MONGODB_DB || 'sat_preparation');
    await db.collection('users').createIndex({ email: 1 }, { unique: true, partialFilterExpression: { guest: false } });
    await db.collection('orders').createIndex({ providerId: 1 }, { unique: true, sparse: true });
    for (const name of ['orders', 'exams', 'events', 'reviews', 'learned', 'drills', 'reports']) {
      await db.collection(name).createIndex({ userId: 1 });
    }
    await db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    return {
      kind: 'mongodb',
      async get(name, id) { const d = await db.collection(name).findOne({ _id: id }); return d ? clean(d) : null; },
      async list(name, filter = {}) { return (await db.collection(name).find(filter).toArray()).map(clean); },
      async insert(name, doc) { await db.collection(name).insertOne({ ...doc, _id: doc.id, _rev: 1 }); return doc; },
      async remove(name, id) { await db.collection(name).deleteOne({ _id: id }); },
      async change(name, id, fn) {
        const collection = db.collection(name);
        for (let i = 0; i < 12; i++) {
          const old = await collection.findOne({ _id: id });
          if (!old) return null;
          const next = fn(clean(old));
          if (!next) return clean(old);
          const r = await collection.replaceOne({ _id: id, _rev: old._rev }, { ...next, _id: id, _rev: old._rev + 1 });
          if (r.modifiedCount) return next;
        }
        throw Error('Concurrent update: please retry');
      },
      async close() { await client.close(); }
    };
  }
  const file = env.DB_PATH || resolve('data/sat.sqlite');
  mkdirSync(dirname(resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS documents(collection TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(collection,id));
    CREATE UNIQUE INDEX IF NOT EXISTS unique_user_email ON documents(json_extract(body,'$.email')) WHERE collection='users' AND json_extract(body,'$.guest')=0;
    CREATE UNIQUE INDEX IF NOT EXISTS unique_payment_id ON documents(json_extract(body,'$.providerId')) WHERE collection='orders';
    CREATE INDEX IF NOT EXISTS documents_user ON documents(collection,json_extract(body,'$.userId'));`);
  const get = (name, id) => {
    const r = db.prepare('SELECT body FROM documents WHERE collection=? AND id=?').get(name, id);
    return r ? JSON.parse(r.body) : null;
  };
  const insert = (name, doc) => { db.prepare('INSERT INTO documents VALUES(?,?,?)').run(name, doc.id, JSON.stringify(doc)); return doc; };
  // Additive migration: original SQL tables and histories are retained, never dropped.
  if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get() && !get('meta', 'v2-users')) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of db.prepare('SELECT * FROM users').all()) {
        if (!get('users', row.id)) insert('users', { id: row.id, email: row.email, name: row.name, password: row.password, guest: false, created: row.created, settings: JSON.parse(row.settings) });
      }
      for (const row of db.prepare('SELECT * FROM sessions').all()) {
        if (!get('sessions', row.token)) insert('sessions', { id: row.token, userId: row.user_id, expires: row.expires, expiresAt: new Date(row.expires).toISOString() });
      }
      for (const row of db.prepare('SELECT * FROM learned').all()) {
        const id = row.user_id + ':' + row.lesson;
        if (!get('learned', id)) insert('learned', { id, userId: row.user_id, lesson: row.lesson, created: row.created });
      }
      insert('meta', { id: 'v2-users', migrated: Date.now() });
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return {
    kind: 'sqlite',
    async get(name, id) { return get(name, id); },
    async list(name, filter = {}) {
      const rows = Object.hasOwn(filter, 'userId')
        ? db.prepare("SELECT body FROM documents WHERE collection=? AND json_extract(body,'$.userId')=?").all(name, filter.userId)
        : db.prepare('SELECT body FROM documents WHERE collection=?').all(name);
      return rows.map(r => JSON.parse(r.body)).filter(d => matches(d, filter));
    },
    async insert(name, doc) { return insert(name, doc); },
    async remove(name, id) { db.prepare('DELETE FROM documents WHERE collection=? AND id=?').run(name, id); },
    async change(name, id, fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const old = get(name, id), next = old && fn(old);
        if (next) db.prepare('UPDATE documents SET body=? WHERE collection=? AND id=?').run(JSON.stringify(next), name, id);
        db.exec('COMMIT');
        return next || old;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    async close() { db.close(); }
  };
}

export async function insertOnce(store, collection, doc) {
  try { return await store.insert(collection, doc); }
  catch (e) {
    if (e.code === 11000 || (String(e.code).includes('SQLITE_CONSTRAINT') || [1555,2067].includes(e.errcode))) {
      const existing = await store.get(collection, doc.id);
      if (existing) return existing;
    }
    throw e;
  }
}
