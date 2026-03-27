/**
 * File-backed inbox transport (init, send, register-route, drain). Delegates dispatch to Bash
 * workflow functions (same contract as former jaiph::inbox_* in inbox.sh).
 */
import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { appendRunSummaryLine, formatUtcTimestamp } from "./emit";
import { acquireLock, releaseLock } from "./fs-lock";

function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function inboxDir(): string {
  const d = process.env.JAIPH_INBOX_DIR;
  if (!d) {
    process.stderr.write("jaiph inbox: JAIPH_INBOX_DIR is not set\n");
    process.exit(1);
  }
  return d;
}

function routesPath(dir: string): string {
  return join(dir, ".routes");
}

function readRoutesMap(dir: string): Map<string, string[]> {
  const p = routesPath(dir);
  if (!existsSync(p)) return new Map();
  const map = new Map<string, string[]>();
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    if (line === "") continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const ch = line.slice(0, tab);
    const targets = line
      .slice(tab + 1)
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    map.set(ch, targets);
  }
  return map;
}

function writeRoutesMap(dir: string, map: Map<string, string[]>): void {
  const lines = [...map.entries()].map(([ch, t]) => `${ch}\t${t.join(" ")}`);
  writeFileSync(routesPath(dir), lines.length ? `${lines.join("\n")}\n` : "", "utf8");
}

function lookupTargets(dir: string, channel: string): string[] {
  return readRoutesMap(dir).get(channel) ?? [];
}

function emitEnqueue(channel: string, seqPadded: string, sender: string, content: string): void {
  const max = 4096;
  let payload_preview: string;
  let payload_ref: string | null;
  if (content.length <= max) {
    payload_preview = content;
    payload_ref = null;
  } else {
    payload_preview = `${content.slice(0, max)}...`;
    payload_ref = `inbox/${seqPadded}-${channel}.txt`;
  }
  const line = JSON.stringify({
    type: "INBOX_ENQUEUE",
    inbox_seq: seqPadded,
    channel,
    sender,
    payload_preview,
    payload_ref,
    ts: formatUtcTimestamp(),
    run_id: process.env.JAIPH_RUN_ID ?? "",
    event_version: 1,
  });
  appendRunSummaryLine(line);
}

function emitDispatchStart(seqPadded: string, channel: string, target: string, sender: string): void {
  appendRunSummaryLine(
    JSON.stringify({
      type: "INBOX_DISPATCH_START",
      inbox_seq: seqPadded,
      channel,
      target,
      sender,
      ts: formatUtcTimestamp(),
      run_id: process.env.JAIPH_RUN_ID ?? "",
      event_version: 1,
    }),
  );
}

function emitDispatchComplete(
  seqPadded: string,
  channel: string,
  target: string,
  sender: string,
  status: number,
  elapsedMs: number,
): void {
  appendRunSummaryLine(
    JSON.stringify({
      type: "INBOX_DISPATCH_COMPLETE",
      inbox_seq: seqPadded,
      channel,
      target,
      sender,
      status,
      elapsed_ms: elapsedMs,
      ts: formatUtcTimestamp(),
      run_id: process.env.JAIPH_RUN_ID ?? "",
      event_version: 1,
    }),
  );
}

function cmdInit(): void {
  const dir = inboxDir();
  mkdirSync(dir, { recursive: true });
  const queueFile = join(dir, ".queue");
  const seqFile = join(dir, ".seq");
  writeFileSync(seqFile, "0", "utf8");
  writeFileSync(queueFile, "", "utf8");
  writeRoutesMap(dir, new Map());
}

