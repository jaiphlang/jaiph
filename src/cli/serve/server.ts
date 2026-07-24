import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { MAX_BODY_BYTES, type ServeHandler, type ServeRequest } from "./handler";

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
      .then(({ body, tooLarge }) => {
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
        res.writeHead(response.status, response.headers);
        res.end(response.body);
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

/** Read the request body as a string, flagging (and truncating) once it passes the cap. */
function readBody(req: IncomingMessage): Promise<{ body: string; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        // Past the cap: stop buffering (bound memory) but keep draining so the
        // socket can carry the 413 response.
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve({ body: tooLarge ? "" : Buffer.concat(chunks).toString("utf8"), tooLarge }));
    req.on("error", reject);
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
