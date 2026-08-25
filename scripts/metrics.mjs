import { fieldValue } from "./resolve.mjs";

const toNumber = (v) => {
  const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

const dollars = (n) => Math.round(n);

// GHL user records carry full names ("Rianna Nava"), but the org roster
// and every custom-field-based attribution in this file use short names
// ("Rianna"). Without normalizing, calendar/call-derived stats would land
// on a completely separate "Rianna Nava" row, split off from her real
// Setter Attribution row -- same person, silently fragmented data.
function canonicalRepName(fullName, roster) {
  if (!fullName) return fullName;
  const norm = fullName.trim().toLowerCase();
  for (const r of roster) {
    const rn = r.toLowerCase();
    if (norm === rn || norm.startsWith(rn + " ")) return r;
  }
  return fullName;
}

// Runs `fn` over `items` with at most `limit` in flight at once -- GHL rate
// limits per-location API calls, and this can mean one contact fetch per
// opportunity in the window.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function emptyRepRow() {
  return {
    outbound: 0,
    connected: 0,
    qualified: 0,
    liveTransferAttempted: 0,
    liveTransferAccepted: 0,
    appointmentsBooked: 0,
    heldCalls: 0,
    noShows: 0,
    won: 0,
    contractValue: 0,
    cashCollected: 0,
  };
}

const CONTACT_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours -- qualification fields rarely change faster than this

