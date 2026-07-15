#!/usr/bin/env node
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });

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
  if (message.method === "initialized") return;
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake" } });
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
