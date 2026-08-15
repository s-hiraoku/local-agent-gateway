import { spawn } from "node:child_process";
import { GatewayError } from "../../domain/errors.js";
import { unsupportedCodexVersionError } from "./compatibility.js";
import { buildCodexEnvironment } from "./environment.js";
import type { LimaClient } from "./lima/client.js";

export type AppServerLaunch = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

export type PreparedWorkspace = {
  cwd: string;
  extraRedactPaths: string[];
  cleanup: () => Promise<void>;
};

export type AppServerLauncher = {
  ensureReady(): Promise<void>;
  prepareWorkspace(hostRepositoryPath: string, signal?: AbortSignal): Promise<PreparedWorkspace>;
  launch(): AppServerLaunch;
  readCliVersion(signal?: AbortSignal): Promise<string>;
};

export function hostAppServerLauncher(command: string, codexHome: string): AppServerLauncher {
  return {
    async ensureReady() { /* host process is created per probe */ },
    async prepareWorkspace(hostRepositoryPath) {
      return { cwd: hostRepositoryPath, extraRedactPaths: [], cleanup: async () => undefined };
    },
    launch() {
      return { command, args: ["app-server"], env: buildCodexEnvironment(process.env, codexHome) };
    },
    readCliVersion(signal) {
      return readHostCliVersion(command, codexHome, signal);
    }
  };
}

export function limaAppServerLauncher(client: LimaClient): AppServerLauncher {
  return {
    async ensureReady() {
      await client.ensureRunning();
      await client.assertToolIsolation();
    },
    async prepareWorkspace(hostRepositoryPath, signal) {
      const snapshot = await client.copySnapshot(hostRepositoryPath, signal);
      return {
        cwd: snapshot.guestPath,
        extraRedactPaths: [snapshot.guestPath],
        cleanup: snapshot.cleanup
      };
    },
    launch: () => client.launchAppServer(),
    readCliVersion: (signal) => client.readCliVersion(signal)
  };
}

function readHostCliVersion(command: string, codexHome: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const child = spawn(command, ["--version"], {
      env: buildCodexEnvironment(process.env, codexHome),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stdoutBytes = 0;
    let settled = false;
    const onAbort = () => finish(() => {
      child.kill("SIGKILL");
      reject(signal?.reason ?? new Error("Aborted"));
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => finish(() => {
      child.kill("SIGKILL");
      reject(new GatewayError("CODEX_NOT_CONFIGURED", "Codex version probe timed out", 503, false));
    }), 10_000);
    timer.unref();
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > 4096) {
        finish(() => {
          child.kill("SIGKILL");
          reject(unsupportedCodexVersionError());
        });
        return;
      }
      stdout += chunk.toString();
    });
    child.on("error", (error) => finish(() => {
      const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? "CODEX_NOT_CONFIGURED" : "CODEX_EXECUTION_FAILED";
      reject(new GatewayError(code, "Codex executable could not be started", 503, false));
    }));
    child.on("close", (exitCode) => finish(() => {
      if (exitCode === 0) resolve(stdout);
      else reject(new GatewayError("CODEX_NOT_CONFIGURED", "Codex version probe failed", 503, false));
    }));
  });
}
