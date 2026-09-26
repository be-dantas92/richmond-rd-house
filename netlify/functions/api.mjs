import {
  USERS, USER_IDS, nameOf, isAdmin, REQUIRED_APPROVALS,
  load, save, photoStore, todayBne, addDays, weekStartOf, assignee,
  signToken, verifyToken, hashPin, checkPin, newTopic, uid, notify,
} from '../../lib/core.mjs';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };
const need = (cond, msg = 'Missing or invalid information.') => { if (!cond) fail(400, msg); };
const clean = (s, max = 500) => String(s ?? '').trim().slice(0, max);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

function defaultRosters(order, today) {
  const start = weekStartOf(today);
  return {
    house: {
      id: 'house', name: 'House clean', members: order, startDate: start,
      days: [0, 1, 2, 3], reminderHour: 18, bins: true, overrides: {},
    },
    bathroom: {
      id: 'bathroom', name: 'Shared bathroom', members: order.filter(u => u !== 'bernard'), startDate: start,
      days: [0, 1, 2, 3], reminderHour: 18, bins: false, overrides: {},
    },
  };
}

async function buildState(me) {
  const today = todayBne();
  const [auth, rosters, cleanings, swaps, shopping, notices, events, payments, feed] = await Promise.all([
    load('auth', {}), load('rosters', {}), load('cleanings', {}), load('swaps', []), load('shopping', []),
    load('notices', []), load('events', []), load('payments', { defs: [], paid: {} }), load('feed', []),
  ]);
  const recent = Object.values(cleanings)
    .filter(c => c.weekStart >= addDays(today, -120))
    .sort((a, b) => b.weekStart.localeCompare(a.weekStart));
  return {
    me, today, requiredApprovals: REQUIRED_APPROVALS,
    users: USERS.map(u => ({ ...u, notifications: !!auth[u.id]?.topic })),
    myTopic: auth[me]?.topic || null,
    ntfyServer: process.env.NTFY_SERVER || 'https://ntfy.sh',
    rosters, cleanings: recent,
    swaps: swaps.filter(s => s.status === 'pending'),
    shopping, notices,
    events: events.filter(e => e.date >= addDays(today, -30)).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)),
    payments,
    feed: feed.filter(f => f.to.includes(me)).slice(0, 60),
  };
}

