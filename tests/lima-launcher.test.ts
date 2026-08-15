import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { limaAppServerLauncher } from "../src/adapters/codex/launcher.js";
import { buildLimaHostEnvironment, LimaClient } from "../src/adapters/codex/lima/client.js";
import {
  DEFAULT_LIMA_INSTANCE,
  GUEST_CODEX_HOME,
  GUEST_NFTABLES_POLICY,
  GUEST_SNAPSHOT_ROOT,
  GUEST_SUPERVISOR,
  GUEST_TOOL_USER
} from "../src/adapters/codex/lima/constants.js";
import { CodexAppServerRunner, sanitizeOutput } from "../src/adapters/codex/runner.js";
import { GatewayError } from "../src/domain/errors.js";

const limactl = fileURLToPath(new URL("./fixtures/fake-limactl.mjs", import.meta.url));
const fakeAppServer = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));
const limaYaml = fileURLToPath(new URL("../scripts/lima/codexgw.yaml", import.meta.url));

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "codexgw-lima-"));
  tempRoots.push(root);
  return root;
}

function client(root: string, instance = DEFAULT_LIMA_INSTANCE): LimaClient {
  return new LimaClient({
    limactl,
    instance,
    guestCodexCommand: "codex"
  });
}

function writeControl(root: string, name: string, value: string): void {
  writeFileSync(join(root, name), value);
}

function withFakeLima<T>(root: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.LIMA_HOME;
  process.env.LIMA_HOME = root;
  return run().finally(() => {
    if (previous === undefined) delete process.env.LIMA_HOME;
    else process.env.LIMA_HOME = previous;
  });
}

