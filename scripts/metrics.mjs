import { fieldValue } from "./resolve.mjs";

const toNumber = (v) => {
  const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

const dollars = (n) => Math.round(n);

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

export async function computeMetrics({ client, shape, config, warnings, since }) {
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
    await mapWithConcurrency(contactIds, 5, async (contactId) => {
      try {
        const contact = await client.getContact(contactId);
        contactFieldsById.set(contactId, contact?.customFields ?? []);
      } catch (err) {
        warnings.push(`Failed to fetch contact ${contactId}: ${err.message}`);
        contactFieldsById.set(contactId, []);
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
  const calendarEntries = Object.entries(calendarId).filter(([, id]) => id);
  for (const [calKey, calId] of calendarEntries) {
    try {
      const events = await client.listCalendarEvents({
        calendarId: calId,
        startTime: since.getTime(),
        endTime: Date.now(),
      });
      for (const ev of events) {
        const ownerName = shape.usersById.get(ev.assignedUserId)?.name
          ?? `${shape.usersById.get(ev.assignedUserId)?.firstName ?? ""}`.trim();
        const row = ownerName ? getRow(ownerName) : null;
        if (ev.appointmentStatus === "showed" || ev.appointmentStatus === "confirmed") {
          if (row) row.appointmentsBooked += 1;
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

    // Per-call detail: who called, when, what happened. Bounded concurrency
    // since this is one extra request per conversation with an outbound call.
    let missingFieldsSeen = false;
    await mapWithConcurrency(callConversations, 5, async (conv) => {
      try {
        const messages = await client.getConversationMessages(conv.id);
        const callMsgs = messages.filter((m) => (m.type ?? m.messageType) === "TYPE_CALL" && m.direction === "outbound");
        for (const m of callMsgs) {
          const userId = m.userId ?? m.addedBy ?? null;
          const setterName = userId
            ? (shape.usersById.get(userId)?.name ?? `${shape.usersById.get(userId)?.firstName ?? ""}`.trim())
            : null;
          const status = m.status ?? m.callStatus ?? null;
          const durationSec = m.callDuration ?? m.duration ?? null;
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
  };
}
