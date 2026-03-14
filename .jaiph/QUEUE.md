# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## 1. Improve docs Jeckyll theme

Currently @docs/index.html and md pages look different. H2 headers should be outside
of the while boxes with text. You need invent another header panel for .md pages though
-- it should contain h1 header, links and maybe intro to a given document. Then h2 outside
of the box, and then box with text, and another h2 outside, and text etc.

Keep the style of @docs/index.html. Probably docs should have a different template. Consider adding links to docs pages to the header template, and don't add them manually to each *.md
docs page, and change the relevant prompt in @.jaiph/docs_parity.jh