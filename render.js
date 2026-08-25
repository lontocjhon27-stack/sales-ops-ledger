// Renders the Sales Ops Ledger dashboard from ./data.json.
// Falls back to the static sample markup already in index.html when no
// live sync has run yet (data.ok === false) -- that markup IS the fallback
// state, so this script only overwrites it once real data exists.

const fmtMoney = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
};
const fmtInt = (n) => Number(n ?? 0).toLocaleString("en-US");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const initials = (name) => {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
};
const colorFor = (i) => (i % 2 === 0 ? "var(--primary)" : "var(--accent)");

function setKpi(id, value, note) {
  const el = document.getElementById(id);
  if (!el) return;
  el.querySelector(".kpi-value").textContent = value;
  const delta = el.querySelector(".kpi-delta");
  delta.className = "kpi-delta flat";
  delta.textContent = note;
  el.querySelector(".kpi-spark")?.remove();
}

function renderBadgeLive(generatedAt) {
  const badge = document.getElementById("statusBadge");
  badge.classList.remove("sample-badge");
  badge.style.background = "var(--good-soft)";
  badge.style.color = "var(--good)";
  const when = new Date(generatedAt);
  badge.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M9 12.5 11 15l4.5-5.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/></svg> LIVE &middot; synced ${when.toLocaleString("en-US", { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })}`;
}

function renderWarnings(warnings) {
  if (!warnings?.length) return;
  const host = document.querySelector(".shell main");
  const box = document.createElement("section");
  box.innerHTML = `
    <div class="panel" style="border-color:var(--warn-soft)">
      <h3 style="color:var(--warn)">Sync notes (${warnings.length})</h3>
      <p class="sub">Things worth checking in your GHL setup before trusting every number below.</p>
      <ul style="margin:0; padding-left:18px; display:flex; flex-direction:column; gap:6px; font-size:12.5px; color:var(--ink-muted)">
        ${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}
      </ul>
    </div>`;
  host.insertBefore(box, host.firstChild);
}

function renderFunnel(funnel) {
  const stages = [
    { key: "outboundAttempts", name: "Outbound Attempts" },
    { key: "connected", name: "Connected" },
    { key: "qualified", name: "Qualified" },
    { key: "heldCall", name: "Held Call" },
    { key: "won", name: "Won" },
  ];
  const max = funnel.outboundAttempts || 1;
  let worstPct = 100, worstIdx = -1;
  const rows = stages.map((s, i) => {
    const value = funnel[s.key] ?? 0;
    const widthPct = Math.max((value / max) * 100, value > 0 ? 2 : 0);
    let pctLabel = "&mdash;";
    if (i > 0) {
      const prev = funnel[stages[i - 1].key] || 0;
      const conv = prev > 0 ? (value / prev) * 100 : 0;
      pctLabel = `${conv.toFixed(1)}%`;
      if (conv < worstPct) { worstPct = conv; worstIdx = i; }
    }
    return { name: s.name, value, widthPct, pctLabel };
  });

  const FUNNEL_ICONS = [
    '<path d="M7 17 17 7"/><path d="M9 7h8v8"/>',
    '<path d="M9 15l6-6"/><path d="M8 12.5 5.8 14.7a3 3 0 1 0 4.2 4.2L12.2 16.7"/><path d="M16 11.5l2.2-2.2a3 3 0 1 0-4.2-4.2L11.8 7.3"/>',
    '<circle cx="12" cy="12" r="8.2"/><path d="M8.5 12.3l2.3 2.3 4.7-4.9"/>',
    '<path d="M4.5 13.2a7.5 7.5 0 0 1 15 0"/><rect x="3.2" y="13" width="4" height="6.2" rx="1.6"/><rect x="16.8" y="13" width="4" height="6.2" rx="1.6"/><path d="M19.3 19.2v.6a2.2 2.2 0 0 1-2.2 2.2h-2.6"/>',
    '<path d="M12 3.2l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 15.5l-4.8 2.6.9-5.4-3.9-3.8 5.4-.8z"/>',
  ];

  document.getElementById("funnelRows").innerHTML = rows
    .map((r, i) => `
      <div class="funnel-row">
        <span class="funnel-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${FUNNEL_ICONS[i]}</svg></span>
        <span class="funnel-name">${esc(r.name)}</span>
        <div class="funnel-track"><div class="funnel-fill" style="width:${r.widthPct}%"><span>${fmtInt(r.value)}</span></div></div>
        <span class="funnel-pct${i === worstIdx ? " worst" : ""}">${r.pctLabel}</span>
      </div>`)
    .join("");

  const noteEl = document.getElementById("funnelNote");
  if (worstIdx > 0) {
    noteEl.textContent = `Biggest drop is ${rows[worstIdx - 1].name} → ${rows[worstIdx].name} (${(100 - worstPct).toFixed(1)}% lost).`;
  } else {
    noteEl.textContent = "Not enough volume yet this window to identify the biggest drop-off stage.";
  }
}

function renderRouting(routingMix, highTicketFlagged) {
  const total = routingMix.reduce((s, t) => s + t.count, 0);
  const colors = ["var(--primary)", "color-mix(in srgb, var(--primary) 50%, var(--accent) 50%)", "var(--accent)"];
  const CIRCUMFERENCE = 339.3; // 2 * pi * r54

  document.getElementById("routingTotal").textContent = fmtInt(total);

  let cursor = 0;
  routingMix.forEach((t, i) => {
    const circle = document.getElementById(`routingSeg${i}`);
    if (!circle) return;
    const share = total > 0 ? t.count / total : 0;
    const arc = share * CIRCUMFERENCE;
    circle.setAttribute("stroke-dasharray", `${arc.toFixed(1)} ${CIRCUMFERENCE}`);
    circle.setAttribute("stroke-dashoffset", `${-cursor.toFixed(1)}`);
    circle.style.opacity = total === 0 ? "0" : "1";
    cursor += arc;
  });

  document.getElementById("routingLegend").innerHTML = routingMix
    .map((t, i) => `<div class="routing-item"><span class="routing-swatch" style="background:${colors[i] ?? "var(--accent)"}"></span><span class="who">${esc(t.label)} TAC &middot; ${esc(t.closer)}</span><span class="count mono">${fmtInt(t.count)} leads</span></div>`)
    .join("");

  document.getElementById("highTicketNote").textContent =
    `${fmtInt(highTicketFlagged?.count ?? 0)} leads marked High-Ticket Fit this window — held for review, routing unchanged per policy.`;
}

function buildRepRow(name, row, columns, color) {
  return `<tr>
    <td><span class="rep-name"><span class="rep-dot" style="background:${color}"></span>${esc(name)}</span></td>
    ${columns.map((c) => `<td${c.cls ? ` class="${c.cls}"` : ""}>${c.value}</td>`).join("")}
  </tr>`;
}

function renderTables(reps, closerNames, knownSetterNames) {
  const names = Object.keys(reps);
  // Membership isn't mutually exclusive -- Jen is a hybrid setter/closer, so
  // she can legitimately appear in both tables. A rep shows in a table if
  // they're on the known roster for that role OR they have real activity
  // there (covers anyone not yet added to the roster).
  const setterNames = names.filter((n) => (knownSetterNames ?? []).includes(n) || reps[n].outbound > 0);
  const closerRows = names.filter((n) => closerNames.includes(n) || reps[n].heldCalls > 0 || reps[n].won > 0);

  const setterCols = (r) => [
    { value: fmtInt(r.outbound) },
    { value: fmtInt(r.connected) },
    { value: fmtInt(r.qualified) },
    { value: `${fmtInt(r.liveTransferAttempted)} / ${fmtInt(r.liveTransferAccepted)}` },
    { value: fmtInt(r.qualified) },
  ];
  const settersBody = document.getElementById("settersBody");
  if (setterNames.length) {
    const totals = setterNames.reduce((acc, n) => {
      const r = reps[n];
      acc.outbound += r.outbound; acc.connected += r.connected; acc.qualified += r.qualified;
      acc.liveTransferAttempted += r.liveTransferAttempted; acc.liveTransferAccepted += r.liveTransferAccepted;
      return acc;
    }, { outbound: 0, connected: 0, qualified: 0, liveTransferAttempted: 0, liveTransferAccepted: 0 });
    settersBody.innerHTML =
      setterNames.map((n, i) => buildRepRow(n, reps[n], setterCols(reps[n]), colorFor(i))).join("") +
      `<tr class="total"><td>Setter Team Total</td>${setterCols(totals).map((c) => `<td>${c.value}</td>`).join("")}</tr>`;
  } else {
    settersBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--ink-faint); font-family:'Archivo',sans-serif;">No setter-attributed records this window</td></tr>`;
  }

  const closerCols = (r) => [
    { value: fmtInt(r.heldCalls) },
    { value: fmtInt(r.noShows) },
    { value: fmtInt(r.won) },
    { value: r.heldCalls > 0 ? `${((r.won / r.heldCalls) * 100).toFixed(1)}%` : "—", cls: "cell-good" },
    { value: fmtMoney(r.contractValue) },
    { value: fmtMoney(r.cashCollected) },
  ];
  const closersBody = document.getElementById("closersBody");
  if (closerRows.length) {
    const totals = closerRows.reduce((acc, n) => {
      const r = reps[n];
      acc.heldCalls += r.heldCalls; acc.noShows += r.noShows; acc.won += r.won;
      acc.contractValue += r.contractValue; acc.cashCollected += r.cashCollected;
      return acc;
    }, { heldCalls: 0, noShows: 0, won: 0, contractValue: 0, cashCollected: 0 });
    closersBody.innerHTML =
      closerRows.map((n, i) => buildRepRow(n, reps[n], closerCols(reps[n]), colorFor(i))).join("") +
      `<tr class="total"><td>Closer Team Total</td>${closerCols(totals).map((c) => `<td>${c.value}</td>`).join("")}</tr>`;
  } else {
    closersBody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--ink-faint); font-family:'Archivo',sans-serif;">No closer-attributed records this window</td></tr>`;
  }

  return { setterNames, closerRows, totalsForKpi: names.reduce((acc, n) => {
    const r = reps[n];
    acc.liveTransferAttempted += r.liveTransferAttempted;
    acc.liveTransferAccepted += r.liveTransferAccepted;
    acc.appointmentsBooked += r.appointmentsBooked;
    acc.noShows += r.noShows;
    return acc;
  }, { liveTransferAttempted: 0, liveTransferAccepted: 0, appointmentsBooked: 0, noShows: 0 }) };
}

