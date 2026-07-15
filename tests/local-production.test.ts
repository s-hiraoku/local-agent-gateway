import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalizeRepositoryRegistry,
  LAUNCH_AGENT_LABEL,
  renderLaunchAgent
} from "../scripts/local-production.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("local production installer", () => {
  it("renders a throttled LaunchAgent without embedding secrets", () => {
    const plist = renderLaunchAgent({
      launcherPath: "/Users/test/Library/Application Support/gateway/bin/launcher.sh",
      home: "/Users/test&owner",
      user: "test-owner",
      stdoutPath: "/tmp/gateway.log",
      stderrPath: "/tmp/gateway.error.log"
    });

    expect(plist).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`);
    expect(plist).toContain("<key>ThrottleInterval</key><integer>30</integer>");
    expect(plist).toContain("/Users/test&amp;owner");
    expect(plist).not.toContain("CODEXGW_API_TOKEN");
    expect(plist).not.toContain("CODEXGW_DATA_ENCRYPTION_KEY");
  });

  it("canonicalizes repository paths and rejects duplicate public IDs", () => {
    const directory = mkdtempSync(join(tmpdir(), "codexgw-local-production-"));
    temporaryDirectories.push(directory);
    const target = join(directory, "target");
    const alias = join(directory, "alias");
    mkdirSync(target);
    symlinkSync(target, alias);

    expect(canonicalizeRepositoryRegistry(JSON.stringify([{ id: "reviews", path: alias }]))).toEqual([
      { id: "reviews", path: realpathSync(target) }
    ]);
    expect(() => canonicalizeRepositoryRegistry(JSON.stringify([
      { id: "reviews", path: target },
      { id: "reviews", path: target }
    ]))).toThrow(/more than once/);
  });
});
