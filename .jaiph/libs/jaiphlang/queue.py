#!/usr/bin/env python3
import fcntl, json, os, re, sys, time

DONE_SEP = "\n<!-- jaiph-done -->\n"

QUEUE_VIEW_PREAMBLE = """# Jaiph Improvement Queue (Hard Rewrite Track)

This file is a generated view. Do not edit it. Do not agent-edit it.
Use the product-owner defs (`propose_task`, `update_task`, `pick_task`,
`report_completed_task`, `task_details`) via `jaiph serve` / MCP.

Process rules:

1. `pick_task` prefers the first `#dev-ready` task that is not `#in-progress`.
   The product owner may claim a later available task instead.
2. The first `##` section is the preferred next task in this view.
3. `#dev-ready` means ready to implement. `#in-progress` means claimed by `pick_task`.
4. Runtime mutations go through the product-owner defs only.
5. Every task must be standalone: no hidden assumptions, no "read prior task".
6. Hard rewrite semantics: breaking changes are allowed unless a task says otherwise.
7. Acceptance criteria are non-negotiable. A task is not done until every
   acceptance bullet is verified by a test that fails when the contract is violated.
"""

DONE_VIEW_PREAMBLE = """# Done

Append-only archive. Generated view. Do not edit.
Each section was accepted by the product-owner `report_completed_task` def.
"""


def workspace_root():
    return os.environ.get("JAIPH_WORKSPACE", ".")


def view_queue_path():
    return os.path.join(workspace_root(), "QUEUE.md")


def view_done_path():
    return os.path.join(workspace_root(), "DONE.md")


def state_path():
    env = os.environ.get("JAIPH_QUEUE_STATE")
    if env:
        return env
    return os.path.join(workspace_root(), ".jaiph", "queue-state.md")


def clean_header(h):
    h = h.strip()
    if h.startswith("## "):
        h = h[3:]
    return re.sub(r"\s*#[A-Za-z0-9_-]+", "", h).strip()


def parse_queue_text(text):
    if not text or not text.strip():
        return {"description": "", "tasks": []}
    lines = text.split("\n")
    desc_lines, tasks, current = [], [], None
    for line in lines:
        if line.startswith("## "):
            if current:
                current["description"] = "\n".join(current["_lines"]).strip()
                del current["_lines"]
                tasks.append(current)
            raw = line[3:].strip()
            tags = re.findall(r"#([A-Za-z0-9_-]+)", raw)
            title = re.sub(r"\s*#[A-Za-z0-9_-]+", "", raw).strip()
            current = {"title": title, "tags": tags, "_lines": []}
        elif current is not None:
            current["_lines"].append(line)
        else:
            desc_lines.append(line)
    if current:
        current["description"] = "\n".join(current["_lines"]).strip()
        del current["_lines"]
        tasks.append(current)
    return {"description": "\n".join(desc_lines).strip(), "tasks": tasks}


def parse_queue(path):
    if not os.path.isfile(path):
        return {"description": "", "tasks": []}
    with open(path, encoding="utf-8") as f:
        return parse_queue_text(f.read())


def emit_tasks(tasks):
    lines = []
    for t in tasks:
        tag_s = " " + " ".join(f"#{x}" for x in t["tags"]) if t["tags"] else ""
        lines.append(f"## {t['title']}{tag_s}")
        if t.get("description"):
            lines.append("")
            lines.append(t["description"])
        lines.append("")
    return lines


def write_markdown(path, preamble, tasks):
    lines = []
    if preamble:
        lines.append(preamble.rstrip())
        lines.append("")
    lines.extend(emit_tasks(tasks))
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines).rstrip() + "\n")


def fmt_task(t):
    tag_s = " " + " ".join(f"#{x}" for x in t["tags"]) if t["tags"] else ""
    h = f"## {t['title']}{tag_s}"
    return f"{h}\n\n{t['description']}" if t.get("description") else h


def find_task(tasks, header):
    needle = clean_header(header)
    for i, t in enumerate(tasks):
        if t["title"] == needle:
            return i
    return -1


def empty_state():
    return {"description": "", "tasks": [], "done": []}


def parse_state_text(text):
    if DONE_SEP in text:
        live, done_text = text.split(DONE_SEP, 1)
    else:
        live, done_text = text, ""
    q = parse_queue_text(live)
    d = parse_queue_text(done_text)
    return {"description": q["description"], "tasks": q["tasks"], "done": d["tasks"]}


def read_state_file(path):
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as f:
        return parse_state_text(f.read())


def write_state_file(path, st):
    lines = []
    if st.get("description"):
        lines.append(st["description"])
        lines.append("")
    lines.extend(emit_tasks(st["tasks"]))
    body = "\n".join(lines).rstrip()
    if st.get("done"):
        done_body = "\n".join(emit_tasks(st["done"])).rstrip()
        body = body + DONE_SEP + done_body
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(body.rstrip() + "\n")


