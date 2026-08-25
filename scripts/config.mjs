// Name-based configuration for the GHL data-fetch layer.
//
// Everything here is matched by NAME against your live GHL sub-account
// (custom field labels, pipeline name, stage names, calendar names) rather
// than by hardcoded ID, because IDs don't exist until you build items 1-3
// of the rollout checklist (SALES | QUALIFICATION, SALES | HANDOFF,
// standardized call outcomes as pipeline stages).
//
// If your live GHL names differ from the defaults below, override them
// with the matching environment variable (set as a GitHub Actions repo
// variable, not a secret -- these names aren't sensitive) instead of
// editing this file, so config changes don't require a code change.

const env = (key, fallback) => process.env[key]?.trim() || fallback;

export const CONFIG = {
  // Rolling window for "this week" numbers.
  windowDays: Number(env("GHL_WINDOW_DAYS", "7")),

  pipeline: {
    // The pipeline whose stages ARE the standardized call outcomes
    // (item 9 of the checklist). Each dial attempt/disposition should be
    // logged as an opportunity sitting in one of these stages.
    name: env("GHL_PIPELINE_NAME", "Sales Pipeline"),
    // Stage name -> funnel bucket. Matched case-insensitively, trimmed.
    stageBuckets: {
      "no answer": "connected_attempted",
      "voicemail left": "connected_attempted",
      "connected - follow-up": "connected",
      "connected – follow-up": "connected",
      "connected - not qualified": "connected",
      "connected – not qualified": "connected",
      "connected - not interested": "connected",
      "connected – not interested": "connected",
      "qualified - live transfer": "qualified",
      "qualified – live transfer": "qualified",
      "qualified - appointment booked": "qualified",
      "qualified – appointment booked": "qualified",
      "qualified - not yet booked": "qualified",
      "qualified – not yet booked": "qualified",
      "sales call - won": "won",
      "sales call – won": "won",
      "sales call - follow-up": "held_no_close",
      "sales call – follow-up": "held_no_close",
      "dnc": "dnc",
    },
  },

  calendars: {
    setterQualification: env("GHL_CAL_SETTER", "Setter Qualification Calendar"),
    jenSales: env("GHL_CAL_JEN", "Jen Sales Calendar"),
    jercoriHighTicket: env("GHL_CAL_JERCORI", "Jercori Sales Calendar"),
  },

  // Custom field labels exactly as specified for SALES | QUALIFICATION and
  // SALES | HANDOFF (items 2-3 of the checklist). These are resolved to
  // field IDs at runtime via GET /locations/{locationId}/customFields --
  // nothing here needs to be an ID.
  fields: {
    primaryGoal: env("GHL_FIELD_PRIMARY_GOAL", "Primary Goal"),
    primaryProblem: env("GHL_FIELD_PRIMARY_PROBLEM", "Primary Problem / Gap"),
    timingUrgency: env("GHL_FIELD_TIMING", "Timing / Urgency"),
    decisionMakerStatus: env("GHL_FIELD_DECISION_MAKER", "Decision-Maker Status"),
    personalMonthlyIncome: env("GHL_FIELD_PERSONAL_INCOME", "Personal Monthly Income"),
    businessMonthlyIncome: env("GHL_FIELD_BUSINESS_INCOME", "Business Monthly Income / Cash Flow"),
    personalMonthlyExpenses: env("GHL_FIELD_PERSONAL_EXPENSES", "Personal Monthly Expenses"),
    personalLiquidCapital: env("GHL_FIELD_PERSONAL_LIQUID", "Personal Liquid Capital"),
    businessLiquidCapital: env("GHL_FIELD_BUSINESS_LIQUID", "Business Liquid Capital"),
    availablePersonalCredit: env("GHL_FIELD_PERSONAL_CREDIT", "Available Personal Credit"),
    availableBusinessCredit: env("GHL_FIELD_BUSINESS_CREDIT", "Available Business Credit"),
    totalAccessibleCapital: env("GHL_FIELD_TAC", "Total Accessible Capital"),
    routingTier: env("GHL_FIELD_ROUTING_TIER", "Routing Tier"),
    highTicketFit: env("GHL_FIELD_HIGH_TICKET", "Potential High-Ticket Fit"),
    setterAttribution: env("GHL_FIELD_SETTER_ATTR", "Setter Attribution"),
    closerAssignment: env("GHL_FIELD_CLOSER_ASSIGN", "Closer Assignment"),

    handoffType: env("GHL_FIELD_HANDOFF_TYPE", "Handoff Type"),
    // "Lost Reason" is intentionally not here: it's a native opportunity
    // field ({{opportunity.lost_reason}}), not a custom field, so it isn't
    // resolved through the customFields lookup at all. Read it directly
    // off the opportunity as opp.lostReason if it's ever needed here.
    // "Cash Collected" is intentionally not here either -- it comes from
    // real GHL Payments transactions (client.listTransactions), not a
    // custom field. See metrics.mjs.
    //
    // Confirmed with the user on 2026-08-25 that the standalone SALES |
    // HANDOFF field group was deleted (Handoff Type now lives inside
    // SALES | QUALIFICATION instead, see above). These are intentionally
    // NOT listed here anymore -- listing them just produced permanent
    // "not found" warnings for fields that no longer exist:
    //   - Overall Qualification, Prospect Available Now? -- weren't
    //     consumed by any metric anyway.
    //   - Live Transfer Attempted? -- replaced by checking whether the
    //     opportunity is currently in the "Qualified - Live Transfer"
    //     pipeline stage (a real, still-existing stage). See metrics.mjs.
    //   - Live Transfer Accepted By, Qualified Held Call -- no field-based
    //     substitute exists; Qualified Held Call now comes from calendar
    //     show-ups instead (see metrics.mjs). Live Transfer Accepted has
    //     no remaining data source at all -- would need a new field or
    //     stage-history logging to bring back.
  },

  routingTiers: [
    { max: 10000, label: "Under $10k", closer: "Jen" },
    { max: 19999.99, label: "$10k-$19,999", closer: "50/50" },
    { max: Infinity, label: "$20k+", closer: "Jercori" },
  ],

  reps: {
    // Per the approved sales org plan: Jercori is Head of Sales / closer,
    // Jen is a hybrid setter-closer (closes her own opportunities $5k and
    // under, otherwise routes up), Marshell and Rianna are dedicated
    // setters. Jen intentionally appears in BOTH lists -- the dashboard
    // shows her in both the Setters and Closers tables, not one or the
    // other, because she genuinely does both jobs.
    setters: ["Marshell", "Rianna", "Jen"],
    closers: ["Jen", "Jercori"],
  },
};
