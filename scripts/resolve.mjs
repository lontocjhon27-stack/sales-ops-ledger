// Resolves human-readable names (from config.mjs) to the IDs the GHL API
// actually needs, and records anything expected-but-missing so the run
// surfaces gaps instead of silently reporting zeros.

const norm = (s) => (s ?? "").toString().trim().toLowerCase();

async function safe(label, promise, warnings, fallback = []) {
  const result = await Promise.allSettled([promise]);
  const [outcome] = result;
  if (outcome.status === "fulfilled") return outcome.value;
  warnings.push(`Failed to fetch ${label}: ${outcome.reason?.message ?? outcome.reason}`);
  return fallback;
}

export async function resolveAccountShape(client, config, warnings) {
  // Each call fails independently so one wrong endpoint doesn't hide
  // whether the other three actually worked.
  const [users, customFields, pipelines, calendars] = await Promise.all([
    safe("users", client.listUsers(), warnings),
    safe("custom fields", client.listCustomFields(), warnings),
    safe("pipelines", client.listPipelines(), warnings),
    safe("calendars", client.listCalendars(), warnings),
  ]);

  // --- users: map id -> display name, and find Jen / Jercori by name ---
  const usersById = new Map(users.map((u) => [u.id, u]));
  const findUserByName = (name) => {
    const match = users.find((u) => norm(`${u.firstName ?? ""} ${u.lastName ?? ""}`).includes(norm(name)) || norm(u.name).includes(norm(name)));
    if (!match) warnings.push(`No GHL user found matching rep name "${name}" -- check users are named/invited as expected.`);
    return match ?? null;
  };
  const reps = {
    jen: findUserByName("Jen"),
    jercori: findUserByName("Jercori"),
  };

  // --- custom fields: label -> field id ---
  const fieldIdByLabel = new Map(customFields.map((f) => [norm(f.name ?? f.fieldKey), f.id]));
  const fieldId = {};
  for (const [key, label] of Object.entries(config.fields)) {
    const id = fieldIdByLabel.get(norm(label));
    if (!id) {
      warnings.push(`Custom field "${label}" not found in this location -- has SALES | QUALIFICATION / SALES | HANDOFF (items 2-3) been built yet?`);
    }
    fieldId[key] = id ?? null;
  }

  // --- pipeline + stages: stage name -> {id, bucket} ---
  const pipeline = pipelines.find((p) => norm(p.name) === norm(config.pipeline.name));
  if (!pipeline) {
    warnings.push(`Pipeline "${config.pipeline.name}" not found -- outbound/funnel/won metrics will be empty until it exists.`);
  }
  const stageBucketById = new Map();
  // SALES | HANDOFF (the field group tracking Live Transfer Attempted/
  // Accepted) was deleted from this location -- "Qualified - Live Transfer"
  // is its own real pipeline stage though, so an opportunity sitting there
  // right now is a legitimate substitute signal for "attempted."
  const liveTransferStageIds = new Set();
  if (pipeline) {
    for (const stage of pipeline.stages ?? []) {
      const bucket = config.pipeline.stageBuckets[norm(stage.name)];
      if (!bucket) {
        warnings.push(`Pipeline stage "${stage.name}" doesn't match an expected disposition name -- it won't be counted in the funnel. Check item 9's approved dispositions list.`);
        continue;
      }
      stageBucketById.set(stage.id, bucket);
      if (norm(stage.name) === "qualified - live transfer") liveTransferStageIds.add(stage.id);
    }
  }

  // --- calendars: label -> id ---
  const calendarIdByLabel = new Map(calendars.map((c) => [norm(c.name), c.id]));
  const calendarId = {};
  for (const [key, label] of Object.entries(config.calendars)) {
    const id = calendarIdByLabel.get(norm(label));
    if (!id) warnings.push(`Calendar "${label}" not found -- appointment/no-show metrics for it will be empty.`);
    calendarId[key] = id ?? null;
  }

  return { usersById, reps, fieldId, pipeline, stageBucketById, liveTransferStageIds, calendarId };
}

export function fieldValue(customFieldsArray, fieldId) {
  if (!fieldId || !Array.isArray(customFieldsArray)) return null;
  const entry = customFieldsArray.find((f) => f.id === fieldId);
  return entry?.value ?? entry?.fieldValue ?? null;
}