def dump_views(st):
    write_markdown(view_queue_path(), QUEUE_VIEW_PREAMBLE, st["tasks"])
    stripped = []
    for t in st["done"]:
        stripped.append({
            "title": t["title"],
            "tags": [],
            "description": t.get("description") or "",
        })
    write_markdown(view_done_path(), DONE_VIEW_PREAMBLE, stripped)


def bootstrap_state():
    path = state_path()
    existing = read_state_file(path)
    if existing is not None:
        return existing
    view = view_queue_path()
    if os.path.isfile(view):
        q = parse_queue(view)
        st = {"description": q["description"], "tasks": q["tasks"], "done": []}
    else:
        st = empty_state()
    write_state_file(path, st)
    dump_views(st)
    return st


def with_lock(fn):
    path = state_path()
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    lock_path = path + ".lock"
    with open(lock_path, "a+", encoding="utf-8") as lf:
        fcntl.lockf(lf, fcntl.LOCK_EX)
        try:
            return fn()
        finally:
            fcntl.lockf(lf, fcntl.LOCK_UN)


def load_state():
    return bootstrap_state()


def save_state(st):
    write_state_file(state_path(), st)
    dump_views(st)


def cmd_get(args):
    def go():
        tag = args[0] if args else None
        st = load_state()
        for t in st["tasks"]:
            if tag is None or tag in t["tags"]:
                print(fmt_task(t))
                return
        sys.exit(1)
    with_lock(go)


def cmd_get_available(args):
    def go():
        st = load_state()
        for t in st["tasks"]:
            if "dev-ready" in t["tags"] and "in-progress" not in t["tags"]:
                print(fmt_task(t))
                return
        print("no #dev-ready task is available", file=sys.stderr)
        sys.exit(1)
    with_lock(go)


def cmd_get_by_header(args):
    if not args:
        print("get_by_header: header required", file=sys.stderr)
        sys.exit(1)
    def go():
        st = load_state()
        i = find_task(st["tasks"], args[0])
        if i < 0:
            print(f"task not found: {args[0]}", file=sys.stderr)
            sys.exit(1)
        print(fmt_task(st["tasks"][i]))
    with_lock(go)


def cmd_headers(args):
    def go():
        tag = args[0] if args else None
        st = load_state()
        for t in st["tasks"]:
            if tag is None or tag in t["tags"]:
                print(t["title"])
    with_lock(go)


def cmd_complete(args):
    tag = args[0] if args else None
    def go():
        st = load_state()
        for i, t in enumerate(st["tasks"]):
            if tag is None or tag in t["tags"]:
                removed = st["tasks"].pop(i)
                save_state(st)
                print(f"Completed: {removed['title']}")
                return
        print("No matching task found", file=sys.stderr)
        sys.exit(1)
    with_lock(go)


def cmd_complete_by_header(args):
    if not args:
        print("complete_by_header: header required", file=sys.stderr)
        sys.exit(1)
    def go():
        st = load_state()
        i = find_task(st["tasks"], args[0])
        if i < 0:
            print(f"task not found: {args[0]}", file=sys.stderr)
            sys.exit(1)
        st["tasks"].pop(i)
        save_state(st)
        print(f"Completed: {args[0]}")
    with_lock(go)


def cmd_set_description(args):
    if len(args) < 2:
        print("set_description: header and description file path required", file=sys.stderr)
        sys.exit(1)
    header, body_path = args[0], args[1]
    if not os.path.isfile(body_path):
        print(f"set_description: file not found: {body_path}", file=sys.stderr)
        sys.exit(1)
    with open(body_path, encoding="utf-8") as f:
        body = f.read()
    def go():
        st = load_state()
        i = find_task(st["tasks"], header)
        if i < 0:
            print(f"task not found: {header}", file=sys.stderr)
            sys.exit(1)
        st["tasks"][i]["description"] = body.rstrip()
        save_state(st)
        print(f"Updated description: {st['tasks'][i]['title']}")
    with_lock(go)


def cmd_mark(args):
    if len(args) < 2:
        print("mark: header and tag required", file=sys.stderr)
        sys.exit(1)
    header, tag = args[0], args[1]
    def go():
        st = load_state()
        i = find_task(st["tasks"], header)
        if i < 0:
            print(f"task not found: {header}", file=sys.stderr)
            sys.exit(1)
        t = st["tasks"][i]
        if tag not in t["tags"]:
            t["tags"].append(tag)
            save_state(st)
        print(f"Marked #{tag}: {t['title']}")
    with_lock(go)


