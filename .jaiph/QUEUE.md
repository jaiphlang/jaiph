# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## GitHub Pages template matching docs/index.html

**Status:** pending

**What:** Build a GitHub Pages template that matches the style in `docs/index.html` and apply it to the current GH Pages site built from the `docs/` directory.

**Why:** The landing page (`docs/index.html`) has a distinct look (navy/orange palette, cards, code blocks with copy/tabs, syntax highlighting). The rest of the docs (e.g. `getting-started.md`, `configuration.md`, `cli.md`, `grammar.md`, `testing.md`, `hooks.md`) are plain Markdown and will render with default or no styling when served from `docs/`. Unifying them under the same template ensures a consistent, on-brand docs experience.

**Scope:**
- Extract or reuse the CSS, layout structure, and scripts from `docs/index.html` into a reusable template (e.g. Jekyll layout in `_layouts/default.html` if using Jekyll, or a build step that wraps each page in the same shell).
- Ensure the docs site is built from `docs/` (no change to publish source).
- Apply the template so that:
  - The existing `index.html` style is the reference (no visual regression).
  - All doc pages (Markdown or HTML) use the same header, container, cards, code block styling, footer, and behaviour (copy buttons, code tabs, syntax highlighting where applicable).

**Files to touch (indicative):**
- `docs/index.html` — keep as reference; optionally refactor to use the shared template/layout.
- New: template/layout file(s) in `docs/` (e.g. `_layouts/default.html` and `_config.yml` if Jekyll, or equivalent).
- Doc pages in `docs/*.md` — ensure they are rendered through the template (front matter or build pipeline).

**Acceptance criteria:**
- GH Pages built from `docs/` displays all content with the same visual style as `docs/index.html` (colors, typography, cards, code blocks, footer).
- Code blocks on doc pages have the same styling and copy-button behaviour as on the landing page.
- No duplicate CSS/JS: single source of truth for the template (shared layout or single shell).
- Existing links and URLs (e.g. `/getting-started`, `/configuration`) continue to work.
