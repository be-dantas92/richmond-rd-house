# Richmond Rd house app

Single-page app (`public/index.html`, vanilla JS, no build step) with two Netlify Functions and Netlify Blobs for storage.

- `netlify/functions/api.mjs` — sign-in, data and photo upload (`/api/*`)
- `netlify/functions/reminders.mjs` — runs hourly and sends reminders on Brisbane time
- `lib/core.mjs` — shared logic (rosters, PINs, notifications)

## Deploy

1. Push this folder to a new GitHub repo and connect it to a new Netlify site. No build command; publish directory is `public` (set in `netlify.toml`).
2. In Site configuration > Environment variables, add:
   - `SESSION_SECRET` — a long random string (e.g. `openssl rand -hex 32`)
   - `SETUP_CODE` — any code you choose, used once to set up the house
   - `NTFY_SERVER` — optional, defaults to `https://ntfy.sh`
3. Trigger a redeploy so the variables apply.
4. Open the site, enter the setup code, set everyone's PIN and the cleaning order.
5. Each person: sign in, go to Me, install the ntfy app and subscribe to their topic, then send a test.

## Reminder schedule (Brisbane time)

| When | Who | What |
|---|---|---|
| Sunday 9am | Everyone | Who is on each roster this week |
| Sun–Wed at the roster's reminder time (default 6pm) | Person on duty | Clean reminder, until photos are submitted |
| Monday 6pm | Everyone | Bins out tonight, naming who is on bins |
| Tuesday 6pm | House-clean person | Bring bins back in |
| Thursday 9am | Everyone | Clean not submitted |
| Daily 7pm | Anyone who has not reviewed | Clean waiting for approval |
| 9am, 3 days before / day before / on the day | Everyone | Inspections and other dates |
| 9am, day before / on the day | Payer | Payment due |
| 9am, 2 days overdue | Payer and Bernard | Payment overdue |

Instant notifications: new notice, new date, submitted clean, approval or rejection, swap request and answer, payment marked paid.

A clean is approved once 2 other people approve it (`REQUIRED_APPROVALS` in `lib/core.mjs`).

Scheduled functions only run on the published production deploy.