describe("Lima executor contract", () => {
  it("launches a fixed guest App Server without Gateway secrets or client-chosen paths", () => {
    const previousToken = process.env.CODEXGW_API_TOKEN;
    const previousKey = process.env.CODEXGW_DATA_ENCRYPTION_KEY;
    process.env.CODEXGW_API_TOKEN = "secret-token-value";
    process.env.CODEXGW_DATA_ENCRYPTION_KEY = "secret-key-value";
    try {
      const launch = client(tempRoot()).launchAppServer();
      expect(launch.command).toBe(limactl);
      expect(launch.args).toEqual([
        "shell", DEFAULT_LIMA_INSTANCE, "--",
        "sudo", "-u", GUEST_SUPERVISOR, "-H", "--",
        "env", `CODEX_HOME=${GUEST_CODEX_HOME}`, "NO_COLOR=1", "TERM=dumb",
        "codex", "app-server"
      ]);
      expect(launch.env.CODEXGW_API_TOKEN).toBeUndefined();
      expect(launch.env.CODEXGW_DATA_ENCRYPTION_KEY).toBeUndefined();
      expect(launch.env.CODEX_HOME).toBeUndefined();
    } finally {
      if (previousToken === undefined) delete process.env.CODEXGW_API_TOKEN;
      else process.env.CODEXGW_API_TOKEN = previousToken;
      if (previousKey === undefined) delete process.env.CODEXGW_DATA_ENCRYPTION_KEY;
      else process.env.CODEXGW_DATA_ENCRYPTION_KEY = previousKey;
    }
  });

  it("starts a stopped instance and fails closed when the instance is missing", async () => {
    const stopped = tempRoot();
    writeControl(stopped, "status", "Stopped");
    await withFakeLima(stopped, async () => {
      await expect(client(stopped).ensureRunning()).resolves.toBeUndefined();
      expect(readFileSync(join(stopped, "started"), "utf8")).toBe(DEFAULT_LIMA_INSTANCE);
    });

    const missing = tempRoot();
    writeControl(missing, "status", "Missing");
    writeControl(missing, "list-format", "array");
    await withFakeLima(missing, async () => {
      await expect(client(missing).ensureRunning()).rejects.toMatchObject({
        code: "CODEX_NOT_CONFIGURED",
        retryable: false
      });
    });
  });

  it("copies a host repository into a read-only guest snapshot and remaps cwd", async () => {
    const root = tempRoot();
    const hostRepo = join(root, "repo");
    mkdirSync(hostRepo);
    writeFileSync(join(hostRepo, "canary.txt"), "visible-in-guest");
    await withFakeLima(root, async () => {
      const workspace = await limaAppServerLauncher(client(root)).prepareWorkspace(hostRepo);
      expect(workspace.cwd.startsWith(`${GUEST_SNAPSHOT_ROOT}/`)).toBe(true);
      expect(workspace.extraRedactPaths).toEqual([workspace.cwd]);
      const copied = readFileSync(join(root, "guest", workspace.cwd, "canary.txt"), "utf8");
      expect(copied).toBe("visible-in-guest");
      expect(readFileSync(join(root, "chmod"), "utf8")).toContain("0711");
      expect(readFileSync(join(root, "chmod"), "utf8")).toContain("u=rx,g=rx,o=");
      expect(readFileSync(join(root, "chown"), "utf8")).toContain(`root:${GUEST_SUPERVISOR}`);
      await workspace.cleanup();
      expect(existsSync(join(root, "guest", workspace.cwd))).toBe(false);
    });
  });

  it("accepts limactl JSON arrays and keeps host environment allowlisted", async () => {
    const root = tempRoot();
    writeControl(root, "list-format", "array");
    await withFakeLima(root, async () => {
      await expect(client(root).ensureRunning()).resolves.toBeUndefined();
    });
    const env = buildLimaHostEnvironment({
      PATH: "/bin",
      HOME: "/Users/test",
      CODEXGW_API_TOKEN: "secret",
      OPENAI_API_KEY: "secret",
      CODEX_HOME: "/should-not-copy"
    });
    expect(env.PATH).toBe("/bin");
    expect(env).not.toHaveProperty("CODEXGW_API_TOKEN");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("CODEX_HOME");
  });

  it("redacts guest snapshot paths as the repository and uses the remapped cwd", async () => {
    const guestPath = `${GUEST_SNAPSHOT_ROOT}/11111111-2222-3333-4444-555555555555`;
    expect(sanitizeOutput(`open ${guestPath}/src/main.ts`, "/host/repo", guestPath))
      .toBe("open [repository]/src/main.ts");
    const runner = new CodexAppServerRunner({
      command: fakeAppServer,
      codexHome: "/tmp/codexgw-fake-home",
      rpcTimeoutMs: 1_000,
      turnTimeoutMs: 1_000,
      maxResultBytes: 1024,
      launcher: {
        async ensureReady() { /* fake guest is already running */ },
        async prepareWorkspace() {
          return { cwd: guestPath, extraRedactPaths: [guestPath], cleanup: async () => undefined };
        },
        launch() {
          return {
            command: fakeAppServer,
            args: ["app-server"],
            env: { PATH: process.env.PATH, NO_COLOR: "1" }
          };
        }
      }
    });
    const result = await runner.run({
      repositoryPath: "/host/repo",
      backendThreadId: null,
      prompt: "review",
      outputSchema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] },
      signal: new AbortController().signal,
      onEvent: async () => undefined
    });
    expect(result.backendThreadId).toBe("thread-fake");
    expect(result.result).toBe('{"verdict":""}');
  });

  it("keeps the Lima template free of host mounts and records both guest users", () => {
    const yaml = readFileSync(limaYaml, "utf8");
    expect(yaml).toContain("plain: true");
    expect(yaml).toContain("mounts: []");
    expect(yaml).toContain("networks: []");
    expect(yaml).toContain(GUEST_SUPERVISOR);
    expect(yaml).toContain(GUEST_TOOL_USER);
    expect(yaml).toContain(GUEST_CODEX_HOME);
    expect(yaml).toContain("chmod 0711 /var/lib/codexgw/snapshots");
    expect(yaml).toContain("nft");
    expect(GUEST_NFTABLES_POLICY).toContain("tcp dport 443 accept");
    expect(GUEST_NFTABLES_POLICY).toContain("169.254.0.0/16");
  });

  it("rejects an incomplete host snapshot instead of extracting a partial archive", async () => {
    const root = tempRoot();
    await withFakeLima(root, async () => {
      await expect(client(root).copySnapshot(join(root, "missing-repo"))).rejects.toMatchObject({
        code: "CODEX_EXECUTION_FAILED"
      });
    });
  });

  it("maps missing limactl to a closed Codex configuration error", async () => {
    const missing = new LimaClient({
      limactl: join(tempRoot(), "missing-limactl"),
      instance: DEFAULT_LIMA_INSTANCE,
      guestCodexCommand: "codex"
    });
    await expect(missing.ensureRunning()).rejects.toBeInstanceOf(GatewayError);
    await expect(missing.ensureRunning()).rejects.toMatchObject({ code: "CODEX_NOT_CONFIGURED" });
  });
});
