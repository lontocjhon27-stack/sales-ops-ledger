import { writeFile, readFile } from "node:fs/promises";
import { createClient, GhlError } from "./ghl-client.mjs";
import { resolveAccountShape } from "./resolve.mjs";
import { computeMetrics } from "./metrics.mjs";
import { CONFIG } from "./config.mjs";

const DATA_PATH = new URL("../data.json", import.meta.url);
const MAX_HISTORY = 100;

async function loadPreviousHistory() {
  try {
    const prev = JSON.parse(await readFile(DATA_PATH, "utf8"));
    return Array.isArray(prev?.history) ? prev.history : [];
  } catch {
    return [];
  }
}

async function main() {
  const token = process.env.GHL_PIT;
  const locationId = process.env.GHL_LOCATION_ID;
  const warnings = [];

  const output = {
    generatedAt: new Date().toISOString(),
    windowDays: CONFIG.windowDays,
    ok: false,
    warnings,
    data: null,
    history: await loadPreviousHistory(),
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
