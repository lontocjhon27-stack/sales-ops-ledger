import { fieldValue } from "./resolve.mjs";

const toNumber = (v) => {
  const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

const dollars = (n) => Math.round(n);

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

    for (const opp of opportunities) {
      const bucket = stageBucketById.get(opp.pipelineStageId);
      const cf = opp.customFields ?? [];

      const setter = fieldValue(cf, fieldId.setterAttribution);
      const closer = fieldValue(cf, fieldId.closerAssignment);
      const tac = toNumber(fieldValue(cf, fieldId.totalAccessibleCapital));
      const highTicket = String(fieldValue(cf, fieldId.highTicketFit) ?? "").toLowerCase() === "true";
      const liveTransferAttempted = String(fieldValue(cf, fieldId.liveTransferAttempted) ?? "").toLowerCase() === "true";
      const liveTransferAcceptedBy = fieldValue(cf, fieldId.liveTransferAcceptedBy);
      const qualifiedHeldCall = String(fieldValue(cf, fieldId.qualifiedHeldCall) ?? "").toLowerCase() === "true";
      const cashCollected = toNumber(fieldValue(cf, fieldId.cashCollected));
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
          row.cashCollected += cashCollected;
        }
      }

      if (opp.status === "won") {
        contractValueTotal += contractValue;
        cashCollectedTotal += cashCollected;
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

  // ---------------- Conversations: raw outbound call attempts ----------------
  let rawOutboundCalls = 0;
  try {
    const conversations = await client.searchConversations({
      startAfterDate: since.getTime(),
    });
    rawOutboundCalls = conversations.filter(
      (c) => c.lastMessageType === "TYPE_CALL" && c.lastMessageDirection === "outbound"
    ).length;
    if (rawOutboundCalls === 0 && conversations.length > 0) {
      warnings.push(
        "No outbound calls found in conversations for this window -- if dialing happens outside GHL's native phone system, raw attempt counts won't appear here."
      );
    }
  } catch (err) {
    warnings.push(`Failed to fetch conversations: ${err.message}`);
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
  };
}
