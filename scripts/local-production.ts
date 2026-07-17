import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const LAUNCH_AGENT_LABEL = "com.s-hiraoku.local-agent-gateway";
const KEYCHAIN_API_TOKEN = `${LAUNCH_AGENT_LABEL}.api-token`;
const KEYCHAIN_ENCRYPTION_KEY = `${LAUNCH_AGENT_LABEL}.encryption-key`;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");

type LaunchAgentInput = {
  launcherPath: string;
  home: string;
  user: string;
  stdoutPath: string;
  stderrPath: string;
};

type RepositoryEntry = { id: string; path: string };

export type DeploymentActions = {
  activate: (target: string) => void;
  writePlist: () => void;
  bootout: () => void;
  waitForPortAvailable: () => Promise<void>;
  bootstrap: () => void;
  kickstart: () => void;
  waitUntilReady: () => Promise<void>;
  markActive: () => void;
  removeCandidate: () => void;
  removeCurrent: () => void;
  removePlist: () => void;
};

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function renderLaunchAgent(input: LaunchAgentInput): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(input.launcherPath)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>Umask</key><integer>63</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${xml(input.home)}</string>
    <key>USER</key><string>${xml(input.user)}</string>
  </dict>
  <key>StandardOutPath</key><string>${xml(input.stdoutPath)}</string>
  <key>StandardErrorPath</key><string>${xml(input.stderrPath)}</string>
</dict>
</plist>
`;
}

export function canonicalizeRepositoryRegistry(raw: string): RepositoryEntry[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("Repository registry must be a non-empty array");
  const ids = new Set<string>();
  return parsed.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Repository entries must be objects");
    const { id, path } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
      throw new Error("Repository IDs must use lowercase letters, digits, _ or -");
    }
    if (ids.has(id)) throw new Error(`Repository ${id} is configured more than once`);
    ids.add(id);
    if (typeof path !== "string") throw new Error(`Repository ${id} must have a path`);
    const canonicalPath = realpathSync(path);
    if (!statSync(canonicalPath).isDirectory()) throw new Error(`Repository ${id} is not a directory`);
    return { id, path: canonicalPath };
  });
}

export function darwinArchitecture(architecture: string): string {
  return architecture === "x64" ? "x86_64" : architecture;
}

function commandPath(name: string): string {
  const output = execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim();
  if (!output) throw new Error(`${name} is not installed`);
  return output;
}

function keychainHas(account: string, service: string): boolean {
  return spawnSync("/usr/bin/security", ["find-generic-password", "-a", account, "-s", service], {
    stdio: "ignore"
  }).status === 0;
}

function addKeychainSecret(account: string, service: string, value: string): void {
  const result = spawnSync("/usr/bin/security", [
    "add-generic-password", "-U", "-a", account, "-s", service,
    "-l", service, "-j", "Local Agent Gateway local-production secret", "-w", value
  ], { stdio: "ignore" });
  if (result.status !== 0) throw new Error(`Could not create Keychain item ${service}`);
}

function ensureSecrets(account: string): void {
  if (!keychainHas(account, KEYCHAIN_API_TOKEN)) {
    addKeychainSecret(account, KEYCHAIN_API_TOKEN, randomBytes(32).toString("hex"));
  }
  if (!keychainHas(account, KEYCHAIN_ENCRYPTION_KEY)) {
    addKeychainSecret(account, KEYCHAIN_ENCRYPTION_KEY, randomBytes(32).toString("base64"));
  }
}

function writePrivate(path: string, value: string): void {
  const temporary = `${path}.${process.pid}`;
  try {
    writeFileSync(temporary, value, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function makePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function activateTarget(base: string, target: string): void {
  const current = join(base, "current");
  const temporary = join(base, `.current-${process.pid}`);
  rmSync(temporary, { force: true });
  symlinkSync(target, temporary);
  renameSync(temporary, current);
}

function activeTarget(base: string): string | undefined {
  try {
    return readlinkSync(join(base, "current"));
  } catch {
    return undefined;
  }
}

function replaceSymlink(path: string, target: string): void {
  const temporary = `${path}.${process.pid}`;
  rmSync(temporary, { force: true });
  symlinkSync(target, temporary);
  renameSync(temporary, path);
}

export function snapshotLegacyReleaseAssets(base: string, target: string): void {
  const releases = realpathSync(join(base, "releases"));
  const release = realpathSync(resolve(base, target));
  if (!release.startsWith(`${releases}${sep}`)) throw new Error("Active release is outside the releases directory");

  const releaseBin = join(release, "bin");
  const releaseConfig = join(release, "config");
  makePrivateDirectory(releaseBin);
  makePrivateDirectory(releaseConfig);
  for (const [source, destination, mode] of [
    [join(base, "bin", "launcher.sh"), join(releaseBin, "launcher.sh"), 0o700],
    [join(base, "bin", "gatewayctl"), join(releaseBin, "gatewayctl"), 0o700],
    [join(base, "config", "repositories.json"), join(releaseConfig, "repositories.json"), 0o600],
    [join(base, "config", "codex-command"), join(releaseConfig, "codex-command"), 0o600],
    [join(base, "config", "codex-home"), join(releaseConfig, "codex-home"), 0o600]
  ] as const) {
    if (existsSync(destination)) continue;
    if (!existsSync(source)) throw new Error(`Cannot snapshot legacy release; missing ${source}`);
    copyFileSync(source, destination);
    chmodSync(destination, mode);
  }
}

export async function waitUntilReady(
  timeoutMs = 45_000,
  requestTimeoutMs = 2_000,
  retryDelayMs = 1_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "service did not answer";
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const requestTimeout = setTimeout(
      () => controller.abort(),
      Math.max(1, Math.min(requestTimeoutMs, deadline - Date.now()))
    );
    try {
      const response = await fetch("http://127.0.0.1:8787/readyz", { signal: controller.signal });
      if (response.ok) return;
      lastError = `readiness returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(requestTimeout);
    }
    const retryDelay = Math.min(retryDelayMs, deadline - Date.now());
    if (retryDelay > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, retryDelay));
  }
  throw new Error(`LaunchAgent started but readiness failed: ${lastError}`);
}

