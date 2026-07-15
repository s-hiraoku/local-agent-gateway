import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { GatewayError } from "../domain/errors.js";

export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.byteLength !== 32) {
      throw new GatewayError("INVALID_REQUEST", "Data encryption key must contain exactly 32 bytes", 500);
    }
  }

  encrypt(plaintext: string, context = "gateway-data"): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(`v1:${context}`, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${nonce.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
  }

  decrypt(payload: string, context = "gateway-data"): string {
    const [version, nonceText, tagText, ciphertextText] = payload.split(".");
    if (version !== "v1" || !nonceText || !tagText || ciphertextText === undefined) {
      throw new GatewayError("INTERNAL_ERROR", "Encrypted gateway data is invalid", 500);
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(nonceText, "base64url"));
      decipher.setAAD(Buffer.from(`v1:${context}`, "utf8"));
      decipher.setAuthTag(Buffer.from(tagText, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextText, "base64url")),
        decipher.final()
      ]).toString("utf8");
    } catch {
      throw new GatewayError("INTERNAL_ERROR", "Encrypted gateway data could not be authenticated", 500);
    }
  }

  digest(value: string): string {
    return createHmac("sha256", this.key).update(value).digest("base64url");
  }
}

export function secureTokenEqual(actual: string, expected: string): boolean {
  const actualDigest = createHmac("sha256", "local-agent-gateway-token").update(actual).digest();
  const expectedDigest = createHmac("sha256", "local-agent-gateway-token").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}
