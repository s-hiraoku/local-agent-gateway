import { describe, expect, it } from "vitest";
import { GatewayError } from "../src/domain/errors.js";
import { SecretBox, secureTokenEqual } from "../src/infrastructure/crypto.js";

describe("SecretBox", () => {
  it("encrypts and authenticates stored data", () => {
    const box = new SecretBox(Buffer.alloc(32, 3));
    const encrypted = box.encrypt("sensitive prompt");
    expect(encrypted).not.toContain("sensitive prompt");
    expect(box.decrypt(encrypted)).toBe("sensitive prompt");
    expect(() => box.decrypt(`${encrypted}x`)).toThrow(GatewayError);
  });

  it("binds ciphertext to its record context", () => {
    const box = new SecretBox(Buffer.alloc(32, 3));
    const encrypted = box.encrypt("sensitive prompt", "job:one:prompt");
    expect(box.decrypt(encrypted, "job:one:prompt")).toBe("sensitive prompt");
    expect(() => box.decrypt(encrypted, "job:two:prompt")).toThrow(GatewayError);
  });

  it("compares bearer tokens without direct string comparison", () => {
    expect(secureTokenEqual("correct", "correct")).toBe(true);
    expect(secureTokenEqual("wrong", "correct")).toBe(false);
  });
});
