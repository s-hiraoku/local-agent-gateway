#!/usr/bin/env node
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { GatewayInferenceClient, systemClock, type Clock } from "./client.js";
import { loadMcpAdapterConfig } from "./config.js";
import { dispatchMcpMessage, encodeMcpMessage, McpFrameDecoder } from "./protocol.js";

export async function runMcpStdio(options: {
  input: Readable;
  output: Writable;
  env: NodeJS.ProcessEnv;
  clock?: Clock;
}): Promise<void> {
  const config = loadMcpAdapterConfig(options.env);
  const client = new GatewayInferenceClient(config, options.clock ?? systemClock);
  const decoder = new McpFrameDecoder();
  for await (const chunk of options.input) {
    const frames = decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    for (const frame of frames) {
      if (!frame.ok) {
        await writeFrame(options.output, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" }
        });
        continue;
      }
      const response = await dispatchMcpMessage(frame.message, client);
      if (response) await writeFrame(options.output, response);
    }
  }
}

async function writeFrame(output: Writable, message: unknown): Promise<void> {
  const frame = encodeMcpMessage(message);
  if (output.write(frame)) return;
  await once(output, "drain");
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  runMcpStdio({ input: process.stdin, output: process.stdout, env: process.env }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "MCP adapter failed";
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
