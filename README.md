# Sales Ops Ledger

Live sales reporting dashboard, embedded into GHL as a Custom Menu Link
iframe. Static frontend on GitHub Pages; a scheduled GitHub Action pulls
data from the GoHighLevel API and writes `data.json`, which the page reads
client-side. No server, no exposed token.

## One-time setup

1. **Add two repo secrets** (Settings → Secrets and variables → Actions → New repository secret):
   - `GHL_PIT` — your Private Integration Token (starts with `pit-`). **Rotate it first** if it's ever been pasted anywhere outside GitHub's own secret form.
   - `GHL_LOCATION_ID` — your GHL sub-account's Location ID (Settings → Business Profile in GHL).

2. **Build the GHL side first, if you haven't.** This dashboard reads data by matching *names* — custom field labels, the pipeline name, its stage names, calendar names — against what's configured in `scripts/config.mjs`. If items 1-3 and 9 of the rollout checklist (SALES | QUALIFICATION, SALES | HANDOFF, standardized call outcomes as pipeline stages) haven't been built in GHL yet with those exact names, the sync will run but report "not found" warnings instead of numbers — it won't fabricate data.

   If your actual GHL names differ from the defaults in `config.mjs`, override them with matching repo **variables** (not secrets — these aren't sensitive) instead of editing code. E.g. if your pipeline is called "2026 Sales Funnel" instead of "Sales Pipeline", add a repo variable `GHL_PIPELINE_NAME` = `2026 Sales Funnel`. See the `env(...)` calls in `scripts/config.mjs` for every override name.

3. **Run it once manually**: repo → Actions tab → "Refresh Sales Data" → Run workflow. Then check the run's log — it prints every warning in plain English (missing fields, missing pipeline, zero outbound calls, etc). Fix what's fixable in GHL, re-run, repeat until the warnings list looks right.

After that it runs automatically every 30 minutes and commits `data.json` only when something changed.

## Rep roster

Per the approved sales org plan: **Jercori** (Head of Sales) and **Jen**
(hybrid) are closers; **Marshell**, **Rianna**, and **Jen** are setters. Jen
is intentionally on both lists in `scripts/config.mjs` — she prospects her
own queue between closing calls, so the dashboard shows her in both the
Setters and Closers tables with her real numbers in each, not one or the
other.

## Reporting checklist vs. the org plan (section 23)

What the dashboard covers today, reconciled against the exact KPI list in
the approved sales org plan:

**Setter Performance** — Activity points ✅ · Outbound attempts ✅ ·
Connections ✅ · Qualified prospects ✅ · Appointments booked ✅ (KPI tile
only, not yet a table column) · Qualified Held Calls ✅ · Attributed sales
✅ (attribution chains) — **not built**: unique contacts attempted,
meaningful conversations, show rate, speed to lead, attributed collected
revenue (cash collected is only closer-attributed right now, not setter-attributed).

**Closer Performance** — Qualified Held Calls ✅ · Close rate ✅ · Sales
closed ✅ · Contracted revenue ✅ · Cash collected ✅ — **not built**:
average sale, revenue per held call, open follow-up opportunities.

**Company** — Sales closed ✅ · Cash collected ✅ · Close rate ✅ · Revenue
by rep ✅ — **not built**: new leads, lead-source volume, show rate,
average sale, revenue per held call, revenue by source/product, refunds,
chargebacks. Most of these need fields we're not fetching yet (Original
Lead Source, Product, invoice-level refund status) — buildable, just ask
for the specific one that matters next.

## Rate limiting

GHL rate-limits per location. As real lead volume grows, this sync makes
more API calls per run (one contact fetch per opportunity, one message
fetch per outbound call), and a run on 2026-08-25 hit 429s across most
endpoints for the first time. `ghl-client.mjs`'s `request()` now retries
automatically on 429/5xx with backoff (honoring `Retry-After` when GHL
sends it), and contact/message fetch concurrency dropped from 5 to 3. If
runs start taking noticeably longer or still show 429 warnings, the next
lever is fetching contacts in bulk (a `/contacts/search` batch call instead
of one request per contact) rather than more backoff.

## Call history & date range

