// Shared helpers for the API routes. Files starting with "_" are not routes on Vercel.
// Storage is Neon Postgres (added from Vercel → Storage), reached over HTTP with Neon's
// serverless driver. Tables are created on first use.
const crypto = require('crypto');
const { promisify } = require('util');
const { neon } = require('@neondatabase/serverless');
const scrypt = promisify(crypto.scrypt);

const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const SESSION_COOKIE = 'doable_session';
const SESSION_DAYS = 60;
const sqlClient = DB_URL ? neon(DB_URL) : null;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const SCHEMA = [
  `create table if not exists users (
     id uuid primary key, email text unique not null, pw text not null, rc text not null,
     created timestamptz not null default now())`,
  `create table if not exists sessions (
     hash text primary key, user_id uuid not null references users(id) on delete cascade,
     email text not null, expires timestamptz not null)`,
  `create index if not exists sessions_user on sessions(user_id)`,
  `create table if not exists state (
     user_id uuid primary key references users(id) on delete cascade,
     data jsonb not null, version bigint not null, updated timestamptz not null default now())`,
  `create table if not exists rate (key text primary key, n int not null, reset_at timestamptz not null)`,
  `create table if not exists meta (key text primary key, value text not null)`,
  `alter table users add column if not exists cal text unique`,
  `create table if not exists state_history (
     id bigserial primary key, user_id uuid not null references users(id) on delete cascade,
     version bigint not null, data jsonb not null, saved timestamptz not null default now())`,
  `create index if not exists state_history_user on state_history(user_id, saved desc)`,
  `alter table users add column if not exists genesis text`,
  `alter table users add column if not exists genesis_status jsonb`,
  `alter table users add column if not exists helper_key text`,
  `alter table users add column if not exists helper_topic text`,
];
let ready = null;
async function db(text, params = []) {
  if (!sqlClient) throw new HttpError(503, 'Database is not connected yet. In Vercel, open Storage and add Neon to this project.');
  if (!ready) ready = (async () => { for (const s of SCHEMA) await sqlClient.query(s); })().catch(e => { ready = null; throw e; });
  await ready;
  return sqlClient.query(text, params);
}

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 4 * 1024 * 1024) {
  if (req.body !== undefined) return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new HttpError(413, 'Your data is too large to sync.'); chunks.push(c); }
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { throw new HttpError(400, 'Bad request'); }
}

// Requests that change anything must come from our own page: a custom header can't be
// sent cross-site without a CORS preflight (which we never allow), and Origin must match.
function checkSameOrigin(req) {
  if (req.method === 'GET') return;
  if (req.headers['x-doable'] !== '1') throw new HttpError(403, 'Forbidden');
  const origin = req.headers.origin;
  if (origin) {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (new URL(origin).host !== host) throw new HttpError(403, 'Forbidden');
  }
}

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const normEmail = e => String(e || '').trim().toLowerCase();
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;

async function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(secret), salt, 64, { N: 16384, r: 8, p: 1 });
  return `s1$${salt.toString('hex')}$${key.toString('hex')}`;
}
async function verifySecret(secret, stored) {
  const [, saltHex, keyHex] = String(stored || 's1$00$00').split('$');
  const key = await scrypt(String(secret), Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(keyHex, 'hex');
  return want.length === key.length && crypto.timingSafeEqual(want, key);
}
const DUMMY_HASH = 's1$' + '00'.repeat(16) + '$' + '00'.repeat(64);

function recoveryCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(20);
  let s = '';
  for (let i = 0; i < 20; i++) s += abc[bytes[i] % abc.length] + (i % 5 === 4 && i < 19 ? '-' : '');
  return s;
}
const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '?').split(',')[0].trim(); }
async function rateLimit(key, max, windowSec) {
  const [row] = await db(
    `insert into rate (key, n, reset_at) values ($1, 1, now() + make_interval(secs => $2))
     on conflict (key) do update set
       n = case when rate.reset_at < now() then 1 else rate.n + 1 end,
       reset_at = case when rate.reset_at < now() then excluded.reset_at else rate.reset_at end
     returning n`, [key, windowSec]);
  if (row.n > max) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
}

function getCookie(req, name) {
  const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function cookieHeader(value, maxAge) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
async function createSession(user) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db(`delete from sessions where user_id = $1 and expires < now()`, [user.id]);
  await db(`insert into sessions (hash, user_id, email, expires) values ($1, $2, $3, now() + make_interval(days => $4))`,
    [sha256(token), user.id, user.email, SESSION_DAYS]);
  return cookieHeader(token, SESSION_DAYS * 86400);
}
async function getSession(req) {
  const token = getCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const hash = sha256(token);
  const [row] = await db(`select user_id, email from sessions where hash = $1 and expires > now()`, [hash]);
  return row ? { id: row.user_id, email: row.email, hash } : null;
}
async function requireUser(req) {
  const s = await getSession(req);
  if (!s) throw new HttpError(401, 'Please sign in.');
  return s;
}
const endAllSessions = userId => db(`delete from sessions where user_id = $1`, [userId]);
const findUser = async email => (await db(`select id, email, pw, rc from users where email = $1`, [email]))[0] || null;

function handler(fn) {
  return async (req, res) => {
    try {
      checkSameOrigin(req);
      await fn(req, res);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      send(res, 500, { error: 'Server error. Please try again.' });
    }
  };
}

module.exports = {
  HttpError, db, send, readBody, handler, sha256, normEmail, validEmail,
  hashSecret, verifySecret, DUMMY_HASH, recoveryCode, normCode, clientIp, rateLimit,
  createSession, getSession, requireUser, endAllSessions, findUser, cookieHeader,
};
