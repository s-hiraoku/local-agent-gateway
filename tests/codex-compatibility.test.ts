import { describe, expect, it } from "vitest";
import {
  assertSupportedCodexVersion,
  compareSemver,
  parseCodexVersion,
  SUPPORTED_CODEX_CLI_RANGE
} from "../src/adapters/codex/compatibility.js";

describe("Codex CLI version contract", () => {
  it("parses the CLI and user-agent version forms", () => {
    expect(parseCodexVersion("codex-cli 0.144.6")).toBe("0.144.6");
    expect(parseCodexVersion("codex_cli_rs/0.128.0 (unix)")).toBe("0.128.0");
    expect(parseCodexVersion("not a version")).toBeUndefined();
  });

  it("accepts the inclusive supported range and rejects outside it", () => {
    expect(compareSemver(SUPPORTED_CODEX_CLI_RANGE.minInclusive, SUPPORTED_CODEX_CLI_RANGE.minInclusive)).toBe(0);
    expect(() => assertSupportedCodexVersion(SUPPORTED_CODEX_CLI_RANGE.minInclusive)).not.toThrow();
    expect(() => assertSupportedCodexVersion(SUPPORTED_CODEX_CLI_RANGE.maxInclusive)).not.toThrow();
    expect(() => assertSupportedCodexVersion("0.144.6")).not.toThrow();
    expect(() => assertSupportedCodexVersion("0.127.99")).toThrow(/not a supported version/);
    expect(() => assertSupportedCodexVersion("0.150.0")).toThrow(/not a supported version/);
  });
});