function renderActivityPoints(activityPoints, windowDays) {
  const rows = document.getElementById("pointsRows");
  const sub = document.getElementById("pointsSub");
  const names = Object.keys(activityPoints ?? {});
  if (sub) sub.textContent = `This window's progress — goal scales with the sync window (200 × ${windowDays} days)`;
  if (!names.length) {
    rows.innerHTML = `<div style="text-align:center; color:var(--ink-faint); font-size:12.5px;">No setter roster configured</div>`;
    return;
  }

  rows.innerHTML = names
    .map((name, i) => {
      const p = activityPoints[name];
      const pct = p.goal > 0 ? (p.points / p.goal) * 100 : 0;
      const tone = pct >= 100 ? "good" : pct >= 70 ? "primary" : "warn";
      const captionParts = [`${fmtInt(p.outboundCalls)} outbound`];
      if (p.heldQualCalls > 0) captionParts.push(`${fmtInt(p.heldQualCalls)} held qualification call${p.heldQualCalls === 1 ? "" : "s"} (${p.heldQualCalls * 15} pts)`);
      if (p.heldClosingCalls > 0) captionParts.push(`${fmtInt(p.heldClosingCalls)} held closing call${p.heldClosingCalls === 1 ? "" : "s"} (${p.heldClosingCalls * 40} pts)`);
      return `<div class="points-row">
        <div class="points-row-head">
          <span class="points-name"><span class="rep-dot" style="background:${colorFor(i)}"></span>${esc(name)}</span>
          <span class="points-value tone-${tone}">${fmtInt(p.points)} / ${fmtInt(p.goal)} pts</span>
        </div>
        <div class="points-track"><div class="points-fill tone-${tone}" style="width:${Math.min(pct, 100)}%"></div></div>
        <span class="points-caption">${captionParts.join(" &middot; ")}</span>
      </div>`;
    })
    .join("");
}

