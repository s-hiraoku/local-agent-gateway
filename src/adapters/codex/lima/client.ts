import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { GatewayError } from "../../../domain/errors.js";
import {
  DEFAULT_LIMA_INSTANCE,
  GUEST_SNAPSHOT_ROOT,
  GUEST_SUPERVISOR,
  GUEST_CODEX_HOME
} from "./constants.js";

export type LimaClientConfig = {
  limactl: string;
  instance: string;
  guestCodexCommand: string;
};

export type LimaLaunch = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

export function buildLimaHostEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { NO_COLOR: "1", TERM: "dumb" };
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "LIMA_HOME"] as const) {
    const value = source[key];
    if (value) result[key] = value;
  }
  return result;
}

export class LimaClient {
  constructor(private readonly config: LimaClientConfig) {}

  launchAppServer(): LimaLaunch {
    return {
      command: this.config.limactl,
      args: [
        "shell", this.config.instance, "--",
        "sudo", "-u", GUEST_SUPERVISOR, "-H", "--",
        "env", `CODEX_HOME=${GUEST_CODEX_HOME}`, "NO_COLOR=1", "TERM=dumb",
        this.config.guestCodexCommand, "app-server"
      ],
      env: buildLimaHostEnvironment(process.env)
    };
  }

  async ensureRunning(): Promise<void> {
    const status = await this.instanceStatus();
    if (status === "Running") return;
    if (status === "Stopped") {
      await this.exec([this.config.limactl, "start", this.config.instance], 60_000);
      return;
    }
    throw new GatewayError(
      "CODEX_NOT_CONFIGURED",
      "The Lima Codex instance is not running",
      503,
      false
    );
  }

  async copySnapshot(hostPath: string): Promise<{ guestPath: string; cleanup: () => Promise<void> }> {
    const guestPath = `${GUEST_SNAPSHOT_ROOT}/${randomUUID()}`;
    const cleanup = async () => {
      await this.exec([
        this.config.limactl, "shell", this.config.instance, "--",
        "sudo", "rm", "-rf", guestPath
      ], 30_000).catch(() => undefined);
    };
    try {
      await this.exec([
        this.config.limactl, "shell", this.config.instance, "--",
        "sudo", "mkdir", "-p", guestPath
      ], 30_000);
      await this.pipeTar(hostPath, guestPath);
      await this.exec([
        this.config.limactl, "shell", this.config.instance, "--",
        "sudo", "chown", "-R", `root:${GUEST_SUPERVISOR}`, guestPath
      ], 30_000);
      await this.exec([
        this.config.limactl, "shell", this.config.instance, "--",
        "sudo", "chmod", "-R", "a+rX,a-w", guestPath
      ], 30_000);
    } catch (error) {
      await cleanup();
      throw error;
    }
    return { guestPath, cleanup };
  }

  private async instanceStatus(): Promise<string | undefined> {
    const stdout = await this.exec([this.config.limactl, "list", "--json"], 10_000);
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { name?: string; status?: string };
        if (row.name === this.config.instance) return row.status;
      } catch {
        // limactl --json may emit a single array instead of JSONL
      }
    }
    try {
      const parsed = JSON.parse(stdout) as Array<{ name?: string; status?: string }>;
      return parsed.find((row) => row.name === this.config.instance)?.status;
    } catch {
      return undefined;
    }
  }

  private pipeTar(hostPath: string, guestPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const tar = spawn("tar", ["-C", hostPath, "-cf", "-", "."], {
        env: buildLimaHostEnvironment(process.env),
        stdio: ["ignore", "pipe", "pipe"]
      });
      const lima = spawn(this.config.limactl, [
        "shell", this.config.instance, "--",
        "sudo", "tar", "-C", guestPath, "-xf", "-"
      ], {
        env: buildLimaHostEnvironment(process.env),
        stdio: ["pipe", "ignore", "pipe"]
      });
      tar.stdout?.pipe(lima.stdin!);
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      lima.on("error", () => finish(new GatewayError("CODEX_NOT_CONFIGURED", "The Lima Codex instance is not running", 503, false)));
      tar.on("error", () => finish(new GatewayError("CODEX_EXECUTION_FAILED", "Codex could not copy the repository snapshot", 502, true)));
      lima.on("close", (code) => {
        if (code === 0) finish();
        else finish(new GatewayError("CODEX_EXECUTION_FAILED", "Codex could not copy the repository snapshot", 502, true));
      });
    });
  }

  private exec(argv: string[], timeoutMs: number): Promise<string> {
    const [command, ...args] = argv;
    if (!command) {
      return Promise.reject(new GatewayError("CODEX_NOT_CONFIGURED", "The Lima Codex instance is not running", 503, false));
    }
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        env: buildLimaHostEnvironment(process.env),
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stdoutBytes = 0;
      let settled = false;
      const timer = setTimeout(() => finish(() => {
        child.kill("SIGKILL");
        reject(new GatewayError("CODEX_NOT_CONFIGURED", "The Lima Codex instance is not running", 503, false));
      }), timeoutMs);
      timer.unref();
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > 64 * 1024) return;
        stdout += chunk.toString();
      });
      child.on("error", (error) => finish(() => {
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        reject(new GatewayError(
          "CODEX_NOT_CONFIGURED",
          missing ? "The Lima Codex instance is not running" : "Codex could not complete the coding turn",
          503,
          false
        ));
      }));
      child.on("close", (code) => finish(() => {
        if (code === 0) resolve(stdout);
        else reject(new GatewayError("CODEX_NOT_CONFIGURED", "The Lima Codex instance is not running", 503, false));
      }));
    });
  }
}

export function defaultLimaClient(overrides: Partial<LimaClientConfig> = {}): LimaClient {
  return new LimaClient({
    limactl: "limactl",
    instance: DEFAULT_LIMA_INSTANCE,
    guestCodexCommand: "codex",
    ...overrides
  });
}
