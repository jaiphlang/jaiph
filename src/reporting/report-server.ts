import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { safeArtifactPath } from "./artifact-path";
import { runDirFromRel, safeRelativeRunPath } from "./path-utils";
import {
  createRunRegistry,
  ensureRunSlotLoaded,
  listActiveRuns,
  listRunEntries,
  pollRunRegistry,
  type RunRegistry,
} from "./run-registry";
import { buildStepTree, stepsSortedBySeq } from "./summary-parser";

const PREVIEW_CHARS = 64 * 1024;

export type ReportingServerConfig = {
  host: string;
  port: number;
  runsRoot: string;
  pollMs: number;
  /** Absolute path to copied static assets (dist/src/reporting/public). */
  publicDir: string;
};

export type ReportingServerHandle = {
  close: () => Promise<void>;
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function text(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function capPreview(s: string): { text: string; truncated: boolean } {
  if (s.length <= PREVIEW_CHARS) {
    return { text: s, truncated: false };
  }
  return { text: s.slice(0, PREVIEW_CHARS), truncated: true };
}

function parseQuery(url: string): { path: string; query: URLSearchParams } {
  const q = url.indexOf("?");
  if (q === -1) {
    return { path: url, query: new URLSearchParams() };
  }
  return { path: url.slice(0, q), query: new URLSearchParams(url.slice(q + 1)) };
}

function mimeForPath(filePath: string): string {
  switch (extname(filePath)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function serveStatic(publicDir: string, urlPath: string, res: ServerResponse): void {
  const base = resolve(publicDir);
  const safe = urlPath.replace(/\.\./g, "").replace(/^\/+/, "");
  const filePath = resolve(base, safe);
  if (filePath !== base && !filePath.startsWith(base + sep)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const body = readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": mimeForPath(filePath),
    "Cache-Control": "no-cache",
    "Content-Length": body.length,
  });
  res.end(body);
}

function filterRuns(
  rows: ReturnType<typeof listRunEntries>,
  query: URLSearchParams,
): ReturnType<typeof listRunEntries> {
  const date = query.get("date") ?? "";
  const status = query.get("status") ?? "";
  const q = (query.get("q") ?? "").toLowerCase();
  return rows.filter((r) => {
    if (date && !r.relPath.startsWith(`${date}/`)) {
      return false;
    }
    if (status && r.status !== status) {
      return false;
    }
    if (q) {
      const hay = `${r.relPath} ${r.source} ${r.run_id}`.toLowerCase();
      if (!hay.includes(q)) {
        return false;
      }
    }
    return true;
  });
}

async function streamFileChunk(res: ServerResponse, abs: string): Promise<void> {
  const rs = createReadStream(abs);
  await pipeline(rs, res);
}

export function startReportingServer(cfg: ReportingServerConfig): ReportingServerHandle {
  const reg: RunRegistry = createRunRegistry(cfg.runsRoot);
  pollRunRegistry(reg, Date.now(), { forceScan: true });

  const timer = setInterval(() => {
    pollRunRegistry(reg, Date.now(), { forceScan: false });
  }, cfg.pollMs);
  timer.unref?.();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        json(res, 500, { error: "internal", message });
      } else {
        res.destroy();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const urlRaw = req.url ?? "/";
    const { path, query } = parseQuery(urlRaw);
    if (path.startsWith("/api")) {
      pollRunRegistry(reg, Date.now(), { forceScan: false });
    }

    try {
      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        serveStatic(cfg.publicDir, "index.html", res);
        return;
      }
      if (req.method === "GET" && path === "/run.html") {
        serveStatic(cfg.publicDir, "run.html", res);
        return;
      }
      if (req.method === "GET" && path.startsWith("/assets/")) {
        serveStatic(cfg.publicDir, path.slice(1), res);
        return;
      }

      if (req.method === "GET" && path === "/api/active") {
        json(res, 200, {
          runs: listActiveRuns(reg).map((r) => ({
            path: r.relPath,
            ...r,
          })),
        });
        return;
      }

      if (req.method === "GET" && path === "/api/runs") {
        const page = Math.max(1, parseInt(query.get("page") ?? "1", 10) || 1);
        const limit = Math.min(200, Math.max(1, parseInt(query.get("limit") ?? "50", 10) || 50));
        const filtered = filterRuns(listRunEntries(reg), query);
        const total = filtered.length;
        const start = (page - 1) * limit;
        const slice = filtered.slice(start, start + limit);
        json(res, 200, {
          runs: slice.map((r) => ({
            id: encodeURIComponent(r.relPath),
            path: r.relPath,
            run_id: r.run_id,
            source: r.source,
            started_at: r.started_at,
            ended_at: r.ended_at,
            status: r.status,
            step_count: r.step_total,
            step_completed: r.step_completed,
            step_running: r.step_running,
            failed: r.has_failure,
          })),
          total,
          page,
          page_size: limit,
        });
        return;
      }

      const runPrefix = "/api/runs/";
      if (req.method === "GET" && path.startsWith(runPrefix)) {
        const rest = path.slice(runPrefix.length);
        const segments = rest.split("/").filter(Boolean);
        if (segments.length === 0) {
          json(res, 404, { error: "not_found" });
          return;
        }
        const runEnc = segments[0];
        const rel = safeRelativeRunPath(cfg.runsRoot, runEnc);
        if (!rel) {
          json(res, 400, { error: "bad_run_id" });
          return;
        }
        const slot = ensureRunSlotLoaded(reg, rel);
        if (!slot) {
          json(res, 404, { error: "run_not_found" });
          return;
        }

        if (segments.length === 2 && segments[1] === "tree") {
          const { roots } = buildStepTree(slot.state);
          json(res, 200, {
            run_id: slot.state.run_id,
            path: rel,
            steps: roots,
          });
          return;
        }

        if (segments.length === 2 && segments[1] === "aggregate") {
          res.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
            "Transfer-Encoding": "chunked",
          });
          for (const step of stepsSortedBySeq(slot.state)) {
            res.write(
              `\n--- seq ${step.seq ?? "?"} ${step.kind} ${step.name} (${step.id}) ---\n`,
            );
            const outPath = step.out_file ? safeArtifactPath(cfg.runsRoot, step.out_file) : null;
            if (outPath) {
              await new Promise<void>((resolve, reject) => {
                const rs = createReadStream(outPath);
                rs.on("error", reject);
                rs.on("end", () => resolve());
                rs.pipe(res, { end: false });
              });
            } else if (step.out_content) {
              res.write(step.out_content);
            }
            res.write("\n");
          }
          res.end();
          return;
        }

        if (segments.length === 4 && segments[1] === "steps" && segments[3] === "output") {
          const stepId = decodeURIComponent(segments[2]);
          const step = slot.state.steps.get(stepId);
          if (!step) {
            json(res, 404, { error: "step_not_found" });
            return;
          }
          const oc = capPreview(step.out_content);
          const ec = capPreview(step.err_content);
          json(res, 200, {
            out_content: oc.text,
            err_content: ec.text,
            out_truncated: oc.truncated,
            err_truncated: ec.truncated,
            out_file: step.out_file,
            err_file: step.err_file,
          });
          return;
        }

        if (segments.length === 4 && segments[1] === "steps" && segments[3] === "logs") {
          const stepId = decodeURIComponent(segments[2]);
          const stream = query.get("stream") === "err" ? "err" : "out";
          const step = slot.state.steps.get(stepId);
          if (!step) {
            json(res, 404, { error: "step_not_found" });
            return;
          }
          const raw = stream === "err" ? step.err_file : step.out_file;
          const abs = raw ? safeArtifactPath(cfg.runsRoot, raw) : null;
          if (!abs) {
            text(res, 404, "", "text/plain; charset=utf-8");
            return;
          }
          res.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
            "Transfer-Encoding": "chunked",
          });
          await streamFileChunk(res, abs);
          return;
        }

        json(res, 404, { error: "not_found" });
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      json(res, 500, { error: "internal", message });
    }
  }

  server.listen(cfg.port, cfg.host, () => {
    process.stderr.write(
      `Jaiph reporting server listening on http://${cfg.host}:${cfg.port} (runs: ${cfg.runsRoot})\n`,
    );
  });

  return {
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        clearInterval(timer);
        server.close((err) => {
          if (err) {
            rejectClose(err);
            return;
          }
          resolveClose();
        });
      }),
  };
}