def cmd_unmark(args):
    if len(args) < 2:
        print("unmark: header and tag required", file=sys.stderr)
        sys.exit(1)
    header, tag = args[0], args[1]
    def go():
        st = load_state()
        i = find_task(st["tasks"], header)
        if i < 0:
            print(f"task not found: {header}", file=sys.stderr)
            sys.exit(1)
        t = st["tasks"][i]
        if tag in t["tags"]:
            t["tags"] = [x for x in t["tags"] if x != tag]
            save_state(st)
        print(f"Unmarked #{tag}: {t['title']}")
    with_lock(go)


def cmd_check_all_tagged(args):
    if not args:
        print("check_all_tagged: tag required", file=sys.stderr)
        sys.exit(1)
    tag = args[0]
    def go():
        st = load_state()
        if not st["tasks"]:
            sys.exit(1)
        for t in st["tasks"]:
            if tag not in t["tags"]:
                sys.exit(1)
    with_lock(go)


def cmd_has_tag(args):
    if len(args) < 2:
        print("has_tag: text and tag required", file=sys.stderr)
        sys.exit(1)
    first_line = args[0].split("\n")[0]
    if f"#{args[1]}" not in first_line:
        sys.exit(1)


def cmd_json(args):
    def go():
        print(json.dumps(load_state(), indent=2))
    with_lock(go)


def append_tasks_from_parsed(incoming, force_dev_ready):
    st = load_state()
    existing = {t["title"] for t in st["tasks"]}
    added = 0
    skipped = 0
    for t in incoming["tasks"]:
        if t["title"] in existing:
            skipped += 1
            continue
        tags = list(t["tags"])
        if force_dev_ready and "dev-ready" not in tags:
            tags.append("dev-ready")
        st["tasks"].append({
            "title": t["title"],
            "tags": tags,
            "description": t["description"],
        })
        existing.add(t["title"])
        added += 1
    if added:
        save_state(st)
    print(f"Added {added} tasks" + (f" (skipped {skipped} existing)" if skipped else ""))


def cmd_add_from_file(args):
    if not args:
        print("add_from_file: path required", file=sys.stderr)
        sys.exit(1)
    src = args[0]
    if not os.path.isfile(src):
        print(f"add_from_file: file not found: {src}", file=sys.stderr)
        sys.exit(1)
    incoming = parse_queue(src)
    if not incoming["tasks"]:
        print("Added 0 tasks (file had no ## sections)")
        return
    def go():
        append_tasks_from_parsed(incoming, True)
    with_lock(go)


def cmd_add(args):
    if not args:
        print("add: path required", file=sys.stderr)
        sys.exit(1)
    src = args[0]
    if not os.path.isfile(src):
        print(f"add: file not found: {src}", file=sys.stderr)
        sys.exit(1)
    incoming = parse_queue(src)
    if not incoming["tasks"]:
        print("Added 0 tasks (file had no ## sections)")
        return
    def go():
        append_tasks_from_parsed(incoming, False)
    with_lock(go)


def cmd_archive_to_done(args):
    if not args:
        print("archive_to_done: header required", file=sys.stderr)
        sys.exit(1)
    header = args[0]
    notes = ""
    if len(args) >= 2 and args[1] and os.path.isfile(args[1]):
        with open(args[1], encoding="utf-8") as f:
            notes = f.read().strip()
    def go():
        st = load_state()
        i = find_task(st["tasks"], header)
        if i < 0:
            print(f"task not found: {header}", file=sys.stderr)
            sys.exit(1)
        t = st["tasks"].pop(i)
        tags = [x for x in t["tags"] if x not in ("dev-ready", "in-progress")]
        parts = [f"Completed: {time.strftime('%Y-%m-%d')}"]
        if notes:
            parts.extend(["", "### PO notes", "", notes])
        if t.get("description"):
            parts.extend(["", t["description"]])
        st["done"].append({
            "title": t["title"],
            "tags": tags,
            "description": "\n".join(parts).strip(),
        })
        save_state(st)
        print(f"Archived: {t['title']}")
    with_lock(go)


def cmd_dump_views(args):
    def go():
        st = load_state()
        dump_views(st)
        print("Dumped views")
    with_lock(go)


cmds = {
    "get": cmd_get,
    "get_available": cmd_get_available,
    "get_by_header": cmd_get_by_header,
    "headers": cmd_headers,
    "complete": cmd_complete,
    "complete_by_header": cmd_complete_by_header,
    "mark": cmd_mark,
    "unmark": cmd_unmark,
    "set_description": cmd_set_description,
    "has_tag": cmd_has_tag,
    "check_all_tagged": cmd_check_all_tagged,
    "json": cmd_json,
    "add_from_file": cmd_add_from_file,
    "add": cmd_add,
    "archive_to_done": cmd_archive_to_done,
    "dump_views": cmd_dump_views,
}

argv = [a for a in sys.argv[1:] if a]
if not argv or argv[0] not in cmds:
    print(f"Usage: queue <{'|'.join(cmds)}> [args...]", file=sys.stderr)
    sys.exit(1)
cmds[argv[0]](argv[1:])
