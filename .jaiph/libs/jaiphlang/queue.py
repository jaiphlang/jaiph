#!/usr/bin/env python3
import sys, os, re, json

def queue_path():
    return os.path.join(os.environ.get("JAIPH_WORKSPACE", "."), "QUEUE.md")

def clean_header(h):
    h = h.strip()
    if h.startswith("## "):
        h = h[3:]
    return re.sub(r"\s*#[A-Za-z0-9_-]+", "", h).strip()

def parse_queue(path):
    if not os.path.isfile(path):
        return {"description": "", "tasks": []}
    with open(path) as f:
        text = f.read()
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

def write_queue(path, q):
    lines = []
    if q["description"]:
        lines.append(q["description"])
        lines.append("")
    for t in q["tasks"]:
        tag_s = " " + " ".join(f"#{x}" for x in t["tags"]) if t["tags"] else ""
        lines.append(f"## {t['title']}{tag_s}")
        if t["description"]:
            lines.append("")
            lines.append(t["description"])
        lines.append("")
    with open(path, "w") as f:
        f.write("\n".join(lines).rstrip() + "\n")

def fmt_task(t):
    tag_s = " " + " ".join(f"#{x}" for x in t["tags"]) if t["tags"] else ""
    h = f"## {t['title']}{tag_s}"
    return f"{h}\n\n{t['description']}" if t["description"] else h

def find_task(tasks, header):
    needle = clean_header(header)
    for i, t in enumerate(tasks):
        if t["title"] == needle:
            return i
    return -1

def cmd_get(args):
    tag = args[0] if args else None
    q = parse_queue(queue_path())
    for t in q["tasks"]:
        if tag is None or tag in t["tags"]:
            print(fmt_task(t))
            return
    sys.exit(1)

def cmd_get_by_header(args):
    if not args:
        print("get_by_header: header required", file=sys.stderr)
        sys.exit(1)
    q = parse_queue(queue_path())
    i = find_task(q["tasks"], args[0])
    if i < 0:
        print(f"task not found: {args[0]}", file=sys.stderr)
        sys.exit(1)
    print(fmt_task(q["tasks"][i]))

def cmd_headers(args):
    tag = args[0] if args else None
    q = parse_queue(queue_path())
    for t in q["tasks"]:
        if tag is None or tag in t["tags"]:
            print(t["title"])

def cmd_complete(args):
    tag = args[0] if args else None
    path = queue_path()
    q = parse_queue(path)
    for i, t in enumerate(q["tasks"]):
        if tag is None or tag in t["tags"]:
            removed = q["tasks"].pop(i)
            write_queue(path, q)
            print(f"Completed: {removed['title']}")
            return
    print("No matching task found", file=sys.stderr)
    sys.exit(1)

def cmd_complete_by_header(args):
    if not args:
        print("complete_by_header: header required", file=sys.stderr)
        sys.exit(1)
    path = queue_path()
    q = parse_queue(path)
    i = find_task(q["tasks"], args[0])
    if i < 0:
        print(f"task not found: {args[0]}", file=sys.stderr)
        sys.exit(1)
    q["tasks"].pop(i)
    write_queue(path, q)
    print(f"Completed: {args[0]}")

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
    qpath = queue_path()
    q = parse_queue(qpath)
    i = find_task(q["tasks"], header)
    if i < 0:
        print(f"task not found: {header}", file=sys.stderr)
        sys.exit(1)
    q["tasks"][i]["description"] = body.rstrip()
    write_queue(qpath, q)
    print(f"Updated description: {q['tasks'][i]['title']}")

def cmd_mark(args):
    if len(args) < 2:
        print("mark: header and tag required", file=sys.stderr)
        sys.exit(1)
    header, tag = args[0], args[1]
    path = queue_path()
    q = parse_queue(path)
    i = find_task(q["tasks"], header)
    if i < 0:
        print(f"task not found: {header}", file=sys.stderr)
        sys.exit(1)
    t = q["tasks"][i]
    if tag not in t["tags"]:
        t["tags"].append(tag)
        write_queue(path, q)
    print(f"Marked #{tag}: {t['title']}")

def cmd_check_all_tagged(args):
    if not args:
        print("check_all_tagged: tag required", file=sys.stderr)
        sys.exit(1)
    tag = args[0]
    q = parse_queue(queue_path())
    if not q["tasks"]:
        sys.exit(1)
    for t in q["tasks"]:
        if tag not in t["tags"]:
            sys.exit(1)

def cmd_has_tag(args):
    if len(args) < 2:
        print("has_tag: text and tag required", file=sys.stderr)
        sys.exit(1)
    first_line = args[0].split("\n")[0]
    if f"#{args[1]}" not in first_line:
        sys.exit(1)

def cmd_json(args):
    print(json.dumps(parse_queue(queue_path()), indent=2))

cmds = {
    "get": cmd_get, "get_by_header": cmd_get_by_header,
    "headers": cmd_headers, "complete": cmd_complete,
    "complete_by_header": cmd_complete_by_header, "mark": cmd_mark,
    "set_description": cmd_set_description,
    "has_tag": cmd_has_tag, "check_all_tagged": cmd_check_all_tagged,
    "json": cmd_json,
}

argv = [a for a in sys.argv[1:] if a]
if not argv or argv[0] not in cmds:
    print(f"Usage: queue <{'|'.join(cmds)}> [args...]", file=sys.stderr)
    sys.exit(1)
cmds[argv[0]](argv[1:])