// ---------------- actions ----------------
const actions = {
  async 'pin.change'(me, a) {
    const auth = await load('auth', {});
    need(checkPin(a.old, auth[me]), 'Your current PIN is wrong.');
    need(/^\d{4,8}$/.test(a.pin || ''), 'Use 4 to 8 digits for your PIN.');
    auth[me] = { ...auth[me], ...hashPin(a.pin) };
    await save('auth', auth);
  },
  async 'notify.enable'(me) {
    const auth = await load('auth', {});
    if (!auth[me].topic) auth[me].topic = newTopic();
    await save('auth', auth);
  },
  async 'notify.test'(me) {
    await notify([me], 'Test notification', 'Notifications are working on this device.', 'white_check_mark');
  },
  async 'admin.pin'(me, a) {
    need(isAdmin(me), 'Only Bernard can reset PINs.');
    need(USER_IDS.includes(a.user) && /^\d{4,8}$/.test(a.pin || ''), 'Choose a person and a 4 to 8 digit PIN.');
    const auth = await load('auth', {});
    auth[a.user] = { ...auth[a.user], ...hashPin(a.pin) };
    await save('auth', auth);
  },

  // ----- rosters -----
  async 'roster.save'(me, a) {
    need(isAdmin(me), 'Only Bernard can change the rosters.');
    const rosters = await load('rosters', {});
    const r = rosters[a.id];
    need(r, 'Unknown roster.');
    need(Array.isArray(a.members) && a.members.length && a.members.every(m => USER_IDS.includes(m)), 'Pick at least one person.');
    need(isDate(a.startDate), 'Pick a start date.');
    const hour = Number(a.reminderHour);
    need(hour >= 6 && hour <= 21, 'Reminder time must be between 6am and 9pm.');
    Object.assign(r, { members: a.members, startDate: weekStartOf(a.startDate), reminderHour: hour });
    if (a.resetOverrides) r.overrides = {};
    await save('rosters', rosters);
  },
  async 'swap.request'(me, a) {
    const rosters = await load('rosters', {});
    const r = rosters[a.rosterId];
    need(r && isDate(a.myWeek) && isDate(a.theirWeek), 'Pick both weeks.');
    need(assignee(r, a.myWeek) === me, 'You are not on that week.');
    const them = assignee(r, a.theirWeek);
    need(them && them !== me, 'Pick a week that belongs to someone else.');
    const swaps = await load('swaps', []);
    swaps.push({ id: uid(), rosterId: r.id, from: me, to: them, myWeek: a.myWeek, theirWeek: a.theirWeek, status: 'pending', at: Date.now() });
    await save('swaps', swaps);
    await notify([them], 'Swap request', `${nameOf(me)} wants to swap ${r.name}: their week of ${a.myWeek} for your week of ${a.theirWeek}. Open the app to accept or decline.`, 'arrows_counterclockwise');
  },
  async 'swap.answer'(me, a) {
    const swaps = await load('swaps', []);
    const s = swaps.find(x => x.id === a.id && x.status === 'pending');
    need(s && s.to === me, 'That swap is no longer open.');
    s.status = a.accept ? 'accepted' : 'declined';
    if (a.accept) {
      const rosters = await load('rosters', {});
      const r = rosters[s.rosterId];
      r.overrides = r.overrides || {};
      r.overrides[s.myWeek] = s.to;
      r.overrides[s.theirWeek] = s.from;
      await save('rosters', rosters);
    }
    await save('swaps', swaps);
    await notify([s.from], a.accept ? 'Swap accepted' : 'Swap declined', `${nameOf(me)} ${a.accept ? 'accepted' : 'declined'} your swap request.`);
  },

  // ----- cleaning -----
  async 'clean.save'(me, a) {
    const rosters = await load('rosters', {});
    const r = rosters[a.rosterId];
    need(r && isDate(a.weekStart), 'Unknown cleaning week.');
    need(assignee(r, a.weekStart) === me, 'This cleaning week is not yours.');
    need(a.weekStart <= weekStartOf(todayBne()), 'That week has not started yet.');
    const cleanings = await load('cleanings', {});
    const key = `${r.id}:${a.weekStart}`;
    const c = cleanings[key] || { rosterId: r.id, weekStart: a.weekStart, user: me, status: 'draft', areas: {}, approvals: {} };
    need(c.status !== 'approved', 'This clean has already been approved.');
    const ar = c.areas[a.areaId] || { checked: [], photos: [], note: '' };
    if (Array.isArray(a.checked)) ar.checked = a.checked.filter(n => Number.isInteger(n)).slice(0, 40);
    if (Array.isArray(a.photos)) ar.photos = a.photos.map(p => clean(p, 40)).slice(0, 8);
    if (a.note !== undefined) ar.note = clean(a.note, 400);
    c.areas[a.areaId] = ar;
    if (c.status === 'rejected') c.status = 'draft';
    cleanings[key] = c;
    await save('cleanings', cleanings);
  },
  async 'clean.submit'(me, a) {
    const cleanings = await load('cleanings', {});
    const c = cleanings[`${a.rosterId}:${a.weekStart}`];
    need(c && c.user === me, 'Nothing to submit yet.');
    need(['draft', 'rejected'].includes(c.status), 'Already submitted.');
    need(Array.isArray(a.requiredAreas) && a.requiredAreas.every(id => c.areas[id]?.photos?.length), 'Every area needs at least one photo before you submit.');
    Object.assign(c, { status: 'submitted', submittedAt: Date.now(), approvals: {}, rejection: null });
    await save('cleanings', cleanings);
    const rosters = await load('rosters', {});
    await notify(USER_IDS.filter(u => u !== me), 'Cleaning done: please check',
      `${nameOf(me)} finished the ${rosters[a.rosterId]?.name || 'clean'} and uploaded photos. Open the app to approve.`, 'broom');
  },
  async 'clean.review'(me, a) {
    const cleanings = await load('cleanings', {});
    const c = cleanings[`${a.rosterId}:${a.weekStart}`];
    need(c && c.status === 'submitted', 'There is nothing waiting for review here.');
    need(c.user !== me, 'You cannot approve your own clean.');
    const rosters = await load('rosters', {});
    const label = rosters[a.rosterId]?.name || 'clean';
    if (a.approve) {
      c.approvals[me] = Date.now();
      if (Object.keys(c.approvals).length >= REQUIRED_APPROVALS) {
        c.status = 'approved'; c.approvedAt = Date.now();
        await notify([c.user], 'Clean approved', `Your ${label} was approved. Thanks!`, 'tada');
      }
    } else {
      const reason = clean(a.reason, 400);
      need(reason, 'Say what needs fixing.');
      Object.assign(c, { status: 'rejected', rejection: { by: me, reason, at: Date.now() }, approvals: {} });
      await notify([c.user], 'Clean needs another look', `${nameOf(me)}: ${reason}`, 'warning');
    }
    await save('cleanings', cleanings);
  },

  // ----- shopping -----
  async 'shop.add'(me, a) {
    const name = clean(a.name, 80);
    need(name, 'Type what we need.');
    const list = await load('shopping', []);
    list.unshift({ id: uid(), name, qty: clean(a.qty, 20), by: me, at: Date.now(), bought: null });
    await save('shopping', list.slice(0, 200));
  },
  async 'shop.toggle'(me, a) {
    const list = await load('shopping', []);
    const it = list.find(x => x.id === a.id);
    need(it, 'Item not found.');
    it.bought = it.bought ? null : { by: me, at: Date.now() };
    await save('shopping', list);
  },
  async 'shop.remove'(me, a) {
    const list = await load('shopping', []);
    await save('shopping', list.filter(x => x.id !== a.id));
  },
  async 'shop.clear'() {
    const list = await load('shopping', []);
    await save('shopping', list.filter(x => !x.bought));
  },

  // ----- notices and dates -----
  async 'notice.add'(me, a) {
    const title = clean(a.title, 100);
    need(title, 'Give the notice a title.');
    const notices = await load('notices', []);
    notices.unshift({ id: uid(), title, body: clean(a.body, 2000), by: me, at: Date.now(), pinned: !!a.pinned && isAdmin(me) });
    await save('notices', notices.slice(0, 100));
    await notify(USER_IDS.filter(u => u !== me), `Notice: ${title}`, clean(a.body, 300) || `${nameOf(me)} posted a notice.`, 'loudspeaker');
  },
  async 'notice.remove'(me, a) {
    const notices = await load('notices', []);
    const n = notices.find(x => x.id === a.id);
    need(n && (n.by === me || isAdmin(me)), 'You can only remove your own notices.');
    await save('notices', notices.filter(x => x.id !== a.id));
  },
  async 'event.add'(me, a) {
    const title = clean(a.title, 100);
    need(title && isDate(a.date), 'Give it a title and a date.');
    const events = await load('events', []);
    const ev = { id: uid(), title, date: a.date, time: /^\d{2}:\d{2}$/.test(a.time || '') ? a.time : '', kind: a.kind === 'inspection' ? 'inspection' : 'other', note: clean(a.note, 500), by: me, at: Date.now() };
    events.push(ev);
    await save('events', events);
    await notify(USER_IDS.filter(u => u !== me), ev.kind === 'inspection' ? `Inspection booked: ${ev.date}` : `New date: ${title}`,
      `${title}, ${ev.date}${ev.time ? ' at ' + ev.time : ''}.${ev.note ? ' ' + ev.note : ''}`, 'calendar');
  },
  async 'event.remove'(me, a) {
    const events = await load('events', []);
    const e = events.find(x => x.id === a.id);
    need(e && (e.by === me || isAdmin(me)), 'You can only remove dates you added.');
    await save('events', events.filter(x => x.id !== a.id));
  },

  // ----- payments -----
  async 'pay.def'(me, a) {
    need(isAdmin(me), 'Only Bernard can set up payments.');
    const title = clean(a.title, 80);
    const amount = Number(a.amount);
    const every = Number(a.everyDays) || 0;
    need(title && isDate(a.firstDue) && amount >= 0, 'Fill in the title, amount and first due date.');
    need(Array.isArray(a.users) && a.users.length && a.users.every(u => USER_IDS.includes(u)), 'Pick who pays.');
    const payments = await load('payments', { defs: [], paid: {} });
    const def = { id: a.id || uid(), title, amount, users: a.users, firstDue: a.firstDue, everyDays: [0, 7, 14, 28, 30, 91].includes(every) ? every : 0, payTo: clean(a.payTo, 60), active: true };
    const i = payments.defs.findIndex(d => d.id === def.id);
    if (i >= 0) payments.defs[i] = def; else payments.defs.push(def);
    await save('payments', payments);
    if (i < 0) await notify(def.users.filter(u => u !== me), `New payment: ${title}`, `$${amount.toFixed(2)} due ${def.firstDue}${def.everyDays ? `, then every ${def.everyDays} days` : ''}.`, 'moneybag');
  },
  async 'pay.remove'(me, a) {
    need(isAdmin(me), 'Only Bernard can remove payments.');
    const payments = await load('payments', { defs: [], paid: {} });
    payments.defs = payments.defs.filter(d => d.id !== a.id);
    await save('payments', payments);
  },
  async 'pay.mark'(me, a) {
    const payments = await load('payments', { defs: [], paid: {} });
    const def = payments.defs.find(d => d.id === a.defId);
    need(def && isDate(a.date), 'Payment not found.');
    const who = a.user && isAdmin(me) ? a.user : me;
    need(def.users.includes(who), 'That payment is not yours.');
    const key = `${def.id}:${a.date}:${who}`;
    if (a.undo) delete payments.paid[key];
    else payments.paid[key] = { at: Date.now(), by: me, confirmed: isAdmin(me) };
    await save('payments', payments);
    if (!a.undo && !isAdmin(me)) await notify(USER_IDS.filter(isAdmin), `${nameOf(me)} paid`, `${def.title}, due ${a.date}: marked as paid. Please confirm.`, 'moneybag');
  },
};