function renderChains(chains) {
  const list = document.getElementById("chainList");
  if (!chains?.length) {
    list.innerHTML = `<div class="chain-row" style="color:var(--ink-faint)">No setter-to-closer handoffs with an outcome yet this window.</div>`;
    return;
  }
  list.innerHTML = chains
    .map((c) => {
      const outcome = c.outcome === "won"
        ? `<span class="chain-outcome mono">Won &middot; ${esc(fmtMoney(c.value))}</span>`
        : `<span class="chain-outcome mono" style="color:var(--ink-muted)">Held Call &middot; pending</span>`;
      return `<div class="chain-row">
        <span class="chain-chip"><span class="avatar" style="background:var(--primary)">${esc(initials(c.setter))}</span>${esc(c.setter)}</span>
        <svg class="chain-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="chain-chip"><span class="avatar" style="background:var(--accent)">${esc(initials(c.closer))}</span>${esc(c.closer)}</span>
        ${outcome}
      </div>`;
    })
    .join("");
}

const STATUS_TONE = {
  completed: ["Connected", "good"],
  connected: ["Connected", "good"],
  "no-answer": ["No Answer", "warn"],
  noanswer: ["No Answer", "warn"],
  busy: ["Busy", "warn"],
  voicemail: ["Voicemail", "muted"],
  failed: ["Failed", "critical"],
  canceled: ["Canceled", "muted"],
  cancelled: ["Canceled", "muted"],
  logged: ["Logged", "muted"],
};

