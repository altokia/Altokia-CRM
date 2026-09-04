# Scheduled jobs (cron)

Nothing inside the app runs on a timer by itself. Three routes do
time-based work, and each one only acts when something external calls
it. On a server that is a system cron; on Hostinger it is the hPanel
cron; on Vercel it is a Vercel Cron entry. Any of them just has to make
a GET request every few minutes with a shared secret.

| Route | What it does | Suggested interval |
|---|---|---|
| `GET /api/automations/cron` | Resumes automation **Wait** steps whose time has come. | every 1–5 min |
| `GET /api/flows/cron` | Sweeps stale flow runs. | every 5 min |
| `GET /api/tasks/cron` | **Shift-start review**: retries routing for every task still waiting for a person (the lead that arrived at 13:00 for the 15:00 specialist gets assigned at 15:00), and sends one *due* reminder per task. | every 1–5 min |

All three read the same secret from the environment:

```
AUTOMATION_CRON_SECRET=<any long random string>
```

Generate one with `openssl rand -hex 32` (or
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
and send it in the `x-cron-secret` header. A route answers **503** while
the variable is unset and **401** when the header does not match, so a
misconfigured scheduler is loud, not silent.

## Examples

Linux / VPS (`crontab -e`):

The first line is not optional: `cron` does not inherit your interactive
shell, so without it the three requests send an empty header and every
one of them answers 401 — silently, since `-fsS` prints nothing on a
clean failure. Use the same value as `AUTOMATION_CRON_SECRET`.

```
CRON_SECRET=<the same value as AUTOMATION_CRON_SECRET>
*/2 * * * * curl -fsS -H "x-cron-secret: $CRON_SECRET" https://crm.example.com/api/tasks/cron >/dev/null
*/2 * * * * curl -fsS -H "x-cron-secret: $CRON_SECRET" https://crm.example.com/api/automations/cron >/dev/null
*/5 * * * * curl -fsS -H "x-cron-secret: $CRON_SECRET" https://crm.example.com/api/flows/cron >/dev/null
```

On a panel that offers no place to declare a variable (Hostinger's
hPanel among them), write the secret literally into each command.

Hostinger hPanel → **Advanced → Cron Jobs**: same commands, one job
each.

Local development (the dev server must be running and the variable set
in `.env.local`):

```
curl -H "x-cron-secret: <secret>" http://localhost:3000/api/tasks/cron
```

## What the tasks cron reports

```json
{ "retried": 3, "assigned": 1, "reminded": 0 }
```

`retried` is how many waiting tasks were re-evaluated, `assigned` how
many found an available advisor this time, `reminded` how many due
reminders went out. Each pass is bounded to 50 tasks per account and is
safe to overlap: assignments go through the same claim-style updates
the rest of the app uses, and a reminder is sent at most once per task
(`tasks.due_notified_at`).

## Why every few minutes, not exactly at shift start

Shifts are evaluated in the account's time zone (`accounts.timezone`)
by `lib/availability`, and the cron simply asks "is anyone suitable
available *now*?". Running it every couple of minutes means a 15:00
shift picks its waiting leads up by 15:02 at the latest, without the
scheduler needing to know anyone's hours.
