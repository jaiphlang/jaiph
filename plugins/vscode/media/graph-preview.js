// Webview side of the Jaiph graph preview. The extension runs `jaiph graph`
// and posts the Mermaid text here; this script renders it and posts option
// changes (def, depth, import depth, libs) back. Mermaid is loaded from the
// bundled dist/mermaid.min.js (no network access).
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const canvas = $("canvas");
  const controls = { def: $("def"), depth: $("depth"), importDepth: $("importDepth"), libs: $("libs") };

  let zoom = null; // null = fit to width; otherwise a scale factor
  let renderSeq = 0;

  function limitValue(v) {
    return v === "all" ? "all" : Number(v);
  }

  function readOptions() {
    return {
      def: controls.def.value,
      depth: limitValue(controls.depth.value),
      importDepth: limitValue(controls.importDepth.value),
      libs: controls.libs.checked,
    };
  }

  function ensureOption(select, value) {
    const v = String(value);
    if (![...select.options].some((o) => o.value === v)) select.add(new Option(v, v));
    select.value = v;
  }

  function syncControls(msg) {
    const defs = msg.defs.length > 0 ? msg.defs : [msg.options.def];
    controls.def.replaceChildren(...defs.map((d) => new Option(d, d)));
    ensureOption(controls.def, msg.options.def);
    ensureOption(controls.depth, msg.options.depth);
    ensureOption(controls.importDepth, msg.options.importDepth);
    controls.libs.checked = msg.options.libs;
  }

  function applyZoom() {
    const svg = canvas.querySelector("svg");
    if (!svg) return;
    const box = svg.viewBox && svg.viewBox.baseVal;
    if (zoom === null || !box || !box.width) {
      svg.style.maxWidth = "100%";
      svg.style.width = "";
      svg.style.height = "auto";
      return;
    }
    svg.style.maxWidth = "none";
    svg.style.width = `${box.width * zoom}px`;
    svg.style.height = "auto";
  }

  function showStatus(text, isError) {
    const p = document.createElement(isError ? "pre" : "p");
    p.className = isError ? "error" : "status";
    p.textContent = text;
    canvas.replaceChildren(p);
  }

  async function draw(msg) {
    const seq = ++renderSeq;
    if (msg.type === "error") {
      showStatus(msg.message || "jaiph graph failed", true);
      return;
    }
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      // jaiph graph's classDef fills are designed for a light background, so
      // the chart always uses the light theme; the CSS puts it on a light card.
      theme: "default",
      flowchart: { htmlLabels: true },
      maxTextSize: 1000000,
      maxEdges: 10000,
    });
    try {
      const { svg } = await mermaid.render(`jaiph-graph-${seq}`, msg.mermaid);
      if (seq !== renderSeq) return;
      canvas.innerHTML = svg;
      applyZoom();
    } catch (err) {
      if (seq !== renderSeq) return;
      showStatus(`Could not render this chart: ${err && err.message ? err.message : err}`, true);
    }
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type !== "graph" && msg.type !== "error") return;
    vscode.setState(msg.state);
    syncControls(msg);
    void draw(msg);
  });

  for (const el of Object.values(controls)) {
    el.addEventListener("change", () => {
      showStatus("Loading graph…", false);
      vscode.postMessage({ type: "options", options: readOptions() });
    });
  }

  $("refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
  $("source").addEventListener("click", () => vscode.postMessage({ type: "openSource" }));
  $("zoomFit").addEventListener("click", () => {
    zoom = null;
    applyZoom();
  });
  function step(factor) {
    const svg = canvas.querySelector("svg");
    if (zoom === null && svg && svg.viewBox && svg.viewBox.baseVal.width) {
      zoom = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
    }
    zoom = Math.min(8, Math.max(0.1, (zoom || 1) * factor));
    applyZoom();
  }
  $("zoomIn").addEventListener("click", () => step(1.25));
  $("zoomOut").addEventListener("click", () => step(0.8));

  vscode.postMessage({ type: "ready" });
})();
