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

## What's genuinely uncertain

I built `scripts/ghl-client.mjs` against my best knowledge of GHL's v2 API
contract, but couldn't render GHL's own API reference from this environment
(it's a JS-rendered page) to verify every exact parameter name — GHL's API
is also known to mix camelCase and snake_case across a few endpoints. If a
call 400s, the Action log includes GHL's own error message; that's almost
always a one-line fix in `ghl-client.mjs`. Paste the log output back to me
and I'll fix it directly.

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