function cmdSend(): number {
  const dir = inboxDir();
  let channel: string;
  let content: string;
  let sender: string;
  const argChannel = process.argv[3];
  const argContent = process.argv[4];
  if (argChannel !== undefined && argContent !== undefined) {
    channel = argChannel;
    content = argContent;
    sender = process.argv[5] ?? "";
  } else {
    const raw = readFileSync(0, "utf8").replace(/\r?\n$/, "");
    try {
      const obj = JSON.parse(raw) as { channel?: string; content?: string; sender?: string };
      if (typeof obj.channel !== "string" || typeof obj.content !== "string") {
        process.stderr.write("jaiph inbox send: expected args or JSON {channel, content, sender?}\n");
        return 1;
      }
      channel = obj.channel;
      content = obj.content;
      sender = typeof obj.sender === "string" ? obj.sender : "";
    } catch {
      process.stderr.write("jaiph inbox send: invalid JSON on stdin\n");
      return 1;
    }
  }

  const parallel = process.env.JAIPH_INBOX_PARALLEL === "true";
  const lockDir = join(dir, ".seq.lock");
  let locked = false;
  if (parallel) {
    if (!acquireLock(lockDir)) return 1;
    locked = true;
  }
  try {
    const seqFile = join(dir, ".seq");
    let seq = 0;
    if (existsSync(seqFile)) {
      const t = readFileSync(seqFile, "utf8").trim();
      const n = parseInt(t, 10);
      seq = Number.isNaN(n) ? 0 : n;
    }
    seq += 1;
    writeFileSync(seqFile, String(seq), "utf8");
    const seqPadded = String(seq).padStart(3, "0");
    const msgFile = join(dir, `${seqPadded}-${channel}.txt`);
    writeFileSync(msgFile, content, "utf8");
    const queueFile = join(dir, ".queue");
    const qLine = `${channel}:${seqPadded}:${sender}\n`;
    appendFileSync(queueFile, qLine, "utf8");
    emitEnqueue(channel, seqPadded, sender, content);
  } finally {
    if (locked) releaseLock(lockDir);
  }
  return 0;
}

function cmdRegisterRoute(): number {
  const dir = inboxDir();
  const channel = process.argv[3];
  const newTargets = process.argv.slice(4);
  if (!channel) {
    process.stderr.write("jaiph inbox register-route: missing channel\n");
    return 1;
  }
  const map = readRoutesMap(dir);
  const existing = map.get(channel) ?? [];
  map.set(channel, [...existing, ...newTargets]);
  writeRoutesMap(dir, map);
  return 0;
}

function parseQueueEntry(entry: string): { channel: string; seqPadded: string; sender: string } {
  const c1 = entry.indexOf(":");
  if (c1 < 0) {
    process.stderr.write(`jaiph inbox: malformed queue entry\n`);
    process.exit(1);
  }
  const channel = entry.slice(0, c1);
  const rest = entry.slice(c1 + 1);
  const c2 = rest.indexOf(":");
  let seqPadded: string;
  let sender: string;
  if (c2 < 0) {
    seqPadded = rest;
    sender = "";
  } else {
    seqPadded = rest.slice(0, c2);
    sender = rest.slice(c2 + 1);
  }
  if (sender === seqPadded) sender = "";
  return { channel, seqPadded, sender };
}

function bashDispatchArgv(
  target: string,
  content: string,
  channel: string,
  sender: string,
): string[] {
  const mod = process.env.JAIPH_RUN_STEP_MODULE;
  if (!mod || !existsSync(mod)) {
    process.stderr.write("jaiph inbox: JAIPH_RUN_STEP_MODULE must name an existing workflow module\n");
    process.exit(1);
  }
  const inner = `set -eo pipefail
set +u
source ${shellSingleQuote(mod)}
${shellSingleQuote(target)} ${shellSingleQuote(content)} ${shellSingleQuote(channel)} ${shellSingleQuote(sender)}`;
  return ["--noprofile", "--norc", "-c", inner, "_"];
}

function dispatchEnv(channel: string, sender: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    JAIPH_DISPATCH_CHANNEL: channel,
    JAIPH_DISPATCH_SENDER: sender,
  };
}

function runDispatchSequential(
  seqPadded: string,
  channel: string,
  target: string,
  sender: string,
  content: string,
): number {
  emitDispatchStart(seqPadded, channel, target, sender);
  const t0 = Date.now();
  const r = spawnSync("bash", bashDispatchArgv(target, content, channel, sender), {
    env: dispatchEnv(channel, sender),
    stdio: "inherit",
  });
  const st = r.status ?? 1;
  emitDispatchComplete(seqPadded, channel, target, sender, st, Date.now() - t0);
  return st;
}

