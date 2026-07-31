import { generateKeyPairSync, sign as ed25519Sign, createHash, type KeyObject } from "node:crypto";

/**
 * Test-only helper: mint an ephemeral minisign keypair and sign messages in the
 * detached minisign format that {@link verifyMinisign} accepts. Kept in a shared
 * module so the registry and install tests don't duplicate the format logic.
 * Not used by any production path.
 */
export interface MinisignFixture {
  /** minisign public-key blob (two lines: comment + base64). */
  publicKey: string;
  /** Produce a detached prehashed (`ED`) minisign signature blob over `message`. */
  sign(message: Buffer): string;
}

const KEY_ID = Buffer.from("0102030405060708", "hex");

function rawPublicKey(key: KeyObject): Buffer {
  const jwk = key.export({ format: "jwk" }) as { x?: string };
  return Buffer.from(jwk.x ?? "", "base64url");
}

export function makeMinisignFixture(): MinisignFixture {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubBlob = Buffer.concat([Buffer.from("Ed", "latin1"), KEY_ID, rawPublicKey(publicKey)]);
  const publicKeyText =
    "untrusted comment: test minisign public key\n" + pubBlob.toString("base64") + "\n";
  return {
    publicKey: publicKeyText,
    sign(message: Buffer): string {
      const digest = createHash("blake2b512").update(message).digest();
      const raw = ed25519Sign(null, digest, privateKey);
      const sigBlob = Buffer.concat([Buffer.from("ED", "latin1"), KEY_ID, raw]);
      return (
        "untrusted comment: test signature\n" +
        sigBlob.toString("base64") +
        "\ntrusted comment: test\n" +
        Buffer.alloc(64).toString("base64") +
        "\n"
      );
    },
  };
}
