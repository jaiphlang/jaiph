import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash, createPublicKey, verify as ed25519Verify } from "node:crypto";

export const DEFAULT_REGISTRY_URL = "https://jaiph.org/registry";

export const REGISTRY_NAME_REGEX = /^[A-Za-z0-9_-]+$/;

const NAME_ARG_REGEX = /^[A-Za-z0-9_-]+(@[A-Za-z0-9._+/-]+)?$/;

const COMMIT_SHA_REGEX = /^[0-9a-f]{40}$/;

/**
 * Canonical project minisign public key — a byte-for-byte mirror of the
 * repo-root `jaiph.pub` (key id EF1752814A955E92). Embedded as a constant so
 * the compiled standalone binary carries its own trust anchor with no
 * filesystem lookup. A parity test asserts this stays in sync with `jaiph.pub`.
 */
export const EMBEDDED_REGISTRY_PUBKEY =
  "untrusted comment: minisign public key EF1752814A955E92\n" +
  "RWSSXpVKgVIX79jsA5r833g6yWwkO+Ka5HAtSjrN1V7t4+qP4zSOIlWy\n";

/** Remote sources must use one of these schemes; `file://` and scheme-less paths are treated as local. */
const ALLOWED_REMOTE_SCHEMES = new Set(["https", "ssh"]);

export interface RegistryEntry {
  url: string;
  description: string;
  /** Pinned 40-char commit the cloned HEAD must match (integrity pin, not just a post-hoc lock). */
  commit?: string;
  /** Optional detached minisign signature (over the ASCII commit SHA) attesting the release. */
  signature?: string;
  /** Optional per-library minisign public key the `signature` verifies against (else the embedded key). */
  publicKey?: string;
}

export interface RegistryIndex {
  libs: Record<string, RegistryEntry>;
}

/** True for `name` or `name@version` (single segment — no `/`, no `:`). */
export function isRegistryNameArg(arg: string): boolean {
  if (arg.includes("/") || arg.includes(":")) return false;
  return NAME_ARG_REGEX.test(arg);
}

export function parseNameArg(arg: string): { name: string; version?: string } {
  const at = arg.indexOf("@");
  if (at > 0) {
    return { name: arg.slice(0, at), version: arg.slice(at + 1) };
  }
  return { name: arg };
}

/** Pick the registry source: env override wins, else the default URL. */
export function registrySource(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.JAIPH_REGISTRY;
  if (override && override.length > 0) return override;
  return DEFAULT_REGISTRY_URL;
}

/**
 * Reject remote sources that do not use an allowed scheme. A scheme-less value
 * (bare path or scp-style `git@host:path`) and `file://` are treated as local
 * and pass; `https://`/`ssh://` pass; `http://`, `git://`, `ftp://`, etc. throw.
 * `kind` labels the offending value in the error (e.g. `registry source`).
 */
export function assertAllowedRemoteScheme(url: string, kind: string): void {
  const m = url.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\//);
  if (!m) return;
  const scheme = m[1]!.toLowerCase();
  if (scheme === "file" || ALLOWED_REMOTE_SCHEMES.has(scheme)) return;
  throw new Error(
    `${kind} "${url}" uses disallowed scheme "${scheme}://" — only https:// and ssh:// are permitted for remote sources`,
  );
}

/** Build an Ed25519 public KeyObject from a raw 32-byte key by prefixing the fixed SPKI header. */
function ed25519PublicKeyFromRaw(raw32: Buffer) {
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw32]);
  return createPublicKey({ key: spki, format: "der", type: "spki" });
}

/** Decode the last base64 line of a minisign blob to its `{ algo, keyId, payload }` triple. */
function decodeMinisignBlob(text: string): { algo: string; keyId: Buffer; payload: Buffer } {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0 && !l.startsWith("untrusted comment:") && !l.startsWith("trusted comment:"));
  const b64 = lines[0];
  if (!b64) throw new Error("no base64 payload");
  const bytes = Buffer.from(b64, "base64");
  return { algo: bytes.subarray(0, 2).toString("latin1"), keyId: bytes.subarray(2, 10), payload: bytes.subarray(10) };
}

/**
 * Verify a detached minisign `signatureText` over `message` against `pubkeyText`.
 * Supports both the legacy raw (`Ed`) and prehashed blake2b (`ED`) algorithms and
 * requires the signature key id to match the public key. Returns `false` — never
 * throws — on any parse/shape/key-id/crypto mismatch so callers fail closed.
 */