// ---------------- router ----------------
export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, '');
  try {
    if (route === 'status') {
      const auth = await load('auth', null);
      return json({ ready: !!auth, users: USERS.map(({ id, name }) => ({ id, name })) });
    }

    if (route === 'setup' && req.method === 'POST') {
      const b = await req.json();
      need(process.env.SETUP_CODE, 'Set SETUP_CODE in the Netlify environment first.');
      if (await load('auth', null)) fail(409, 'The house is already set up.');
      if (b.code !== process.env.SETUP_CODE) fail(403, 'Wrong setup code.');
      need(USER_IDS.every(id => /^\d{4,8}$/.test(b.pins?.[id] || '')), 'Give everyone a 4 to 8 digit PIN.');
      const order = Array.isArray(b.order) && b.order.length === 4 && USER_IDS.every(u => b.order.includes(u)) ? b.order : USER_IDS;
      const auth = Object.fromEntries(USER_IDS.map(id => [id, { ...hashPin(b.pins[id]), topic: newTopic() }]));
      await save('auth', auth);
      await save('rosters', defaultRosters(order, todayBne()));
      return json({ ok: true });
    }

    if (route === 'login' && req.method === 'POST') {
      const b = await req.json();
      const auth = await load('auth', {});
      if (!USER_IDS.includes(b.user) || !checkPin(b.pin, auth[b.user])) fail(401, 'Wrong name or PIN.');
      return json({ token: signToken(b.user) });
    }

    // Everything below needs a session.
    const token = (req.headers.get('authorization') || '').replace(/^Bearer /, '') || url.searchParams.get('t');
    const me = verifyToken(token);
    if (!me) fail(401, 'Please sign in again.');

    if (route.startsWith('photo/') && req.method === 'GET') {
      const id = route.slice(6).replace(/[^a-z0-9]/g, '');
      const data = await photoStore().get(id, { type: 'arrayBuffer' });
      if (!data) fail(404, 'Photo not found.');
      return new Response(data, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable' } });
    }

    if (route === 'photo' && req.method === 'POST') {
      const b = await req.json();
      const m = /^data:image\/jpeg;base64,(.+)$/.exec(b.data || '');
      need(m, 'Upload a JPEG photo.');
      const buf = Buffer.from(m[1], 'base64');
      need(buf.length < 4_000_000, 'Photo is too large.');
      const id = uid() + uid();
      await photoStore().set(id, buf, { metadata: { by: me, at: Date.now() } });
      return json({ id });
    }

    if (route === 'state') return json(await buildState(me));

    if (route === 'action' && req.method === 'POST') {
      const b = await req.json();
      const fn = actions[b.type];
      need(fn, 'Unknown action.');
      await fn(me, b);
      return json(await buildState(me));
    }

    fail(404, 'Not found.');
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'Something went wrong on the server. Try again.' }, 500);
  }
};

export const config = { path: '/api/*' };