function fmtDuration(sec) {
  if (sec === null || sec === undefined || Number.isNaN(sec)) return "—";
  const n = Number(sec);
  if (n <= 0) return "—";
  const m = Math.floor(n / 60);
  const s = Math.round(n % 60);
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

const CALL_LOG_DISPLAY_LIMIT = 200;

function renderCallSummary(callLog) {
  const host = document.getElementById("callSummary");
  if (!host) return;
  if (!callLog?.length) { host.innerHTML = ""; return; }

  const counts = new Map();
  for (const c of callLog) counts.set(c.setter, (counts.get(c.setter) ?? 0) + 1);
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  host.innerHTML = rows
    .map(([name, count], i) => `<span class="call-summary-chip"><span class="rep-dot" style="background:${colorFor(i)}"></span>${esc(name)} <span class="count mono">${fmtInt(count)}</span></span>`)
    .join("") + `<span class="call-summary-chip"><strong>Total</strong> <span class="count mono">${fmtInt(callLog.length)}</span></span>`;
}

function renderCallLog(callLog, rangeLabel) {
  const body = document.getElementById("callLogBody");
  const sub = document.getElementById("callLogSub");
  renderCallSummary(callLog);

  if (!callLog?.length) {
    body.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--ink-faint); font-family:'Archivo',sans-serif;">No outbound calls logged${rangeLabel ? ` ${rangeLabel}` : " this window"}</td></tr>`;
    if (sub) sub.textContent = `No outbound calls logged${rangeLabel ? ` ${rangeLabel}` : " this window"}`;
    return;
  }
  const shown = callLog.slice(0, CALL_LOG_DISPLAY_LIMIT);
  if (sub) {
    sub.textContent = callLog.length > CALL_LOG_DISPLAY_LIMIT
      ? `Showing the most recent ${CALL_LOG_DISPLAY_LIMIT} of ${fmtInt(callLog.length)} calls${rangeLabel ? ` ${rangeLabel}` : ""}, newest first`
      : `${fmtInt(callLog.length)} call${callLog.length === 1 ? "" : "s"}${rangeLabel ? ` ${rangeLabel}` : " this window"}, newest first`;
  }

  body.innerHTML = shown
    .map((c, i) => {
      const key = String(c.status ?? "logged").toLowerCase().replace(/\s+/g, "-");
      const [label, tone] = STATUS_TONE[key] ?? [esc(c.status ?? "Logged"), "muted"];
      const time = c.time
        ? new Date(c.time).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
        : "—";
      return `<tr>
        <td>${time}</td>
        <td><span class="rep-name"><span class="rep-dot" style="background:${colorFor(i)}"></span>${esc(c.setter)}</span></td>
        <td>${esc(c.contact)}</td>
        <td><span class="status-chip tone-${tone}">${label}</span></td>
        <td class="num mono">${fmtDuration(c.durationSec)}</td>
      </tr>`;
    })
    .join("");
}

function isoDate(d) { return d.toISOString().slice(0, 10); }