export function verifyMinisign(message: Buffer, signatureText: string, pubkeyText: string): boolean {
  try {
    const pub = decodeMinisignBlob(pubkeyText);
    const sig = decodeMinisignBlob(signatureText);
    if (pub.payload.length !== 32 || sig.payload.length !== 64) return false;
    if (!pub.keyId.equals(sig.keyId)) return false;
    const signed = sig.algo === "ED" ? createHash("blake2b512").update(message).digest() : message;
    return ed25519Verify(null, signed, ed25519PublicKeyFromRaw(pub.payload), sig.payload);
  } catch {
    return false;
  }
}

/**
 * Load and validate the registry index from `source`. `file://` URLs and any
 * value without a `://` scheme are read from disk (trusted-local). Remote
 * sources must use an allowed scheme, are fetched via global `fetch`, and are
 * signature-verified against a detached `<source>.minisig` before use — a
 * missing, unsigned, or tampered index is rejected (fail closed). `opts.publicKey`
 * overrides the embedded trust anchor (tests). Throws `Error` naming the source
 * on any read/fetch/verify/parse/shape failure.
 */
export async function loadRegistryIndex(source: string, opts: { publicKey?: string } = {}): Promise<RegistryIndex> {
  const text = await readRegistrySource(source, opts.publicKey ?? EMBEDDED_REGISTRY_PUBKEY);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`failed to parse registry ${source}: ${(err as Error).message}`);
  }
  return validateRegistryIndex(parsed, source);
}

async function readRegistrySource(source: string, publicKey: string): Promise<string> {
  if (source.startsWith("file://")) {
    const path = fileURLToPath(source);
    return readDisk(path, source);
  }
  if (!source.includes("://")) {
    return readDisk(source, source);
  }
  assertAllowedRemoteScheme(source, "registry source");
  const text = await fetchText(source, `failed to fetch registry ${source}`);
  const sigText = await fetchText(`${source}.minisig`, `failed to fetch registry signature ${source}.minisig`);
  if (!verifyMinisign(Buffer.from(text, "utf8"), sigText, publicKey)) {
    throw new Error(`failed to verify registry ${source}: signature check failed against ${source}.minisig`);
  }
  return text;
}

async function fetchText(url: string, failPrefix: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`${failPrefix}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new Error(`${failPrefix}: HTTP ${res.status}`);
  }
  try {
    return await res.text();
  } catch (err) {
    throw new Error(`${failPrefix}: ${(err as Error).message}`);
  }
}

function readDisk(path: string, source: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`failed to read registry ${source}: ${(err as Error).message}`);
  }
}

function validateRegistryIndex(parsed: unknown, source: string): RegistryIndex {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`failed to parse registry ${source}: top-level must be an object`);
  }
  const libs = (parsed as { libs?: unknown }).libs;
  if (typeof libs !== "object" || libs === null || Array.isArray(libs)) {
    throw new Error(`failed to parse registry ${source}: "libs" must be an object`);
  }
  const out: Record<string, RegistryEntry> = {};
  for (const [name, raw] of Object.entries(libs)) {
    if (!REGISTRY_NAME_REGEX.test(name)) {
      throw new Error(`failed to parse registry ${source}: invalid name "${name}"`);
    }
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`failed to parse registry ${source}: entry "${name}" must be an object`);
    }
    const url = (raw as { url?: unknown }).url;
    const description = (raw as { description?: unknown }).description;
    const commit = (raw as { commit?: unknown }).commit;
    const signature = (raw as { signature?: unknown }).signature;
    const publicKey = (raw as { publicKey?: unknown }).publicKey;
    if (typeof url !== "string" || url.length === 0) {
      throw new Error(`failed to parse registry ${source}: entry "${name}" missing string "url"`);
    }
    try {
      assertAllowedRemoteScheme(url, `entry "${name}" url`);
    } catch (err) {
      throw new Error(`failed to parse registry ${source}: ${(err as Error).message}`);
    }
    if (typeof description !== "string") {
      throw new Error(`failed to parse registry ${source}: entry "${name}" missing string "description"`);
    }
    if (commit !== undefined && (typeof commit !== "string" || !COMMIT_SHA_REGEX.test(commit))) {
      throw new Error(`failed to parse registry ${source}: entry "${name}" "commit" must be a 40-char hex SHA`);
    }
    if (signature !== undefined && typeof signature !== "string") {
      throw new Error(`failed to parse registry ${source}: entry "${name}" "signature" must be a string`);
    }
    if (publicKey !== undefined && typeof publicKey !== "string") {
      throw new Error(`failed to parse registry ${source}: entry "${name}" "publicKey" must be a string`);
    }
    out[name] = {
      url,
      description,
      ...(commit ? { commit } : {}),
      ...(signature ? { signature } : {}),
      ...(publicKey ? { publicKey } : {}),
    };
  }
  return { libs: out };
}