function gatewayPortHasListener(): boolean {
  const result = spawnSync("/usr/sbin/lsof", ["-nP", "-iTCP:8787", "-sTCP:LISTEN"], { stdio: "ignore" });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error("Could not inspect TCP port 8787 before starting the LaunchAgent");
}

export async function waitUntilGatewayPortAvailable(
  timeoutMs = 5_000,
  retryDelayMs = 100,
  hasListener: () => boolean = gatewayPortHasListener
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (hasListener()) {
    const retryDelay = Math.min(retryDelayMs, deadline - Date.now());
    if (retryDelay <= 0) throw new Error("TCP port 8787 is already in use");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, retryDelay));
  }
}

export function quarantineFailedRelease(
  release: string,
  quarantine: string,
  remove: (path: string) => void = (path) => rmSync(path, { recursive: true, force: true })
): void {
  renameSync(release, quarantine);
  try {
    remove(quarantine);
  } catch {
    // A hidden quarantine is intentionally retained when recursive cleanup is unavailable.
  }
}

export async function activateRelease(
  candidateTarget: string,
  previousTarget: string | undefined,
  actions: DeploymentActions
): Promise<void> {
  try {
    actions.activate(candidateTarget);
    actions.writePlist();
    actions.bootout();
    await actions.waitForPortAvailable();
    actions.bootstrap();
    actions.kickstart();
    await actions.waitUntilReady();
    actions.markActive();
  } catch (error) {
    actions.bootout();
    if (previousTarget) {
      try {
        actions.activate(previousTarget);
        await actions.waitForPortAvailable();
        actions.bootstrap();
        actions.kickstart();
        await actions.waitUntilReady();
      } catch (rollbackError) {
        actions.bootout();
        throw new Error(
          `Deployment failed and the previous release could not be restarted: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          { cause: error }
        );
      }
    } else {
      actions.removeCurrent();
      actions.removePlist();
    }
    try {
      actions.removeCandidate();
    } catch (cleanupError) {
      throw new Error(
        `Deployment failed; rollback completed but the failed candidate could not be removed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        { cause: error }
      );
    }
    throw error;
  }
}

async function install(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Local production installation currently supports macOS only");
  if (Number(process.versions.node.split(".")[0]) !== 26) throw new Error("Node.js 26 is required to build the release");

  const home = homedir();
  const account = userInfo().username;
  const base = option("--base-dir") ?? join(home, "Library", "Application Support", "local-agent-gateway");
  const codexHome = realpathSync(option("--codex-home") ?? join(home, ".codex-gateway"));
  if ((statSync(codexHome).mode & 0o077) !== 0) throw new Error("Dedicated CODEX_HOME must have mode 0700");
  if (existsSync(join(codexHome, "config.toml"))) throw new Error("Dedicated CODEX_HOME must not contain config.toml");
  const codexCommand = commandPath("codex");
  const authCheck = spawnSync(codexCommand, ["login", "status"], {
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: codexHome }
  });
  const authStatus = `${authCheck.stdout ?? ""}${authCheck.stderr ?? ""}`;
  if (authCheck.status !== 0 || !authStatus.includes("ChatGPT")) {
    throw new Error("Dedicated CODEX_HOME is not authenticated with ChatGPT");
  }

  for (const directory of [base, "releases", "data", "config", "logs", "bin", "backups", "workspaces"])
    makePrivateDirectory(directory === base ? base : join(base, directory));
  const reviewsDirectory = join(base, "workspaces", "reviews");
  makePrivateDirectory(reviewsDirectory);

  const previousTarget = activeTarget(base);
  const versionedRegistryPath = join(base, "current", "config", "repositories.json");
  const legacyRegistryPath = join(base, "config", "repositories.json");
  const existingRegistryPath = existsSync(versionedRegistryPath) ? versionedRegistryPath : legacyRegistryPath;
  const suppliedRegistry = option("--repositories-json") ?? process.env.CODEXGW_REPOSITORIES_JSON;
  const rawRegistry = suppliedRegistry ?? (existsSync(existingRegistryPath)
    ? readFileSync(existingRegistryPath, "utf8")
    : JSON.stringify([{ id: "reviews", path: reviewsDirectory }]));
  const repositories = canonicalizeRepositoryRegistry(rawRegistry);

  const worktreeStatus = execFileSync("/usr/bin/git", ["status", "--porcelain"], {
    cwd: projectRoot,
    encoding: "utf8"
  });
  if (worktreeStatus.trim()) throw new Error("Refusing to install local production from a dirty Git worktree");

  console.log("Verifying and building source release");
  execFileSync(process.execPath, ["--run", "verify"], { cwd: projectRoot, stdio: "inherit" });

  const gitRevision = execFileSync("/usr/bin/git", ["rev-parse", "--short=12", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf8"
  }).trim();
  const timestamp = new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const releaseName = `${timestamp}-${gitRevision}`;
  const staging = join(base, "releases", `.staging-${releaseName}`);
  const release = join(base, "releases", releaseName);
  rmSync(staging, { recursive: true, force: true });
  makePrivateDirectory(staging);

  try {
    for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
      copyFileSync(join(projectRoot, file), join(staging, file));
    }
    cpSync(join(projectRoot, "dist"), join(staging, "dist"), { recursive: true });
    const runtime = join(staging, "runtime");
    makePrivateDirectory(runtime);
    copyFileSync(process.execPath, join(runtime, "node"));
    chmodSync(join(runtime, "node"), 0o755);
    const pnpm = commandPath("pnpm");
    execFileSync("/usr/bin/arch", [
      `-${darwinArchitecture(process.arch)}`, pnpm, "install", "--prod", "--frozen-lockfile"
    ], { cwd: staging, stdio: "inherit" });
    const sourceSqlite = realpathSync(join(projectRoot, "node_modules", "better-sqlite3"));
    const releaseSqlite = realpathSync(join(staging, "node_modules", "better-sqlite3"));
    copyFileSync(
      join(sourceSqlite, "build", "Release", "better_sqlite3.node"),
      join(releaseSqlite, "build", "Release", "better_sqlite3.node")
    );
    execFileSync(join(runtime, "node"), ["-e", "require('better-sqlite3')"], { cwd: staging, stdio: "ignore" });
    const releaseBin = join(staging, "bin");
    const releaseConfig = join(staging, "config");
    makePrivateDirectory(releaseBin);
    makePrivateDirectory(releaseConfig);
    copyFileSync(join(scriptDirectory, "local-production", "launcher.sh"), join(releaseBin, "launcher.sh"));
    copyFileSync(join(scriptDirectory, "local-production", "gatewayctl.sh"), join(releaseBin, "gatewayctl"));
    chmodSync(join(releaseBin, "launcher.sh"), 0o700);
    chmodSync(join(releaseBin, "gatewayctl"), 0o700);
    writePrivate(join(releaseConfig, "repositories.json"), `${JSON.stringify(repositories, null, 2)}\n`);
    writePrivate(join(releaseConfig, "codex-command"), `${codexCommand}\n`);
    writePrivate(join(releaseConfig, "codex-home"), `${codexHome}\n`);
    writePrivate(join(staging, ".pending-activation"), "");
    renameSync(staging, release);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  ensureSecrets(account);
  if (previousTarget) snapshotLegacyReleaseAssets(base, previousTarget);
  const launcher = join(base, "bin", "launcher.sh");
  const gatewayctl = join(base, "bin", "gatewayctl");
  replaceSymlink(launcher, "../current/bin/launcher.sh");
  replaceSymlink(gatewayctl, "../current/bin/gatewayctl");

  const launchAgents = join(home, "Library", "LaunchAgents");
  mkdirSync(launchAgents, { recursive: true });
  const plist = join(launchAgents, `${LAUNCH_AGENT_LABEL}.plist`);

  const domain = `gui/${process.getuid?.() ?? 0}`;
  await activateRelease(join("releases", releaseName), previousTarget, {
    activate: (target) => activateTarget(base, target),
    writePlist: () => writePrivate(plist, renderLaunchAgent({
      launcherPath: launcher,
      home,
      user: account,
      stdoutPath: join(base, "logs", "gateway.log"),
      stderrPath: join(base, "logs", "gateway.error.log")
    })),
    bootout: () => { spawnSync("/bin/launchctl", ["bootout", domain, plist], { stdio: "ignore" }); },
    waitForPortAvailable: waitUntilGatewayPortAvailable,
    bootstrap: () => execFileSync("/bin/launchctl", ["bootstrap", domain, plist], { stdio: "inherit" }),
    kickstart: () => execFileSync("/bin/launchctl", ["kickstart", "-k", `${domain}/${LAUNCH_AGENT_LABEL}`], { stdio: "inherit" }),
    waitUntilReady,
    markActive: () => rmSync(join(release, ".pending-activation")),
    removeCandidate: () => quarantineFailedRelease(
      release,
      join(base, "releases", `.failed-${releaseName}`)
    ),
    removeCurrent: () => rmSync(join(base, "current"), { force: true }),
    removePlist: () => rmSync(plist, { force: true })
  });

  console.log(`Installed release: ${releaseName}`);
  console.log(`Control command: ${gatewayctl}`);
  console.log("Gateway ready at http://127.0.0.1:8787");
}

const entrypoint = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (entrypoint === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command !== "install") {
    console.error("usage: pnpm local:install -- [--repositories-json JSON] [--codex-home PATH]");
    process.exitCode = 2;
  } else {
    install().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