function wireCallLogRange(callLogHistory, windowDays) {
  const fromInput = document.getElementById("rangeFrom");
  const toInput = document.getElementById("rangeTo");
  const applyBtn = document.getElementById("rangeApply");
  const noHistoryNote = document.getElementById("rangeNoHistory");
  if (!fromInput || !toInput || !applyBtn) return;

  const today = new Date();
  // +1 padding day: the backend's `since` is a rolling windowDays*24h look-
  // back from the exact sync timestamp, while this default range is
  // calendar-day based -- without the pad, a call from exactly windowDays
  // ago can fall just outside "today back N-1 days" and look like data
  // loss when it isn't.
  const defaultFrom = new Date(today.getTime() - windowDays * 24 * 60 * 60 * 1000);
  fromInput.value = isoDate(defaultFrom);
  toInput.value = isoDate(today);
  fromInput.max = isoDate(today);
  toInput.max = isoDate(today);

  if (noHistoryNote) noHistoryNote.hidden = (callLogHistory?.length ?? 0) > 0;

  const apply = () => {
    const from = fromInput.value ? new Date(fromInput.value + "T00:00:00") : null;
    const to = toInput.value ? new Date(toInput.value + "T23:59:59") : null;
    const filtered = (callLogHistory ?? []).filter((c) => {
      if (!c.time) return false;
      const t = new Date(c.time);
      return (!from || t >= from) && (!to || t <= to);
    });
    const label = fromInput.value === toInput.value
      ? `on ${fromInput.value}`
      : `from ${fromInput.value} to ${toInput.value}`;
    renderCallLog(filtered, label);
  };

  applyBtn.addEventListener("click", apply);
  apply(); // render the default range immediately so the panel isn't empty on load
}

