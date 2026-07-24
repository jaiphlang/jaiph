import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream";
import { MAX_BODY_BYTES, type ServeHandler, type ServeRequest } from "./handler";
import type { StreamTarget } from "./runfiles";

/**
 * Wire a `node:http` server to a `ServeHandler`. This is the only place that
 * touches sockets: it reads the request body (aborting past `MAX_BODY_BYTES`
 * so a hostile client can't exhaust memory — the handler turns the flag into a
 * 413), normalizes the request, and streams the handler's response back. All
 * routing/auth/execution decisions live in the handler.
 */
export function createHttpServer(handler: ServeHandler, log: (line: string) => void): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    readBody(req)
      .then(({ body, tooLarge, aborted }) => {
        if (aborted) {
          // The client destroyed the request mid-body: there is no one to
          // respond to and no work to start.
          res.destroy();
          return undefined;
        }
        const url = new URL(req.url ?? "/", "http://localhost");
        const serveReq: ServeRequest = {
          method: req.method ?? "GET",
          path: url.pathname,
          query: url.searchParams,
          headers: req.headers as Record<string, string | undefined>,
          body,
          bodyTooLarge: tooLarge,
        };
        return handler.handleRequest(serveReq);
      })
      .then((response) => {
        if (!response) return undefined;
        res.writeHead(response.status, response.headers);
        if (response.stream) {
          // Long-lived streaming response (SSE follow): drive it over a target
          // wired to this socket, then end when it resolves.
          const target = makeStreamTarget(req, res);
          return response.stream(target).then(() => {
            res.end();
          });
        }
        if (response.bodyFile) {
          return streamBodyFile(response.bodyFile, res);
        }
        res.end(response.body);
        return undefined;
      })
      .catch((err) => {
        log(`jaiph serve: request handling failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
        }
        res.end(JSON.stringify({ error: { code: "E_INTERNAL", message: "internal error" } }));
      });
  });
}

/**
 * Stream a file body with backpressure: `pipeline` pauses the read stream when
 * the socket is congested and destroys it when the client disconnects, so no
 * more than a small stream buffer of the file is ever in memory. The read is
 * pinned to the `size` advertised in `content-length` even if the file grows
 * mid-stream (an appending journal). Errors after the headers are sent cannot
 * become an HTTP error; the connection is simply torn down by `pipeline`.
 */
function streamBodyFile(bodyFile: { path: string; size: number }, res: ServerResponse): Promise<void> {
  if (bodyFile.size === 0) {
    res.end();
    return Promise.resolve();
  }
  const file = createReadStream(bodyFile.path, { start: 0, end: bodyFile.size - 1 });
  return new Promise((resolveStream) => {
    pipeline(file, res, () => resolveStream());
  });
}

/**
 * Wire a `StreamTarget` to a live socket: writes go straight to the response,
 * and the client disconnecting (`req` close) flips `aborted` and fires the
 * registered callbacks so a follow loop stops promptly instead of writing to a
 * dead socket.
 */
function makeStreamTarget(req: IncomingMessage, res: ServerResponse): StreamTarget {
  let aborted = false;
  const onAbortCbs: Array<() => void> = [];
  const abort = (): void => {
    if (aborted) return;
    aborted = true;
    for (const cb of onAbortCbs) cb();
  };
  req.on("close", abort);
  res.on("close", abort);
  return {
    write(chunk: string): void {
      if (!aborted && res.writable) res.write(chunk);
    },
    get aborted(): boolean {
      return aborted;
    },
    onAbort(cb: () => void): void {
      if (aborted) cb();
      else onAbortCbs.push(cb);
    },
  };
}

/** What one request body read settled to. `aborted` means the client went away mid-body. */
export interface ReadBodyResult {
  body: string;
  tooLarge: boolean;
  aborted: boolean;
}

/**
 * Read the request body as a string, flagging (and truncating) once it passes
 * the cap. Always settles: a request destroyed mid-upload never emits `end`,
 * so premature `close` / `error` resolve with `aborted: true` — releasing the
 * buffered chunks and letting the caller drop the request without starting any
 * work. Exported for direct unit testing of that settlement contract.
 */
export function readBody(req: IncomingMessage): Promise<ReadBodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    let settled = false;
    const settle = (result: ReadBodyResult): void => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      resolve(result);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        // Past the cap: stop buffering (bound memory) but keep draining so the
        // socket can carry the 413 response.
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => settle({ body: tooLarge ? "" : Buffer.concat(chunks).toString("utf8"), tooLarge, aborted: false }));
    req.on("close", () => settle({ body: "", tooLarge, aborted: true }));
    req.on("error", () => settle({ body: "", tooLarge, aborted: true }));
  });
}

/** Begin listening; resolves with the actual bound port (handles port 0). */
export function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}
