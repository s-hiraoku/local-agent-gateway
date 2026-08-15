export function buildCodexEnvironment(source: NodeJS.ProcessEnv, codexHome: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    CODEX_HOME: codexHome,
    NO_COLOR: "1",
    TERM: "dumb"
  };
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL"] as const) {
    const value = source[key];
    if (value) result[key] = value;
  }
  return result;
}
