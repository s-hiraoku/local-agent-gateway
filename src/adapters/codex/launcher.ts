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
  prepareWorkspace(hostRepositoryPath: string): Promise<PreparedWorkspace>;
  launch(): AppServerLaunch;
};

export function hostAppServerLauncher(command: string, codexHome: string): AppServerLauncher {
  return {
    async ensureReady() { /* host process is created per probe */ },
    async prepareWorkspace(hostRepositoryPath) {
      return { cwd: hostRepositoryPath, extraRedactPaths: [], cleanup: async () => undefined };
    },
    launch() {
      return { command, args: ["app-server"], env: buildCodexEnvironment(process.env, codexHome) };
    }
  };
}

export function limaAppServerLauncher(client: LimaClient): AppServerLauncher {
  return {
    ensureReady: () => client.ensureRunning(),
    async prepareWorkspace(hostRepositoryPath) {
      const snapshot = await client.copySnapshot(hostRepositoryPath);
      return {
        cwd: snapshot.guestPath,
        extraRedactPaths: [snapshot.guestPath],
        cleanup: snapshot.cleanup
      };
    },
    launch: () => client.launchAppServer()
  };
}
