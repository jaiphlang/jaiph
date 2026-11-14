// Renders the `jaiph graph` examples on docs/execution-flow.md and beside the
// samples on the landing page (docs/index.html). Docs pages load it only when
// their front matter sets `mermaid: true` (see _layouts/docs.html).
// Each `[data-graph-mermaid]` block holds real command output; its rendered SVG
// goes into the `.graph-render` element that follows it. main.js keeps the
// original block text in `data-copy-source` before it re-renders the listing.
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs";

mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "strict" });

const blocks = document.querySelectorAll("[data-graph-mermaid]");
for (let i = 0; i < blocks.length; i += 1) {
  const block = blocks[i];
  const target = block.closest("[data-graph-sample]")?.querySelector(".graph-render");
  if (!target) continue;
  const text = (block.dataset.copySource ?? block.textContent).trim();
  try {
    const { svg } = await mermaid.render(`graph-sample-${i}`, text);
    target.innerHTML = svg;
  } catch (err) {
    target.textContent = `Could not render this chart: ${err?.message ?? err}`;
  }
}