function startDispatchParallel(
  seqPadded: string,
  channel: string,
  target: string,
  sender: string,
  content: string,
): ChildProcessWithoutNullStreams {
  emitDispatchStart(seqPadded, channel, target, sender);
  const t0 = Date.now();
  const cp = spawn("bash", bashDispatchArgv(target, content, channel, sender), {
    env: dispatchEnv(channel, sender),
    stdio: "inherit",
  }) as ChildProcessWithoutNullStreams;
  cp.on("exit", (code, sig) => {
    const st = code ?? (sig ? 1 : 0);
    emitDispatchComplete(seqPadded, channel, target, sender, st, Date.now() - t0);
  });
  return cp;
}

/** Resolves status after the child exits (handles subscribe-after-exit: `once("exit")` never fires). */
async function waitChildStatus(cp: ChildProcess): Promise<number> {
  if (cp.exitCode !== null) {
    return cp.exitCode;
  }
  if (cp.signalCode) {
    return 1;
  }
  const [code, sig] = await once(cp, "exit");
  return typeof code === "number" ? code : sig ? 1 : 1;
}

async function cmdDrainAsync(): Promise<number> {
  const dir = inboxDir();
  const queueFile = join(dir, ".queue");
  const maxDepthRaw = process.env.JAIPH_INBOX_MAX_DISPATCH_DEPTH ?? "100";
  const maxDepth = /^\d+$/.test(maxDepthRaw) ? parseInt(maxDepthRaw, 10) : 100;
  const parallel = process.env.JAIPH_INBOX_PARALLEL === "true";
  let depth = 0;
  let cursor = 0;

  while (true) {
    if (!existsSync(queueFile)) break;
    const allLines = readFileSync(queueFile, "utf8").split(/\r?\n/).filter((l) => l !== "");
    const batch = allLines.slice(cursor);
    if (batch.length === 0) break;

    if (parallel) {
      const children: ChildProcessWithoutNullStreams[] = [];
      for (const entry of batch) {
        depth += 1;
        cursor += 1;
        if (depth > maxDepth) {
          process.stderr.write(
            `jaiph: E_DISPATCH_DEPTH — dispatch loop exceeded ${maxDepth} iterations (possible circular sends)\n`,
          );
          return 1;
        }
        const { channel, seqPadded, sender } = parseQueueEntry(entry);
        const targets = lookupTargets(dir, channel);
        if (targets.length === 0) continue;
        const msgFile = join(dir, `${seqPadded}-${channel}.txt`);
        const content = readFileSync(msgFile, "utf8");
        for (const target of targets) {
          children.push(startDispatchParallel(seqPadded, channel, target, sender, content));
        }
      }
      let anyFail = 0;
      for (const c of children) {
        const st = await waitChildStatus(c);
        if (st !== 0) anyFail = 1;
      }
      if (anyFail) return 1;
    } else {
      for (const entry of batch) {
        depth += 1;
        cursor += 1;
        if (depth > maxDepth) {
          process.stderr.write(
            `jaiph: E_DISPATCH_DEPTH — dispatch loop exceeded ${maxDepth} iterations (possible circular sends)\n`,
          );
          return 1;
        }
        const { channel, seqPadded, sender } = parseQueueEntry(entry);
        const targets = lookupTargets(dir, channel);
        if (targets.length === 0) continue;
        const msgFile = join(dir, `${seqPadded}-${channel}.txt`);
        const content = readFileSync(msgFile, "utf8");
        for (const target of targets) {
          const st = runDispatchSequential(seqPadded, channel, target, sender, content);
          if (st !== 0) return 1;
        }
      }
    }
  }
  return 0;
}

async function mainAsync(): Promise<number> {
  const cmd = process.argv[2];
  if (cmd === "init") {
    cmdInit();
    return 0;
  }
  if (cmd === "send") {
    return cmdSend();
  }
  if (cmd === "register-route") {
    return cmdRegisterRoute();
  }
  if (cmd === "drain") {
    return await cmdDrainAsync();
  }
  process.stderr.write("jaiph inbox: expected init | send | register-route | drain\n");
  return 1;
}

if (resolve(process.argv[1] ?? "") === resolve(__filename)) {
  void mainAsync()
    .then((code) => process.exit(code))
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`jaiph inbox: ${msg}\n`);
      process.exit(1);
    });
}