function renderTrend(history) {
  const points = (history ?? []).filter((h) => Number.isFinite(h.closeRate));
  const current = points.at(-1);
  document.getElementById("trendCurrent").textContent = current ? `${current.closeRate}%` : "—";

  if (points.length < 2) {
    document.getElementById("trendCaption").textContent = "Not enough sync history yet — trend fills in over the next few runs.";
    ["trendArea", "trendLine"].forEach((id) => document.getElementById(id).setAttribute("points", ""));
    const dot = document.getElementById("trendDotCore");
    const halo = document.getElementById("trendDotHalo");
    if (current) { dot.setAttribute("cx", 400); dot.setAttribute("cy", 60); halo.setAttribute("cx", 400); halo.setAttribute("cy", 60); }
    else { dot.style.display = halo.style.display = "none"; }
    return;
  }

  const values = points.map((p) => p.closeRate);
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const toXY = (v, i) => {
    const x = (i / (points.length - 1)) * 400;
    const y = 104 - ((v - min) / span) * 88;
    return [x, y];
  };
  const coords = values.map((v, i) => toXY(v, i));
  const linePoints = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const areaPoints = `${linePoints} 400,120 0,120`;

  document.getElementById("trendLine").setAttribute("points", linePoints);
  document.getElementById("trendArea").setAttribute("points", areaPoints);
  const [lastX, lastY] = coords.at(-1);
  document.getElementById("trendDotCore").setAttribute("cx", lastX);
  document.getElementById("trendDotCore").setAttribute("cy", lastY);
  document.getElementById("trendDotHalo").setAttribute("cx", lastX);
  document.getElementById("trendDotHalo").setAttribute("cy", lastY);

  const first = values[0];
  const trendWord = current.closeRate > first ? "up from" : current.closeRate < first ? "down from" : "flat vs";
  const firstWhen = new Date(points[0].t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  document.getElementById("trendCaption").textContent = `current sync · ${trendWord} ${first}% on ${firstWhen}`;
}

const sum = (arr) => arr.reduce((a, b) => a + b, 0);

// Recomputes the KPI band for a rep-filter selection. Funnel and routing
// stay team-wide regardless of filter -- that breakdown isn't captured
// per-rep in data.json yet, so tiles that don't apply to the selection
// show "—" instead of a misleading 0.
function computeFilteredKpis(d, filterKey) {
  const closerNames = d.closerNames ?? [];
  const names = Object.keys(d.reps);
  const setterNames = names.filter((n) => !closerNames.includes(n));

  if (filterKey === "all") {
    return {
      outboundAttempts: d.funnel.outboundAttempts,
      qualified: d.funnel.qualified,
      liveTransferAttempted: sum(setterNames.map((n) => d.reps[n].liveTransferAttempted)),
      liveTransferAccepted: sum(setterNames.map((n) => d.reps[n].liveTransferAccepted)),
      appointmentsBooked: sum(names.map((n) => d.reps[n].appointmentsBooked)),
      heldCall: d.funnel.heldCall,
      noShows: sum(names.map((n) => d.reps[n].noShows)),
      won: d.funnel.won,
      closeRate: d.totals.closeRate,
      contractValue: d.totals.contractValue,
      cashCollected: d.totals.cashCollected,
      note: "this window",
    };
  }

  if (filterKey === "setters") {
    const rows = setterNames.map((n) => d.reps[n]);
    return {
      outboundAttempts: sum(rows.map((r) => r.outbound)),
      qualified: sum(rows.map((r) => r.qualified)),
      liveTransferAttempted: sum(rows.map((r) => r.liveTransferAttempted)),
      liveTransferAccepted: sum(rows.map((r) => r.liveTransferAccepted)),
      appointmentsBooked: null, heldCall: null, noShows: null, won: null,
      closeRate: null, contractValue: null, cashCollected: null,
      note: "setters only",
    };
  }

  const r = d.reps[filterKey];
  if (!r) return computeFilteredKpis(d, "all");
  // Jen is a hybrid setter/closer -- if she has any outbound activity, show
  // her real setter-side numbers instead of "—". A pure closer (Jercori)
  // naturally reports 0 here since she never appears as a setter.
  const isHybrid = r.outbound > 0;
  return {
    outboundAttempts: isHybrid ? r.outbound : null,
    qualified: isHybrid ? r.qualified : null,
    liveTransferAttempted: isHybrid ? r.liveTransferAttempted : null,
    liveTransferAccepted: isHybrid ? r.liveTransferAccepted : null,
    appointmentsBooked: r.appointmentsBooked,
    heldCall: r.heldCalls,
    noShows: r.noShows,
    won: r.won,
    closeRate: r.heldCalls > 0 ? Number(((r.won / r.heldCalls) * 100).toFixed(1)) : 0,
    contractValue: r.contractValue,
    cashCollected: r.cashCollected,
    note: filterKey,
  };
}

function renderKpiBand(d, filterKey) {
  const k = computeFilteredKpis(d, filterKey);
  const na = `not tracked for ${filterKey === "setters" ? "setters" : filterKey}`;

  setKpi("kpi-outboundAttempts", k.outboundAttempts === null ? "—" : fmtInt(k.outboundAttempts), k.outboundAttempts === null ? na : k.note);
  setKpi("kpi-qualified", k.qualified === null ? "—" : fmtInt(k.qualified), k.qualified === null ? na : k.note);
  setKpi("kpi-liveTransferAttempted", k.liveTransferAttempted === null ? "—" : fmtInt(k.liveTransferAttempted), k.liveTransferAttempted === null ? na : k.note);
  setKpi("kpi-liveTransferAccepted", k.liveTransferAccepted === null ? "—" : fmtInt(k.liveTransferAccepted),
    k.liveTransferAccepted === null ? na : (k.liveTransferAttempted > 0 ? `${((k.liveTransferAccepted / k.liveTransferAttempted) * 100).toFixed(1)}% accept rate` : k.note));
  setKpi("kpi-appointmentsBooked", k.appointmentsBooked === null ? "—" : fmtInt(k.appointmentsBooked), k.appointmentsBooked === null ? na : k.note);
  setKpi("kpi-heldCall", k.heldCall === null ? "—" : fmtInt(k.heldCall), k.heldCall === null ? na : k.note);
  setKpi("kpi-noShows", k.noShows === null ? "—" : fmtInt(k.noShows), k.noShows === null ? na : k.note);
  setKpi("kpi-won", k.won === null ? "—" : fmtInt(k.won), k.won === null ? na : k.note);
  setKpi("kpi-closeRate", k.closeRate === null ? "—" : `${k.closeRate}%`, k.closeRate === null ? na : k.note);
  setKpi("kpi-contractValue", k.contractValue === null ? "—" : fmtMoney(k.contractValue), k.contractValue === null ? na : k.note);
  setKpi("kpi-cashCollected", k.cashCollected === null ? "—" : fmtMoney(k.cashCollected), k.cashCollected === null ? na : k.note);
}

function dimRepRows(filterKey) {
  document.querySelectorAll("#settersBody tr, #closersBody tr").forEach((row) => {
    if (filterKey === "all") { row.classList.remove("dim"); return; }
    const isSetterTable = row.closest("table")?.querySelector("thead th")?.textContent === "Setter";
    let show;
    if (row.classList.contains("total")) {
      show = filterKey === "setters" ? isSetterTable : !isSetterTable; // opposite table's total is noise once filtered
    } else if (filterKey === "setters") {
      show = isSetterTable;
    } else {
      show = row.querySelector(".rep-name")?.textContent?.trim() === filterKey;
    }
    row.classList.toggle("dim", !show);
  });
}

function updateScopeNotes(filterKey) {
  const suffix = filterKey === "all" ? "" : " · funnel &amp; routing stay team-wide (not filterable by rep yet)";
  const funnelSub = document.getElementById("funnelSub");
  const routingSub = document.getElementById("routingSub");
  if (funnelSub) funnelSub.innerHTML = "Outbound attempt &rarr; held call &rarr; won, this window, all reps" + suffix;
  if (routingSub) routingSub.innerHTML = "Approved tiers: &lt;$10k &rarr; Jen &middot; $10k&ndash;19,999 &rarr; 50/50 &middot; $20k+ &rarr; Jercori" + suffix;
}

function wireControls(getData) {
  const pills = document.querySelectorAll(".pill-group .pill");
  pills.forEach((pill) => {
    pill.addEventListener("click", () => {
      pills.forEach((p) => p.setAttribute("aria-pressed", String(p === pill)));
      const filterKey = pill.textContent.trim() === "All" ? "all" : pill.textContent.trim() === "Setters" ? "setters" : pill.textContent.trim();
      const d = getData();
      if (d) renderKpiBand(d, filterKey);
      dimRepRows(filterKey);
      updateScopeNotes(filterKey);
    });
  });

  const rangeBtn = document.getElementById("rangeChipBtn");
  const rangeNote = document.getElementById("rangeNote");
  rangeBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    rangeNote.hidden = !rangeNote.hidden;
  });
  document.addEventListener("click", (e) => {
    if (!rangeNote || rangeNote.hidden) return;
    if (!rangeNote.contains(e.target) && e.target !== rangeBtn && !rangeBtn.contains(e.target)) rangeNote.hidden = true;
  });
}

