import { writeFile, readFile } from "node:fs/promises";
import { createClient, GhlError } from "./ghl-client.mjs";
import { resolveAccountShape } from "./resolve.mjs";
import { computeMetrics } from "./metrics.mjs";
import { CONFIG } from "./config.mjs";

const DATA_PATH = new URL("../data.json", import.meta.url);
const MAX_HISTORY = 100;
const MAX_CALL_LOG_HISTORY = 5000;
const CALL_LOG_HISTORY_MAX_AGE_DAYS = 120;

async function loadPrevious() {
  try {
    const prev = JSON.parse(await readFile(DATA_PATH, "utf8"));
    return {
      history: Array.isArray(prev?.history) ? prev.history : [],
      callLogHistory: Array.isArray(prev?.callLogHistory) ? prev.callLogHistory : [],
    };
  } catch {
    return { history: [], callLogHistory: [] };
  }
}

// Each sync only re-fetches the trailing windowDays, so the same real calls
// show up again every run -- merge into the running history instead of
// replacing it, deduped by a stable key, so a date-range picker on the
// frontend has more than just the current window to filter.
function mergeCallLogHistory(previous, freshCalls) {
  const byKey = new Map(previous.map((c) => [`${c.time}|${c.setter}|${c.contact}`, c]));
  for (const c of freshCalls) {
    byKey.set(`${c.time}|${c.setter}|${c.contact}`, c);
  }
  const cutoff = Date.now() - CALL_LOG_HISTORY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  return [...byKey.values()]
    .filter((c) => c.time && new Date(c.time).getTime() >= cutoff)
    .sort((a, b) => new Date(b.time) - new Date(a.time))
    .slice(0, MAX_CALL_LOG_HISTORY);
}

async function main() {
  const token = process.env.GHL_PIT;
  const locationId = process.env.GHL_LOCATION_ID;
  const warnings = [];

  const previous = await loadPrevious();
  const output = {
    generatedAt: new Date().toISOString(),
    windowDays: CONFIG.windowDays,
    ok: false,
    warnings,
    data: null,
    history: previous.history,
    callLogHistory: previous.callLogHistory,
  };

  try {
    const client = createClient({ token, locationId });
    const shape = await resolveAccountShape(client, CONFIG, warnings);
    const since = new Date(Date.now() - CONFIG.windowDays * 24 * 60 * 60 * 1000);
    const metrics = await computeMetrics({ client, shape, config: CONFIG, warnings, since });

    output.ok = true;
    output.data = metrics;
    output.history = [
      ...output.history,
      { t: output.generatedAt, closeRate: metrics.totals.closeRate },
    ].slice(-MAX_HISTORY);
    output.callLogHistory = mergeCallLogHistory(previous.callLogHistory, metrics.callLog ?? []);
  } catch (err) {
    const detail = err instanceof GhlError
      ? `${err.message} -- ${JSON.stringify(err.body)}`
      : err.stack || err.message;
    warnings.unshift(`Run failed: ${detail}`);
    console.error(detail);
  }

  await writeFile(new URL("../data.json", import.meta.url), JSON.stringify(output, null, 2) + "\n");

  console.log(`Wrote data.json -- ok=${output.ok}, warnings=${warnings.length}`);
  for (const w of warnings) console.log(" - " + w);

  // Non-zero exit on hard failure so the Action run is visibly red,
  // but NOT on warnings alone (partial data is still useful to publish).
  if (!output.ok) process.exitCode = 1;
}

main();
