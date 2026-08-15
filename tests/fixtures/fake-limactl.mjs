#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = process.env.LIMA_HOME;
if (!root) {
  process.stderr.write("LIMA_HOME is required\n");
  process.exit(2);
}

appendFileSync(join(root, "commands.log"), `${JSON.stringify(process.argv.slice(2))}\n`);

function readControl(name, fallback) {
  const path = join(root, name);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : fallback;
}

const [command, ...rest] = process.argv.slice(2);

if (command === "list") {
  const status = readControl("status", "Running");
  const format = readControl("list-format", "jsonl");
  const instance = readControl("instance", "codexgw");
  if (status === "Missing") {
    process.stdout.write(format === "array" ? "[]\n" : "");
    process.exit(0);
  }
  const row = { name: instance, status };
  process.stdout.write(format === "array" ? `${JSON.stringify([row])}\n` : `${JSON.stringify(row)}\n`);
  process.exit(0);
}

if (command === "start") {
  writeFileSync(join(root, "started"), rest.join(" "));
  process.exit(0);
}

if (command !== "shell") {
  process.stderr.write(`unsupported command: ${command ?? ""}\n`);
  process.exit(1);
}

const dash = rest.indexOf("--");
const guestArgs = dash >= 0 ? rest.slice(dash + 1) : rest.slice(1);
if (guestArgs[0] !== "sudo") {
  process.stderr.write("expected sudo\n");
  process.exit(1);
}

const action = guestArgs.slice(1);

function hostPath(guestPath) {
  if (!guestPath.startsWith("/var/lib/codexgw/")) {
    process.stderr.write("unexpected guest path\n");
    process.exit(1);
  }
  return join(root, "guest", guestPath);
}

if (action[0] === "mkdir" && action[1] === "-p" && action[2]) {
  mkdirSync(hostPath(action[2]), { recursive: true });
  process.exit(0);
}

if (action[0] === "tar" && action[1] === "-C" && action[3] === "-xf" && action[4] === "-") {
  const dest = hostPath(action[2]);
  mkdirSync(dest, { recursive: true });
  const extracted = spawnSync("tar", ["-C", dest, "-xf", "-"], { stdio: ["inherit", "ignore", "inherit"] });
  process.exit(extracted.status ?? 1);
}

if (action[0] === "chown") {
  writeFileSync(join(root, "chown"), action.join(" "));
  process.exit(0);
}

if (action[0] === "chmod") {
  appendFileSync(join(root, "chmod"), `${action.join(" ")}\n`);
  process.exit(0);
}

if (action[0] === "rm" && action[1] === "-rf" && action[2]) {
  rmSync(hostPath(action[2]), { recursive: true, force: true });
  process.exit(0);
}

process.stderr.write(`unsupported guest command: ${action.join(" ")}\n`);
process.exit(1);