async function main() {
  let payload;
  try {
    const res = await fetch("./data.json", { cache: "no-store" });
    payload = await res.json();
  } catch {
    wireControls(() => null);
    wireCallLogRange([], 7);
    return; // network hiccup -- leave the static sample markup in place
  }

  document.getElementById("rangeLabel").textContent = payload.generatedAt
    ? `Last ${payload.windowDays} days · through ${new Date(payload.generatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
    : `Last ${payload.windowDays} days`;

  if (!payload.ok || !payload.data) {
    document.getElementById("syncStatus").textContent = payload.generatedAt
      ? `Last sync attempt failed at ${new Date(payload.generatedAt).toLocaleString("en-US")} — see sync notes above.`
      : "No sync has run yet — showing sample data below.";
    renderWarnings(payload.warnings);
    wireControls(() => null); // rows can still be dimmed by name on the sample table
    wireCallLogRange(payload.callLogHistory ?? [], payload.windowDays ?? 7);
    return;
  }

  renderBadgeLive(payload.generatedAt);
  document.getElementById("syncStatus").textContent = `Synced ${new Date(payload.generatedAt).toLocaleString("en-US")} from GoHighLevel (read-only)`;
  renderWarnings(payload.warnings);

  const d = payload.data;
  renderFunnel(d.funnel);
  renderRouting(d.routingMix, d.highTicketFlagged);
  renderTables(d.reps, d.closerNames ?? [], d.setterNames ?? []);
  renderChains(d.attributionChains);
  renderActivityPoints(d.activityPoints, payload.windowDays);
  renderTrend(payload.history);
  renderKpiBand(d, "all");
  wireControls(() => d);
  wireCallLogRange(payload.callLogHistory?.length ? payload.callLogHistory : d.callLog, payload.windowDays);
}

main();
