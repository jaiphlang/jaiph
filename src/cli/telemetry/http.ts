/**
 * Shared timeout-guarded POST over node:http / node:https for the telemetry
 * exporters (OTLP traces, Sentry error events). Zero dependencies — a single
 * request is the whole transport.
 *
 * Resolves on any 2xx; rejects on a non-2xx status, a transport error, an
 * invalid URL, or the timeout. Telemetry callers treat every rejection as
 * best-effort (exactly one stderr warning) so a failed export is never
 * load-bearing on the run.
 */
import http from "node:http";
import https from "node:https";

/**
 * POST `body` to `endpoint` with the given headers and a hard timeout.
 * `content-length` is derived from the body; the caller supplies `content-type`
 * (and any auth) via `headers`.
 */
export function postWithTimeout(
  endpoint: string,
  body: string | Buffer,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      reject(new Error(`invalid endpoint ${endpoint}`));
      return;
    }
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      {
        method: "POST",
        headers: { "content-length": Buffer.byteLength(body), ...headers },
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          const code = res.statusCode ?? 0;
          if (code >= 200 && code < 300) resolve();
          else reject(new Error(`server returned HTTP ${code}`));
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
