import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { GatewayError } from "../domain/errors.js";

export const ENCRYPTION_SENTINEL_PLAINTEXT = "local-agent-gateway-sentinel";
export const ENCRYPTION_SENTINEL_CONTEXT = "gateway:sentinel";

export function encryptionKeyId(key: Buffer): string {
  return createHmac("sha256", key).update("local-agent-gateway-key-id").digest("base64url").slice(0, 12);
}

export class SecretBox {
  readonly keyId: string;
  private readonly keys: ReadonlyMap<string, Buffer>;

  constructor(private readonly key: Buffer, previousKeys: readonly Buffer[] = []) {
    if (key.byteLength !== 32) {
      throw new GatewayError("INVALID_REQUEST", "Data encryption key must contain exactly 32 bytes", 500);
    }
    this.keyId = encryptionKeyId(key);
    const keys = new Map<string, Buffer>([[this.keyId, key]]);
    for (const previous of previousKeys) {
      if (previous.byteLength !== 32) {
        throw new GatewayError("INVALID_REQUEST", "Data encryption key must contain exactly 32 bytes", 500);
      }
      keys.set(encryptionKeyId(previous), previous);
    }
    this.keys = keys;
  }

  encrypt(plaintext: string, context = "gateway-data"): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(`v2:${this.keyId}:${context}`, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v2.${this.keyId}.${nonce.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
  }

  decrypt(payload: string, context = "gateway-data"): string {
    const parts = payload.split(".");
    if (parts[0] === "v2") {
      const [, keyId, nonceText, tagText, ciphertextText] = parts;
      if (!keyId || !nonceText || !tagText || ciphertextText === undefined) {
        throw new GatewayError("INTERNAL_ERROR", "Encrypted gateway data is invalid", 500);
      }
      const key = this.keys.get(keyId);
      if (!key) {
        throw new GatewayError("ENCRYPTION_KEY_MISMATCH", "The data encryption key cannot decrypt stored payloads", 500);
      }
      return openPayload(key, nonceText, tagText, ciphertextText, `v2:${keyId}:${context}`);
    }
    const [version, nonceText, tagText, ciphertextText] = parts;
    if (version !== "v1" || !nonceText || !tagText || ciphertextText === undefined) {
      throw new GatewayError("INTERNAL_ERROR", "Encrypted gateway data is invalid", 500);
    }
    let lastError: GatewayError | undefined;
    for (const key of this.keys.values()) {
      try {
        return openPayload(key, nonceText, tagText, ciphertextText, `v1:${context}`);
      } catch (error) {
        lastError = error instanceof GatewayError ? error : lastError;
      }
    }
    throw lastError ?? new GatewayError("INTERNAL_ERROR", "Encrypted gateway data could not be authenticated", 500);
  }

  digest(value: string): string {
    return createHmac("sha256", this.key).update(value).digest("base64url");
  }
}

function openPayload(
  key: Buffer,
  nonceText: string,
  tagText: string,
  ciphertextText: string,
  aad: string
): string {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonceText, "base64url"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, "base64url")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    throw new GatewayError("INTERNAL_ERROR", "Encrypted gateway data could not be authenticated", 500);
  }
}

export function secureTokenEqual(actual: string, expected: string): boolean {
  const actualDigest = createHmac("sha256", "local-agent-gateway-token").update(actual).digest();
  const expectedDigest = createHmac("sha256", "local-agent-gateway-token").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}
