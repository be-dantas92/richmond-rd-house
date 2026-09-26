// Runs every hour. Works out Brisbane time and sends whatever is due at this hour.
import {
  USER_IDS, nameOf, isAdmin, load, save, bneNow, ymd, addDays, daysBetween,
  weekStartOf, assignee, occurrences, notify,
} from '../../lib/core.mjs';

const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export async function runReminders(now = new Date()) {
  const n = bneNow(now);
  const today = ymd(n), hour = n.getUTCHours(), wd = n.getUTCDay();
  const sent = await load('sent', {});
  const out = [];
  const once = async (key, to, title, body, tags) => {
    if (sent[key]) return;
    sent[key] = Date.now();
    out.push(key);
    await notify(to, title, body, tags);
  };

  const [rosters, cleanings, events, payments] = await Promise.all([
    load('rosters', {}), load('cleanings', {}), load('events', []), load('payments', { defs: [], paid: {} }),
  ]);
  const ws = weekStartOf(today);

  for (const r of Object.values(rosters)) {
    const who = assignee(r, ws);
    if (!who) continue;
    const c = cleanings[`${r.id}:${ws}`];
    const done = c && ['submitted', 'approved'].includes(c.status);

    // Sunday 9am: who is on this week.
    if (wd === 0 && hour === 9)
      await once(`week:${r.id}:${ws}`, USER_IDS, `${r.name}: ${nameOf(who)} this week`,
        `${nameOf(who)} is on the ${r.name.toLowerCase()} this week. Due by Wednesday night.`, 'broom');

    // Daily reminder to the person on duty, Sunday to Wednesday, until photos are submitted.
    if (r.days.includes(wd) && hour === r.reminderHour && !done) {
      const left = 3 - wd;
      await once(`remind:${r.id}:${today}`, [who], `${r.name}: your week`,
        left > 0 ? `Your ${r.name.toLowerCase()} is due by Wednesday. ${left} day${left > 1 ? 's' : ''} left after today.`
                 : `Today is the last day for your ${r.name.toLowerCase()}. Take the photos and submit in the app.`,
        left > 0 ? 'broom' : 'rotating_light');
    }

    // Thursday 9am: missed.
    if (wd === 4 && hour === 9 && !done)
      await once(`missed:${r.id}:${ws}`, USER_IDS, `${r.name} not done`,
        `${nameOf(who)} has not submitted the ${r.name.toLowerCase()} for this week.`, 'warning');

    // Bins: Monday 6pm out, Tuesday 6pm back in.
    if (r.bins && wd === 1 && hour === 18)
      await once(`bins-out:${today}`, USER_IDS, 'Bins out tonight',
        `Bins go to the kerb tonight. ${nameOf(who)} is on bins this week.`, 'wastebasket');
    if (r.bins && wd === 2 && hour === 18)
      await once(`bins-in:${today}`, [who], 'Bring the bins back in', 'Bins come back from the kerb today.', 'wastebasket');
  }

  // 7pm: nudge people who have not reviewed a submitted clean.
  if (hour === 19) {
    for (const c of Object.values(cleanings)) {
      if (c.status !== 'submitted') continue;
      const to = USER_IDS.filter(u => u !== c.user && !c.approvals?.[u]);
      await once(`review:${c.rosterId}:${c.weekStart}:${today}`, to, 'Clean waiting for your review',
        `${nameOf(c.user)}'s ${rosters[c.rosterId]?.name?.toLowerCase() || 'clean'} is waiting for approval.`, 'eyes');
    }
  }

  // 9am: inspections and other dates, 3 days before, the day before and on the day.
  if (hour === 9) {
    for (const e of events) {
      const d = daysBetween(today, e.date);
      if (![3, 1, 0].includes(d)) continue;
      const when = d === 0 ? 'today' : d === 1 ? 'tomorrow' : `on ${DAY[new Date(e.date + 'T00:00:00Z').getUTCDay()]}`;
      const extra = e.kind === 'inspection' ? ' Rooms and common areas need to be clean. Clause 11.5.' : '';
      await once(`event:${e.id}:${d}`, USER_IDS, e.kind === 'inspection' ? `Inspection ${when}` : `${e.title} ${when}`,
        `${e.title}, ${e.date}${e.time ? ' at ' + e.time : ''}.${extra}${e.note ? ' ' + e.note : ''}`, 'calendar');
    }
  }

  // 9am: payments due tomorrow, today, and overdue by 2 days.
  if (hour === 9) {
    for (const def of payments.defs.filter(d => d.active)) {
      for (const due of occurrences(def, addDays(today, -2), addDays(today, 1))) {
        const d = daysBetween(today, due);
        for (const u of def.users) {
          if (payments.paid[`${def.id}:${due}:${u}`]) continue;
          const amt = `$${Number(def.amount).toFixed(2)}`;
          if (d === 1) await once(`pay:${def.id}:${due}:${u}:1`, [u], `${def.title} due tomorrow`, `${amt} due ${due}${def.payTo ? ' to ' + def.payTo : ''}.`, 'moneybag');
          if (d === 0) await once(`pay:${def.id}:${due}:${u}:0`, [u], `${def.title} due today`, `${amt} due today${def.payTo ? ' to ' + def.payTo : ''}. Mark it as paid in the app.`, 'moneybag');
          if (d === -2) await once(`pay:${def.id}:${due}:${u}:late`, [u, ...USER_IDS.filter(isAdmin)], `${def.title} overdue`,
            `${nameOf(u)}: ${amt} was due ${due} and is not marked as paid.`, 'warning');
        }
      }
    }
  }

  // Keep the sent log small.
  const cutoff = Date.now() - 45 * 864e5;
  for (const k of Object.keys(sent)) if (sent[k] < cutoff) delete sent[k];
  await save('sent', sent);
  return out;
}

export default async () => {
  const sent = await runReminders();
  return new Response(JSON.stringify({ sent }), { headers: { 'content-type': 'application/json' } });
};

export const config = { schedule: '@hourly' };
