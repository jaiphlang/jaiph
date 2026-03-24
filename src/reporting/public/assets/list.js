/* global fetch, document, setInterval */

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function durationMs(started, ended) {
  if (!started) return "—";
  const a = Date.parse(started);
  const b = ended ? Date.parse(ended) : Date.now();
  if (Number.isNaN(a) || Number.isNaN(b)) return "—";
  const ms = Math.max(0, b - a);
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

let sortKey = "started_at";
let sortDir = -1;

function sortRows(rows) {
  const dir = sortDir;
  const key = sortKey;
  return [...rows].sort((x, y) => {
    let vx = x[key];
    let vy = y[key];
    if (key === "duration") {
      vx = Date.parse(x.started_at || "") || 0;
      vy = Date.parse(y.started_at || "") || 0;
      vx = Date.now() - vx;
      vy = Date.now() - vy;
    }
    if (vx == null) vx = "";
    if (vy == null) vy = "";
    if (typeof vx === "number" && typeof vy === "number") {
      return dir * (vx - vy);
    }
    return dir * String(vx).localeCompare(String(vy));
  });
}

async function loadRuns() {
  const date = document.getElementById("f-date").value.trim();
  const status = document.getElementById("f-status").value;
  const q = document.getElementById("f-q").value.trim();
  const params = new URLSearchParams();
  params.set("limit", "200");
  if (date) params.set("date", date);
  if (status) params.set("status", status);
  if (q) params.set("q", q);
  const res = await fetch(`/api/runs?${params.toString()}`);
  const data = await res.json();
  const tbody = document.getElementById("runs-body");
  tbody.innerHTML = "";
  const rows = sortRows(data.runs || []);
  for (const r of rows) {
    const tr = document.createElement("tr");
    const href = `/run.html?run=${encodeURIComponent(r.path)}`;
    tr.innerHTML = `
      <td><a href="${href}">${esc(r.path)}</a></td>
      <td>${esc(r.source)}</td>
      <td>${esc(r.started_at || "—")}</td>
      <td>${esc(durationMs(r.started_at, r.ended_at))}</td>
      <td class="status-${esc(r.status)}">${esc(r.status)}</td>
      <td>${esc(String(r.step_count))} <span class="muted">(${esc(String(r.step_completed))} done)</span></td>
    `;
    tbody.appendChild(tr);
  }
  document.getElementById("runs-meta").textContent = `Showing ${rows.length} of ${data.total} run(s).`;
}

async function loadActive() {
  const res = await fetch("/api/active");
  const data = await res.json();
  const el = document.getElementById("active-list");
  const runs = data.runs || [];
  if (runs.length === 0) {
    el.textContent = "None";
    el.classList.add("muted");
    return;
  }
  el.classList.remove("muted");
  el.innerHTML = runs
    .map((r) => {
      const path = r.path || r.relPath || r.source || "(unknown)";
      const pct = r.percent != null ? `${r.percent}% · ` : "";
      const cur = r.current_step_label ? esc(r.current_step_label) : "…";
      const href = `/run.html?run=${encodeURIComponent(path)}`;
      return `<span class="chip"><a href="${href}">${esc(path)}</a> — ${pct}${esc(
        String(r.step_completed),
      )}/${esc(String(r.step_total))} steps · ${cur}</span>`;
    })
    .join("");
}

document.getElementById("f-apply").addEventListener("click", () => {
  loadRuns();
});

document.querySelectorAll("#runs-table thead th[data-sort]").forEach((th) => {
  th.addEventListener("click", () => {
    const k = th.getAttribute("data-sort");
    if (k === sortKey) sortDir *= -1;
    else {
      sortKey = k;
      sortDir = k === "started_at" || k === "duration" ? -1 : 1;
    }
    loadRuns();
  });
});

loadRuns();
loadActive();
setInterval(loadRuns, 3000);
setInterval(loadActive, 1500);
