import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateRelease,
  canonicalizeRepositoryRegistry,
  darwinArchitecture,
  LAUNCH_AGENT_LABEL,
  renderLaunchAgent,
  snapshotLegacyReleaseAssets,
  waitUntilGatewayPortAvailable,
  waitUntilReady
} from "../scripts/local-production.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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

  it("uses Darwin's x86_64 architecture name for Node x64", () => {
    expect(darwinArchitecture("x64")).toBe("x86_64");
    expect(darwinArchitecture("arm64")).toBe("arm64");
  });

  it("aborts a hanging readiness request and continues until the deadline", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("request timed out")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const rejection = expect(waitUntilReady(50, 10, 5)).rejects.toThrow(
      "LaunchAgent started but readiness failed: request timed out"
    );
    await vi.advanceTimersByTimeAsync(60);
    await rejection;
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("snapshots shared legacy assets into the active release", () => {
    const base = mkdtempSync(join(tmpdir(), "codexgw-local-production-"));
    temporaryDirectories.push(base);
    const release = join(base, "releases", "legacy");
    mkdirSync(release, { recursive: true });
    mkdirSync(join(base, "bin"));
    mkdirSync(join(base, "config"));
    for (const [path, contents] of [
      [join(base, "bin", "launcher.sh"), "launcher"],
      [join(base, "bin", "gatewayctl"), "gatewayctl"],
      [join(base, "config", "repositories.json"), "[]"],
      [join(base, "config", "codex-command"), "/usr/bin/codex"],
      [join(base, "config", "codex-home"), "/tmp/codex-home"]
    ] as const) writeFileSync(path, contents);

    snapshotLegacyReleaseAssets(base, "releases/legacy");

    expect(readFileSync(join(release, "bin", "launcher.sh"), "utf8")).toBe("launcher");
    expect(readFileSync(join(release, "config", "codex-home"), "utf8")).toBe("/tmp/codex-home");
    expect(statSync(join(release, "bin", "gatewayctl")).mode & 0o777).toBe(0o700);
    expect(statSync(join(release, "config", "repositories.json")).mode & 0o777).toBe(0o600);
  });

  it("registers backup recovery before stopping and includes SQLite sidecars", () => {
    const script = readFileSync(new URL("../scripts/local-production/gatewayctl.sh", import.meta.url), "utf8");
    const backup = script.slice(script.indexOf("  backup)"), script.indexOf("  rollback)"));

    expect(backup.indexOf("trap restore_service EXIT INT TERM")).toBeLessThan(backup.indexOf("      stop"));
    expect(backup).toContain("for suffix in -wal -shm -journal");
    expect(backup).toContain("/bin/cp -p");
    expect(backup).toContain("Gateway is still loaded; refusing an inconsistent backup");
    expect(backup).toContain("Backup destination must be new");
    expect(backup).toContain("Backup completed but the Gateway could not be restarted");
  });

  it("pins launcher and control configuration to the selected release", () => {
    for (const scriptName of ["launcher.sh", "gatewayctl.sh"]) {
      const script = readFileSync(new URL(`../scripts/local-production/${scriptName}`, import.meta.url), "utf8");
      expect(script).toContain('RELEASE="${0:A:h:h}"');
      expect(script).not.toContain('${BASE}/current/config');
    }
    const launcher = readFileSync(new URL("../scripts/local-production/launcher.sh", import.meta.url), "utf8");
    expect(launcher).toContain('[[ -O "${CODEX_HOME}" ]]');
    expect(launcher).toContain("dedicated Codex home must have mode 0700");
  });

  it("waits for port 8787 to become available and rejects a persistent listener", async () => {
    let checks = 0;
    await waitUntilGatewayPortAvailable(100, 1, () => ++checks < 3);
    expect(checks).toBe(3);
    await expect(waitUntilGatewayPortAvailable(0, 1, () => true)).rejects.toThrow(
      "TCP port 8787 is already in use"
    );
  });

  it.each(["activate", "writePlist", "waitForPortAvailable", "bootstrap", "kickstart", "waitUntilReady"] as const)(
    "restores the previous release when %s fails",
    async (failingAction) => {
      const events: string[] = [];
      let failurePending = true;
      const run = (action: typeof failingAction) => {
        events.push(action);
        if (action === failingAction && failurePending) {
          failurePending = false;
          throw new Error(`${action} failed`);
        }
      };

      await expect(activateRelease("releases/candidate", "releases/previous", {
        activate: (target) => { events.push(`activate:${target}`); run("activate"); },
        writePlist: () => run("writePlist"),
        bootout: () => { events.push("bootout"); },
        waitForPortAvailable: async () => run("waitForPortAvailable"),
        bootstrap: () => run("bootstrap"),
        kickstart: () => run("kickstart"),
        waitUntilReady: async () => run("waitUntilReady"),
        removeCandidate: () => { events.push("removeCandidate"); },
        removeCurrent: () => { events.push("removeCurrent"); },
        removePlist: () => { events.push("removePlist"); }
      })).rejects.toThrow(`${failingAction} failed`);

      expect(events).toContain("activate:releases/previous");
      expect(events).toContain("removeCandidate");
      expect(events).not.toContain("removeCurrent");
      expect(events.at(-1)).toBe("waitUntilReady");
    }
  );

  it("surfaces rollback restart failure", async () => {
    let readinessCalls = 0;
    await expect(activateRelease("releases/candidate", "releases/previous", {
      activate: () => {},
      writePlist: () => {},
      bootout: () => {},
      waitForPortAvailable: async () => {},
      bootstrap: () => {},
      kickstart: () => {},
      waitUntilReady: async () => { throw new Error(`readiness ${++readinessCalls}`); },
      removeCandidate: () => {},
      removeCurrent: () => {},
      removePlist: () => {}
    })).rejects.toThrow("Deployment failed and the previous release could not be restarted: readiness 2");
  });

  it("surfaces failure to restore the previous selector", async () => {
    await expect(activateRelease("releases/candidate", "releases/previous", {
      activate: (target) => {
        if (target === "releases/previous") throw new Error("selector restore failed");
      },
      writePlist: () => {},
      bootout: () => {},
      waitForPortAvailable: async () => {},
      bootstrap: () => {},
      kickstart: () => {},
      waitUntilReady: async () => { throw new Error("candidate not ready"); },
      removeCandidate: () => {},
      removeCurrent: () => {},
      removePlist: () => {}
    })).rejects.toThrow("Deployment failed and the previous release could not be restarted: selector restore failed");
  });

  it("removes the selector and plist when a first install fails", async () => {
    const removed: string[] = [];
    await expect(activateRelease("releases/candidate", undefined, {
      activate: () => {},
      writePlist: () => {},
      bootout: () => {},
      waitForPortAvailable: async () => {},
      bootstrap: () => { throw new Error("bootstrap failed"); },
      kickstart: () => {},
      waitUntilReady: async () => {},
      removeCandidate: () => { removed.push("candidate"); },
      removeCurrent: () => { removed.push("current"); },
      removePlist: () => { removed.push("plist"); }
    })).rejects.toThrow("bootstrap failed");

    expect(removed).toEqual(["candidate", "current", "plist"]);
  });

  it("rotates tokens without exposing a read-back command", () => {
    const script = readFileSync(new URL("../scripts/local-production/gatewayctl.sh", import.meta.url), "utf8");

    expect(script).toContain("  rotate-token)");
    expect(script).not.toContain("  token)");
    expect(script).not.toContain("find-generic-password");
  });
});
