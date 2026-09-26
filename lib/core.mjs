// Shared logic for the house app. Data lives in Netlify Blobs.
import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

export const USERS = [
  { id: 'bernard', name: 'Bernard', admin: true },
  { id: 'steeven', name: 'Steeven' },
  { id: 'kevin', name: 'Kevin' },
  { id: 'renan', name: 'Renan' },
];
export const USER_IDS = USERS.map(u => u.id);
export const nameOf = id => USERS.find(u => u.id === id)?.name || id;
export const isAdmin = id => !!USERS.find(u => u.id === id)?.admin;
export const REQUIRED_APPROVALS = 2;

// ---------- storage ----------
const house = () => getStore({ name: 'house', consistency: 'strong' });
export const photoStore = () => getStore({ name: 'photos', consistency: 'strong' });
export async function load(key, fallback) {
  const v = await house().get(key, { type: 'json' });
  return v ?? fallback;
}
export async function save(key, value) { await house().setJSON(key, value); }

// ---------- time (Brisbane, UTC+10, no daylight saving) ----------
export const bneNow = (d = new Date()) => new Date(d.getTime() + 10 * 3600e3); // read with getUTC*
export const ymd = d => d.toISOString().slice(0, 10);
export const todayBne = () => ymd(bneNow());
export const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
export const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
export const dow = s => new Date(s + 'T00:00:00Z').getUTCDay();
export const weekStartOf = s => addDays(s, -dow(s)); // Sunday

export function assignee(roster, weekStart) {
  if (!roster || !roster.members?.length || !roster.startDate) return null;
  if (roster.overrides?.[weekStart]) return roster.overrides[weekStart];
  const w = Math.floor(daysBetween(weekStartOf(roster.startDate), weekStart) / 7);
  if (w < 0) return null;
  const m = roster.members;
  return m[((w % m.length) + m.length) % m.length];
}

export function occurrences(def, from, to) {
  const out = [];
  if (!def.firstDue) return out;
  if (!def.everyDays) { if (def.firstDue >= from && def.firstDue <= to) out.push(def.firstDue); return out; }
  const k = Math.max(0, Math.ceil(daysBetween(def.firstDue, from) / def.everyDays));
  for (let d = addDays(def.firstDue, k * def.everyDays); d <= to; d = addDays(d, def.everyDays)) out.push(d);
  return out;
}

// ---------- auth ----------
const secret = () => process.env.SESSION_SECRET || 'change-me-in-netlify-env';
const b64u = s => Buffer.from(s).toString('base64url');
const hmac = s => crypto.createHmac('sha256', secret()).update(s).digest('base64url');
export function signToken(u) {
  const p = b64u(JSON.stringify({ u, exp: Date.now() + 120 * 864e5 }));
  return p + '.' + hmac(p);
}
export function verifyToken(t) {
  if (!t || !t.includes('.')) return null;
  const [p, sig] = t.split('.');
  const a = Buffer.from(hmac(p)), b = Buffer.from(sig || '');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const o = JSON.parse(Buffer.from(p, 'base64url').toString());
    return o.exp > Date.now() && USER_IDS.includes(o.u) ? o.u : null;
  } catch { return null; }
}
export function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pin), salt, 32).toString('hex') };
}
export function checkPin(pin, rec) {
  if (!rec?.salt) return false;
  const h = crypto.scryptSync(String(pin), rec.salt, 32);
  const e = Buffer.from(rec.hash, 'hex');
  return h.length === e.length && crypto.timingSafeEqual(h, e);
}
export const newTopic = () => 'house-' + crypto.randomBytes(12).toString('hex');
export const uid = () => crypto.randomBytes(6).toString('hex');

// ---------- notifications ----------
// Every notification goes to the in-app feed and to each person's private ntfy topic.
const ascii = s => String(s).normalize('NFKD').replace(/[^\x20-\x7E]/g, '');
export async function notify(to, title, body, tags = '') {
  to = [...new Set(to)].filter(Boolean);
  if (!to.length) return;
  const feed = await load('feed', []);
  feed.unshift({ id: uid(), at: Date.now(), to, title, body });
  await save('feed', feed.slice(0, 300));
  const auth = await load('auth', {});
  const server = process.env.NTFY_SERVER || 'https://ntfy.sh';
  await Promise.all(to.map(async id => {
    const topic = auth[id]?.topic;
    if (!topic) return;
    try {
      await fetch(`${server}/${topic}`, {
        method: 'POST',
        body,
        headers: { Title: ascii(title), Tags: tags, ...(process.env.URL ? { Click: process.env.URL } : {}) },
      });
    } catch (e) { console.error('ntfy', id, e.message); }
  }));
}
