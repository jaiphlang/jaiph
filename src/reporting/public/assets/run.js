/* global fetch, document, URLSearchParams, setInterval */

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function runEnc() {
  const p = new URLSearchParams(window.location.search).get("run");
  return p || "";
}

function iconForStep(node) {
  if (node.running) return "◷";
  if (node.status === 0) return "✓";
  if (node.status != null) return "✗";
  return "·";
}

function renderTree(nodes, depth) {
  const ul = document.createElement("div");
  for (const n of nodes) {
    const row = document.createElement("div");
    row.className = "tree-row";
    row.style.marginLeft = `${depth * 0.5}rem`;
    row.dataset.id = n.id;
    const ms = n.elapsed_ms != null ? ` ${n.elapsed_ms}ms` : "";
    row.textContent = `${iconForStep(n)} [${n.kind}] ${n.name}${ms}`;
    row.addEventListener("click", () => selectStep(n.id, row));
    ul.appendChild(row);
    if (n.children && n.children.length) {
      ul.appendChild(renderTree(n.children, depth + 1));
    }
  }
  return ul;
}

let selectedId = null;

function selectStep(id, rowEl) {
  selectedId = id;
  document.querySelectorAll(".tree-row").forEach((r) => r.classList.remove("selected"));
  if (rowEl) rowEl.classList.add("selected");
  loadOutput();
}

async function loadTree() {
  const enc = runEnc();
  if (!enc) return;
  const res = await fetch(`/api/runs/${encodeURIComponent(enc)}/tree`);
  if (!res.ok) return;
  const data = await res.json();
  document.getElementById("run-title").textContent = data.path || enc;
  document.getElementById("run-sub").textContent = data.run_id ? `run_id: ${data.run_id}` : "";
  const host = document.getElementById("step-tree");
  host.innerHTML = "";
  host.appendChild(renderTree(data.steps || [], 0));
  if (!selectedId && data.steps && data.steps[0]) {
    const first = data.steps[0];
    let row = null;
    for (const el of host.querySelectorAll(".tree-row")) {
      if (el.dataset.id === first.id) {
        row = el;
        break;
      }
    }
    selectStep(first.id, row);
  }
}

async function loadOutput() {
  const enc = runEnc();
  if (!enc || !selectedId) return;
  const res = await fetch(
    `/api/runs/${encodeURIComponent(enc)}/steps/${encodeURIComponent(selectedId)}/output`,
  );
  const data = await res.json();
  const parts = [];
  if (data.out_content) parts.push("--- stdout (embedded) ---\n" + data.out_content);
  if (data.err_content) parts.push("--- stderr (embedded) ---\n" + data.err_content);
  if (data.out_truncated || data.err_truncated) {
    parts.push("\n(note: preview truncated in API; use Raw logs for full files.)");
  }
  document.getElementById("out-response").textContent = parts.join("\n\n") || "(no embedded output)";
}

async function loadRaw() {
  const enc = runEnc();
  if (!enc || !selectedId) return;
  const stream = document.getElementById("raw-stream").value;
  const res = await fetch(
    `/api/runs/${encodeURIComponent(enc)}/steps/${encodeURIComponent(selectedId)}/logs?stream=${stream}`,
  );
  const text = await res.text();
  document.getElementById("out-raw").textContent = res.ok ? text : `(error ${res.status}) ${text}`;
}

async function loadAggregate() {
  const enc = runEnc();
  if (!enc) return;
  const res = await fetch(`/api/runs/${encodeURIComponent(enc)}/aggregate`);
  const text = await res.text();
  document.getElementById("out-aggregate").textContent = res.ok ? text : `(error ${res.status}) ${text}`;
}

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`panel-${btn.dataset.tab}`).classList.add("active");
  });
});

document.getElementById("raw-load").addEventListener("click", () => loadRaw());
document.getElementById("agg-load").addEventListener("click", () => loadAggregate());

const enc = runEnc();
if (!enc) {
  document.getElementById("run-title").textContent = "Missing run parameter";
} else {
  loadTree();
  setInterval(loadTree, 2000);
}