export async function computeMetrics({ client, shape, config, warnings, since, cache }) {
  cache.contactFields ??= {};
  cache.processedConversations ??= {};
  const roster = [...new Set([...(config.reps.setters ?? []), ...(config.reps.closers ?? [])])];
  const { fieldId, pipeline, stageBucketById, calendarId, reps } = shape;

  const funnel = { outbound: 0, connected: 0, qualified: 0, held: 0, won: 0 };
  const repRows = new Map(); // key: setter or closer name -> row
  const getRow = (name) => {
    if (!repRows.has(name)) repRows.set(name, emptyRepRow());
    return repRows.get(name);
  };

  const routingCounts = config.routingTiers.map((tier) => ({ ...tier, count: 0 }));
  const highTicketFlagged = { count: 0, routedNormally: 0 };
  const attributionChains = [];
  let cashCollectedTotal = 0;
  let contractValueTotal = 0;

  // ---------------- Opportunities: funnel, won, $, attribution ----------------
  if (pipeline) {
    let opportunities = [];
    try {
      let page = 1;
      for (;;) {
        const batch = await client.searchOpportunities({ pipelineId: pipeline.id, page });
        if (!batch.length) break;
        opportunities.push(...batch);
        page += 1;
        if (page > 50) break; // safety backstop, not a silent cap on real data volume
      }
    } catch (err) {
      warnings.push(`Failed to fetch opportunities: ${err.message}`);
    }

    opportunities = opportunities.filter((o) => new Date(o.updatedAt ?? o.createdAt ?? 0) >= since);

    // Qualification/handoff fields live on the Contact, not the
    // Opportunity (see checklist items 2-3) -- fetch each distinct contact
    // once, bounded, and merge contact fields ahead of opportunity fields
    // so contact data wins if a field somehow exists in both places.
    const contactIds = [...new Set(opportunities.map((o) => o.contactId).filter(Boolean))];
    const contactFieldsById = new Map();
    const staleContactIds = contactIds.filter((id) => {
      const cached = cache.contactFields[id];
      if (cached && Date.now() - new Date(cached.cachedAt).getTime() < CONTACT_CACHE_TTL_MS) {
        contactFieldsById.set(id, cached.fields);
        return false;
      }
      return true;
    });
    if (contactIds.length) {
      // Action-log only (not surfaced as a dashboard warning) -- confirms
      // the cache is actually cutting request volume, without alarming
      // whoever's looking at the dashboard.
      console.log(`Contact fields: ${contactIds.length - staleContactIds.length} from cache, ${staleContactIds.length} fetched fresh (of ${contactIds.length} total).`);
    }
    await mapWithConcurrency(staleContactIds, 3, async (contactId) => {
      try {
        const contact = await client.getContact(contactId);
        const fields = contact?.customFields ?? [];
        contactFieldsById.set(contactId, fields);
        cache.contactFields[contactId] = { fields, cachedAt: new Date().toISOString() };
      } catch (err) {
        warnings.push(`Failed to fetch contact ${contactId}: ${err.message}`);
        contactFieldsById.set(contactId, cache.contactFields[contactId]?.fields ?? []);
      }
    });

    // contactId -> closer name, so payment transactions (keyed by contact,
    // not opportunity) can be attributed to the right closer afterward.
    const contactToCloser = new Map();

    for (const opp of opportunities) {
      const bucket = stageBucketById.get(opp.pipelineStageId);
      const cf = [...(contactFieldsById.get(opp.contactId) ?? []), ...(opp.customFields ?? [])];

      const setter = fieldValue(cf, fieldId.setterAttribution);
      const closer = fieldValue(cf, fieldId.closerAssignment);
      const tac = toNumber(fieldValue(cf, fieldId.totalAccessibleCapital));
      const highTicket = String(fieldValue(cf, fieldId.highTicketFit) ?? "").toLowerCase() === "true";
      const liveTransferAttempted = String(fieldValue(cf, fieldId.liveTransferAttempted) ?? "").toLowerCase() === "true";
      const liveTransferAcceptedBy = fieldValue(cf, fieldId.liveTransferAcceptedBy);
      const qualifiedHeldCall = String(fieldValue(cf, fieldId.qualifiedHeldCall) ?? "").toLowerCase() === "true";
      const contractValue = toNumber(opp.monetaryValue);

      if (bucket === "connected_attempted") funnel.outbound += 1;
      if (bucket === "connected") funnel.connected += 1;
      if (bucket === "qualified") funnel.qualified += 1;
      if (qualifiedHeldCall) funnel.held += 1;
      if (opp.status === "won" || bucket === "won") funnel.won += 1;

      if (setter) {
        const row = getRow(setter);
        row.outbound += 1;
        if (bucket === "connected" || bucket === "qualified" || opp.status === "won") row.connected += 1;
        if (bucket === "qualified" || opp.status === "won") row.qualified += 1;
        if (liveTransferAttempted) row.liveTransferAttempted += 1;
        if (liveTransferAttempted && liveTransferAcceptedBy) row.liveTransferAccepted += 1;
      }

      if (closer) {
        const row = getRow(closer);
        if (qualifiedHeldCall) row.heldCalls += 1;
        if (opp.status === "won") {
          row.won += 1;
          row.contractValue += contractValue;
        }
        // Prefer the won opportunity if a contact has more than one, so a
        // stale/abandoned opportunity doesn't steal the payment credit.
        if (opp.contactId && (opp.status === "won" || !contactToCloser.has(opp.contactId))) {
          contactToCloser.set(opp.contactId, closer);
        }
      }

      if (opp.status === "won") {
        contractValueTotal += contractValue;
      }

      if (tac > 0) {
        const tier = routingCounts.find((t) => tac <= t.max);
        if (tier) tier.count += 1;
      }
      if (highTicket) {
        highTicketFlagged.count += 1;
        highTicketFlagged.routedNormally += 1; // policy: flag never overrides routing
      }

      if (setter && closer && (opp.status === "won" || qualifiedHeldCall)) {
        attributionChains.push({
          setter,
          closer,
          outcome: opp.status === "won" ? "won" : "held_call",
          value: opp.status === "won" ? contractValue : null,
        });
      }
    }

    // ---------------- Payments: real cash collected, by contact ----------------
    try {
      const transactions = await client.listTransactions({
        startAt: since.toISOString(),
        endAt: new Date().toISOString(),
      });
      const successful = transactions.filter((t) =>
        ["succeeded", "success", "paid", "completed"].includes(String(t.status ?? "").toLowerCase())
      );
      if (successful.length === 0 && transactions.length > 0) {
        warnings.push(`Found ${transactions.length} payment transaction(s) this window but none matched a known "successful" status -- check the actual status value and adjust ghl-client.mjs/metrics.mjs.`);
      }
      const cashByContact = new Map();
      for (const txn of successful) {
        const amount = toNumber(txn.amount);
        cashByContact.set(txn.contactId, (cashByContact.get(txn.contactId) ?? 0) + amount);
        cashCollectedTotal += amount;
      }
      for (const [contactId, amount] of cashByContact) {
        const closer = contactToCloser.get(contactId);
        if (closer) getRow(closer).cashCollected += amount;
      }
    } catch (err) {
      warnings.push(`Failed to fetch payment transactions: ${err.message}`);
    }
  }

  // ---------------- Calendar events: appointments, no-shows, held calls ----------------
  // Which calendar an appointment lives on tells us what KIND of held call it
  // is for activity-point purposes (org plan section: Setter/Jen Daily
  // Activity Standard) -- a showed event on the Setter Qualification
  // Calendar is a held qualification call (15 pts); a showed event on Jen's
  // own sales calendar is a held closing call for her (40 pts).
  const heldQualByRep = new Map();
  const heldClosingByRep = new Map();
  const calendarEntries = Object.entries(calendarId).filter(([, id]) => id);
  for (const [calKey, calId] of calendarEntries) {
    try {
      const events = await client.listCalendarEvents({
        calendarId: calId,
        startTime: since.getTime(),
        endTime: Date.now(),
      });
      for (const ev of events) {
        const rawOwnerName = shape.usersById.get(ev.assignedUserId)?.name
          ?? `${shape.usersById.get(ev.assignedUserId)?.firstName ?? ""}`.trim();
        const ownerName = canonicalRepName(rawOwnerName, roster);
        const row = ownerName ? getRow(ownerName) : null;
        const showed = ev.appointmentStatus === "showed" || ev.appointmentStatus === "confirmed";
        if (showed) {
          if (row) row.appointmentsBooked += 1;
          if (ownerName && calKey === "setterQualification") {
            heldQualByRep.set(ownerName, (heldQualByRep.get(ownerName) ?? 0) + 1);
          }
          if (ownerName && calKey === "jenSales") {
            heldClosingByRep.set(ownerName, (heldClosingByRep.get(ownerName) ?? 0) + 1);
          }
        }
        if (ev.appointmentStatus === "noshow") {
          if (row) row.noShows += 1;
        }
      }
    } catch (err) {
      warnings.push(`Failed to fetch events for calendar "${calKey}": ${err.message}`);
    }
  }

  // ---------------- Conversations: raw outbound call attempts + call log ----------------
  let rawOutboundCalls = 0;
  const callLog = [];
  try {
    const conversations = await client.searchConversations({
      startAfterDate: since.getTime(),
    });
    const callConversations = conversations.filter(
      (c) => c.lastMessageType === "TYPE_CALL" && c.lastMessageDirection === "outbound"
    );
    rawOutboundCalls = callConversations.length;
    if (rawOutboundCalls === 0 && conversations.length > 0) {
      warnings.push(
        "No outbound calls found in conversations for this window -- if dialing happens outside GHL's native phone system, raw attempt counts won't appear here."
      );
    }

    // Per-call detail: who called, when, what happened. Skip conversations
    // we've already pulled messages for on a previous run AND that haven't
    // changed since -- those calls are already sitting in the persisted
    // callLogHistory, so re-fetching them every 30 minutes is pure waste
    // and a big chunk of what triggered the rate-limit incident.
    const conversationsToFetch = callConversations.filter((conv) => {
      const lastSeen = cache.processedConversations[conv.id];
      return !lastSeen || lastSeen !== conv.dateUpdated;
    });
    console.log(`Conversations: ${callConversations.length - conversationsToFetch.length} already processed & unchanged, ${conversationsToFetch.length} fetched fresh (of ${callConversations.length} total).`);

    let missingFieldsSeen = false;
    await mapWithConcurrency(conversationsToFetch, 3, async (conv) => {
      try {
        const messages = await client.getConversationMessages(conv.id);
        // Confirmed against a real payload on 2026-08-25: `type` is a
        // numeric internal code (not the string enum) -- the real type
        // string lives in `messageType`. Duration lives nested under
        // `meta.call.duration`, not top-level.
        const callMsgs = messages.filter((m) => m.messageType === "TYPE_CALL" && m.direction === "outbound");
        // Only mark as "processed" if we actually extracted something --
        // otherwise a parsing mismatch would permanently blackhole this
        // conversation's calls even after the field names get fixed.
        if (callMsgs.length > 0) {
          cache.processedConversations[conv.id] = conv.dateUpdated ?? new Date().toISOString();
        }
        for (const m of callMsgs) {
          const userId = m.userId ?? m.addedBy ?? null;
          const rawSetterName = userId
            ? (shape.usersById.get(userId)?.name ?? `${shape.usersById.get(userId)?.firstName ?? ""}`.trim())
            : null;
          const setterName = rawSetterName ? canonicalRepName(rawSetterName, roster) : null;
          const status = m.status ?? m.meta?.call?.status ?? m.callStatus ?? null;
          const durationSec = m.meta?.call?.duration ?? m.callDuration ?? m.duration ?? null;
          if (!setterName && !status && durationSec == null) missingFieldsSeen = true;
          callLog.push({
            time: m.dateAdded ?? m.timestamp ?? m.createdAt ?? conv.dateUpdated ?? null,
            setter: setterName ?? "Unknown",
            contact: conv.contactName ?? conv.fullName ?? conv.contactId ?? "Unknown contact",
            status: status ?? "logged",
            durationSec,
          });
        }
      } catch (err) {
        warnings.push(`Failed to fetch messages for conversation ${conv.id}: ${err.message}`);
      }
    });
    if (missingFieldsSeen) {
      warnings.push(
        "Call log entries are missing setter/status/duration fields -- the message object's field names for these may differ from what's assumed in metrics.mjs. Check one real message payload and adjust."
      );
    }
    callLog.sort((a, b) => new Date(b.time ?? 0) - new Date(a.time ?? 0));
  } catch (err) {
    warnings.push(`Failed to fetch conversations: ${err.message}`);
  }

  const CALL_LOG_LIMIT = 150;
  if (callLog.length > CALL_LOG_LIMIT) {
    warnings.push(`Call log has ${callLog.length} entries this window -- showing the most recent ${CALL_LOG_LIMIT} only.`);
  }

  // ---------------- Activity points (org plan: 200/day standard) ----------------
  // 1 pt / outbound attempt, 15 pts / held qualification call, 40 pts / held
  // closing call (Jen only -- she's the only setter who also closes).
  // Outbound count comes from the call log (per-setter, most accurate);
  // held-call counts come from which calendar the appointment showed on.
  // Goal is 200 * windowDays as a working-day approximation -- it doesn't
  // know about weekends/PTO, so treat it as directional, not exact.
  const POINTS_PER_OUTBOUND = 1;
  const POINTS_PER_HELD_QUAL = 15;
  const POINTS_PER_HELD_CLOSE = 40;
  const GOAL_PER_DAY = 200;

  const outboundBySetter = new Map();
  for (const c of callLog) {
    outboundBySetter.set(c.setter, (outboundBySetter.get(c.setter) ?? 0) + 1);
  }

  const activityPoints = {};
  for (const name of config.reps.setters ?? []) {
    const outboundCalls = outboundBySetter.get(name) ?? 0;
    const heldQualCalls = heldQualByRep.get(name) ?? 0;
    const heldClosingCalls = name === "Jen" ? (heldClosingByRep.get(name) ?? 0) : 0;
    const points =
      outboundCalls * POINTS_PER_OUTBOUND +
      heldQualCalls * POINTS_PER_HELD_QUAL +
      heldClosingCalls * POINTS_PER_HELD_CLOSE;
    activityPoints[name] = {
      points,
      goal: GOAL_PER_DAY * config.windowDays,
      outboundCalls,
      heldQualCalls,
      heldClosingCalls,
    };
  }

  return {
    funnel: {
      outboundAttempts: rawOutboundCalls || funnel.outbound,
      connected: funnel.connected,
      qualified: funnel.qualified,
      heldCall: funnel.held,
      won: funnel.won,
    },
    routingMix: routingCounts.map((t) => ({ label: t.label, closer: t.closer, count: t.count })),
    highTicketFlagged,
    reps: Object.fromEntries(
      [...repRows.entries()].map(([name, row]) => [
        name,
        { ...row, contractValue: dollars(row.contractValue), cashCollected: dollars(row.cashCollected) },
      ])
    ),
    totals: {
      contractValue: dollars(contractValueTotal),
      cashCollected: dollars(cashCollectedTotal),
      closeRate: funnel.qualified > 0 ? Number(((funnel.won / funnel.qualified) * 100).toFixed(1)) : 0,
    },
    attributionChains: attributionChains.slice(0, 10),
    closerNames: config.reps.closers,
    setterNames: config.reps.setters,
    callLog: callLog.slice(0, CALL_LOG_LIMIT),
    activityPoints,
  };
}