Every sync only re-fetches the trailing `windowDays` window, but
`fetch-data.mjs` now merges each run's calls into a persistent
`callLogHistory` array in `data.json` (deduped, capped at 5000 entries /
120 days) instead of overwriting it. The date-range picker on the "Call log
by setter" panel (click the date chip top-right) filters that accumulated
history client-side and shows a per-setter call count for whatever range
you pick — that's how you see "how many calls did Marshell make last
Tuesday" instead of just the current week.

This only affects the call log panel. Every other number on the page (KPI
tiles, funnel, tables) still reflects the fixed trailing window from the
most recent sync — turning those into true date-range queries would need
daily buckets for every metric, not just calls, which is a bigger change.

## Activity points (200/day standard)

Computed per the org plan's exact formula: 1 pt per outbound call (from the
call log), 15 pts per held qualification call (a "showed" event on the
**Setter Qualification Calendar**), 40 pts per held closing call for Jen
only (a "showed" event on **Jen Sales Calendar**). Jercori has no points
quota in the org plan, so she's excluded.

The goal shown is `200 × windowDays` — a working-day approximation. It
doesn't know about weekends or PTO, so a 7-day window assumes 7 full working
days. If that's not accurate enough, the fix is tracking daily buckets
instead of one weekly total — a bigger change, ask if you want it.

## Private Integration scopes

The code only calls these endpoints — grant exactly these, nothing else:

- View Contacts — `contacts.readonly`
- View Custom Fields — `locations/customFields.readonly`
- View Opportunities — `opportunities.readonly`
- pipelinesreadonly — `pipelines.readonly`
- View Calendars — `calendars.readonly`
- View Calendar Events — `calendars/events.readonly`
- View Conversations — `conversations.readonly`
- View Conversation Messages — `conversations/message.readonly` (needed for the per-call log — who called, when, outcome, duration)
- View Users — `users.readonly`
- View Payment Transactions — `payments/transactions.readonly` (Cash Collected is read from real GHL Payments transactions, not a custom field)

No `.write` scopes anywhere — this integration only ever reads.

## What's genuinely uncertain

I built `scripts/ghl-client.mjs` against my best knowledge of GHL's v2 API
contract, but couldn't render GHL's own API reference from this environment
(it's a JS-rendered page) to verify every exact parameter name — GHL's API
is also known to mix camelCase and snake_case across a few endpoints. If a
call 400s, the Action log includes GHL's own error message; that's almost
always a one-line fix in `ghl-client.mjs`. Paste the log output back to me
and I'll fix it directly.

**Payments/transactions is the newest, least-verified piece.** It assumes
GHL's Payments API takes `altId`/`altType=location` instead of `locationId`
(a real quirk on some GHL Payments endpoints, per general knowledge, not
confirmed against a live response), and that transaction amounts are plain
decimal dollars, not cents. If the Action log shows a 400 here, or "Cash
Collected" comes back 100x too big/small, that's the first thing to check
in `ghl-client.mjs`'s `listTransactions`.

**The call log (`data.callLog`) is the newest and least-verified piece.**
It reads `userId`/`status`/`callDuration` off each call message and assumes
those exact field names — I couldn't confirm them against a live response.
If entries show "Unknown" setters or every duration comes back "—", that's
the signal to open one real message payload (log it in `fetch-data.mjs`
temporarily) and fix the field names in `metrics.mjs`'s call-log block.

**"Outbound Attempts" is the shakiest metric.** It's read from GHL's native
Conversations API filtered to outbound calls. If your setters dial through
an external tool instead of GHL's built-in phone system, this will read 0
forever — that's a real gap in the original spec, not a bug: nothing in
items 1-16 defines a manual "log this attempt" mechanism outside actual
dialing.

## Files

- `scripts/config.mjs` — name mappings (override via repo variables)
- `scripts/ghl-client.mjs` — raw API client
- `scripts/resolve.mjs` — name → ID resolution + missing-thing warnings
- `scripts/metrics.mjs` — aggregation into the dashboard's data shape
- `scripts/fetch-data.mjs` — entry point, writes `data.json`
- `.github/workflows/refresh-data.yml` — the schedule
- `render.js` — reads `data.json` and populates `index.html` at load
- `data.json` — generated; do not hand-edit (the placeholder shipped here
  is what renders until the first successful sync)
