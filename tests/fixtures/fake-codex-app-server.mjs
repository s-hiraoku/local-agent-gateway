#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

function sidecar(name, fallback = "") {
  try {
    return readFileSync(join(process.env.CODEX_HOME ?? "", name), "utf8").trim();
  } catch {
    return fallback;
  }
}

if (process.argv.includes("--version")) {
  const delayMs = Number(sidecar("fake-version-delay-ms", "0"));
  const writeVersion = () => {
    process.stdout.write(`codex-cli ${sidecar("fake-version", "0.144.6")}\n`);
    process.exit(0);
  };
  if (delayMs > 0) setTimeout(writeVersion, delayMs);
  else writeVersion();
}

const lines = createInterface({ input: process.stdin });
const transcript = sidecar("fake-transcript-path");

function record(message) {
  if (!transcript || typeof message.method !== "string") return;
  appendFileSync(transcript, `${JSON.stringify({ method: message.method, params: message.params ?? null })}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function example(schema) {
  if (Array.isArray(schema?.enum) && schema.enum.length > 0) return schema.enum[0];
  if (Object.hasOwn(schema ?? {}, "const")) return schema.const;
  if (schema?.type === "object") {
    return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, child]) => [key, example(child)]));
  }
  if (schema?.type === "array") return [];
  if (schema?.type === "integer") return 0;
  if (schema?.type === "number") return 0.9;
  if (schema?.type === "boolean") return false;
  return "";
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  record(message);
  if (message.method === "initialized") return;
  if (message.method === "initialize") {
    const client = message.params?.clientInfo ?? {};
    if (client.name !== "local-agent-gateway" || message.params?.capabilities?.experimentalApi !== false) {
      send({ id: message.id, error: { code: -32602, message: "initialize contract mismatch" } });
      return;
    }
    if (sidecar("fake-initialize") === "missing-user-agent") {
      send({ id: message.id, result: { platformFamily: "unix" } });
      return;
    }
    send({
      id: message.id,
      result: {
        userAgent: `codex_cli_rs/${sidecar("fake-version", "0.144.6")}`,
        platformFamily: "unix",
        platformOs: "macos"
      }
    });
    return;
  }
  if (message.method === "account/read") {
    send({ id: message.id, result: { account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: message.params.threadId ?? "thread-fake" } } });
    return;
  }
  if (message.method === "turn/start") {
    if (!message.params.outputSchema) {
      send({ id: message.id, error: { code: -32602, message: "outputSchema missing" } });
      return;
    }
    if (message.params.input?.[0]?.text === "fail unauthorized") {
      send({ id: message.id, result: { turn: { id: "turn-fake" } } });
      send({
        method: "turn/completed",
        params: {
          threadId: message.params.threadId,
          turnId: "turn-fake",
          turn: { status: "failed", error: { codexErrorInfo: "Unauthorized" }, items: [] }
        }
      });
      return;
    }
    const output = JSON.stringify(example(message.params.outputSchema));
    send({ id: message.id, result: { turn: { id: "turn-fake" } } });
    send({
      method: "item/agentMessage/delta",
      params: { threadId: message.params.threadId, turnId: "turn-fake", delta: output }
    });
    send({
      method: "item/completed",
      params: {
        threadId: message.params.threadId,
        turnId: "turn-fake",
        completedAtMs: Date.now(),
        item: { type: "agentMessage", text: output }
      }
    });
    send({
      method: "turn/completed",
      params: {
        threadId: message.params.threadId,
        turnId: "turn-fake",
        turn: {
          status: "completed",
          items: []
        }
      }
    });
    return;
  }
  if (typeof message.id === "number") send({ id: message.id, result: {} });
});
