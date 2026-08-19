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

  document.getElementById("funnelRows").innerHTML = rows
    .map((r, i) => `
      <div class="funnel-row">
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
  const colors = ["var(--primary)", "linear-gradient(90deg, var(--primary), var(--accent))", "var(--accent)"];

  document.getElementById("routingBar").innerHTML = total
    ? routingMix.map((t, i) => `<div class="routing-seg" style="width:${((t.count / total) * 100).toFixed(2)}%; background:${colors[i] ?? "var(--accent)"};">${esc(t.closer)} &middot; ${fmtInt(t.count)}</div>`).join("")
    : `<div class="routing-seg" style="width:100%; background:var(--surface-sunken); color:var(--ink-faint);">No routed leads yet this window</div>`;

  document.getElementById("routingLegend").innerHTML = routingMix
    .map((t, i) => `<div class="routing-item"><span class="routing-swatch" style="background:${colors[i] ?? "var(--accent)"}"></span><span class="who">${esc(t.label)} TAC</span><span class="count mono">${fmtInt(t.count)} leads</span></div>`)
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

function renderTables(reps, closerNames) {
  const names = Object.keys(reps);
  const setterNames = names.filter((n) => !closerNames.includes(n));
  const closerRows = names.filter((n) => closerNames.includes(n));

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

async function main() {
  let payload;
  try {
    const res = await fetch("./data.json", { cache: "no-store" });
    payload = await res.json();
  } catch {
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
    return;
  }

  renderBadgeLive(payload.generatedAt);
  document.getElementById("syncStatus").textContent = `Synced ${new Date(payload.generatedAt).toLocaleString("en-US")} from GoHighLevel (read-only)`;
  renderWarnings(payload.warnings);

  const d = payload.data;
  renderFunnel(d.funnel);
  renderRouting(d.routingMix, d.highTicketFlagged);
  const { totalsForKpi } = renderTables(d.reps, d.closerNames ?? []);
  renderChains(d.attributionChains);
  renderTrend(payload.history);

  setKpi("kpi-outboundAttempts", fmtInt(d.funnel.outboundAttempts), "this window");
  setKpi("kpi-qualified", fmtInt(d.funnel.qualified), "this window");
  setKpi("kpi-liveTransferAttempted", fmtInt(totalsForKpi.liveTransferAttempted), "this window");
  setKpi("kpi-liveTransferAccepted", fmtInt(totalsForKpi.liveTransferAccepted),
    totalsForKpi.liveTransferAttempted > 0 ? `${((totalsForKpi.liveTransferAccepted / totalsForKpi.liveTransferAttempted) * 100).toFixed(1)}% accept rate` : "this window");
  setKpi("kpi-appointmentsBooked", fmtInt(totalsForKpi.appointmentsBooked), "this window");
  setKpi("kpi-heldCall", fmtInt(d.funnel.heldCall), "this window");
  setKpi("kpi-noShows", fmtInt(totalsForKpi.noShows), "this window");
  setKpi("kpi-won", fmtInt(d.funnel.won), "this window");
  setKpi("kpi-closeRate", `${d.totals.closeRate}%`, "this window");
  setKpi("kpi-contractValue", fmtMoney(d.totals.contractValue), "this window");
  setKpi("kpi-cashCollected", fmtMoney(d.totals.cashCollected), "this window");
}

main();
