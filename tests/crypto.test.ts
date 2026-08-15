import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GatewayError } from "../src/domain/errors.js";
import { encryptionKeyId, SecretBox, secureTokenEqual } from "../src/infrastructure/crypto.js";

function encryptV1(key: Buffer, plaintext: string, context: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`v1:${context}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1.${nonce.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

describe("SecretBox", () => {
  it("encrypts and authenticates stored data", () => {
    const box = new SecretBox(Buffer.alloc(32, 3));
    const encrypted = box.encrypt("sensitive prompt");
    expect(encrypted).not.toContain("sensitive prompt");
    expect(encrypted.startsWith(`v2.${box.keyId}.`)).toBe(true);
    expect(box.decrypt(encrypted)).toBe("sensitive prompt");
    expect(() => box.decrypt(`${encrypted}x`)).toThrow(GatewayError);
  });

  it("binds ciphertext to its record context", () => {
    const box = new SecretBox(Buffer.alloc(32, 3));
    const encrypted = box.encrypt("sensitive prompt", "job:one:prompt");
    expect(box.decrypt(encrypted, "job:one:prompt")).toBe("sensitive prompt");
    expect(() => box.decrypt(encrypted, "job:two:prompt")).toThrow(GatewayError);
  });

  it("reads legacy v1 payloads and mixed key versions during rotation", () => {
    const oldKey = Buffer.alloc(32, 3);
    const newKey = Buffer.alloc(32, 9);
    const current = new SecretBox(oldKey);
    const rotating = new SecretBox(newKey, [oldKey]);
    const legacy = encryptV1(oldKey, "legacy prompt", "job:one:prompt");
    const next = rotating.encrypt("new prompt", "job:one:prompt");

    expect(current.decrypt(legacy, "job:one:prompt")).toBe("legacy prompt");
    expect(rotating.decrypt(legacy, "job:one:prompt")).toBe("legacy prompt");
    expect(rotating.decrypt(next, "job:one:prompt")).toBe("new prompt");
    expect(() => current.decrypt(next, "job:one:prompt")).toThrow(/cannot decrypt stored payloads/);
    expect(encryptionKeyId(oldKey)).not.toBe(encryptionKeyId(newKey));
  });

  it("compares bearer tokens without direct string comparison", () => {
    expect(secureTokenEqual("correct", "correct")).toBe(true);
    expect(secureTokenEqual("wrong", "correct")).toBe(false);
  });
});
