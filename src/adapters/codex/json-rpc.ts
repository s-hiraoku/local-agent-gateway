import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { GatewayError } from "../../domain/errors.js";

export type JsonRpcNotification = { method: string; params?: unknown };

type JsonRpcProcess = {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type NotificationWaiter = {
  resolve: (notification: JsonRpcNotification) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  signal?: AbortSignal;
  abortListener?: () => void;
};

export class CodexRpcError extends Error {
  constructor(readonly rpcCode: number | undefined, message: string, readonly data: unknown) {
    super(message);
    this.name = "CodexRpcError";
  }
}

export type JsonRpcOptions = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  requestTimeoutMs: number;
  maxBufferedNotifications?: number;
  maxBufferedNotificationBytes?: number;
  maxProtocolMessageBytes?: number;
  process?: JsonRpcProcess;
};

export class BufferedJsonRpcTransport {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notifications: JsonRpcNotification[] = [];
  private readonly notificationWaiters: NotificationWaiter[] = [];
  private readonly proc: JsonRpcProcess;
  private receiveBuffer = Buffer.alloc(0);
  private bufferedNotificationBytes = 0;
  private stderrTail = "";
  private closed = false;
  private failure: Error | undefined;

  constructor(private readonly options: JsonRpcOptions) {
    this.proc = options.process ?? spawn(options.command, options.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env,
      shell: false
    });
    this.proc.stdout.on("data", (chunk: Buffer | string) => this.handleData(chunk));
    this.proc.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-8192);
    });
    this.proc.once("error", (_error) => {
      this.failAll(new GatewayError("CODEX_NOT_CONFIGURED", "Codex App Server could not be started", 503));
    });
    this.proc.once("exit", (code, signal) => {
      if (!this.closed) {
        this.failAll(new GatewayError(
          "CODEX_EXECUTION_FAILED",
          `Codex App Server exited before completion (${code ?? signal ?? "unknown"})`,
          502,
          true
        ));
      }
    });
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) {
      return Promise.reject(new GatewayError("CODEX_EXECUTION_FAILED", "Codex transport is closed", 502, true));
    }
    const id = this.nextId++;
    const message = params === undefined ? { id, method } : { id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new GatewayError("CODEX_TIMEOUT", "Codex App Server did not respond in time", 504, true));
      }, this.options.requestTimeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timeout });
      this.write(message, (error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  nextNotification(timeoutMs: number, signal?: AbortSignal): Promise<JsonRpcNotification> {
    if (this.failure) return Promise.reject(this.failure);
    const buffered = this.notifications.shift();
    if (buffered) {
      this.bufferedNotificationBytes -= notificationBytes(buffered);
      return Promise.resolve(buffered);
    }
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));

    return new Promise((resolve, reject) => {
      const waiter: NotificationWaiter = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.removeWaiter(waiter);
          reject(new GatewayError("CODEX_TIMEOUT", "Timed out waiting for a Codex event", 504, true));
        }, timeoutMs),
        ...(signal ? { signal } : {})
      };
      if (signal) {
        waiter.abortListener = () => {
          this.removeWaiter(waiter);
          reject(signal.reason ?? new Error("Aborted"));
        };
        signal.addEventListener("abort", waiter.abortListener, { once: true });
      }
      this.notificationWaiters.push(waiter);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new GatewayError("CODEX_EXECUTION_FAILED", "Codex transport closed", 502, true));
    this.proc.kill("SIGTERM");
  }

  diagnosticStderrTail(): string {
    return this.stderrTail;
  }

  private write(message: unknown, onError?: (error: Error) => void): void {
    this.proc.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error && onError) onError(error);
    });
  }

  private handleData(chunk: Buffer | string): void {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < data.byteLength && !this.failure) {
      const newline = data.indexOf(0x0a, offset);
      if (newline === -1) {
        this.appendProtocolFragment(data.subarray(offset));
        return;
      }
      this.appendProtocolFragment(data.subarray(offset, newline));
      if (this.failure) return;
      const line = this.receiveBuffer.toString("utf8").replace(/\r$/, "");
      this.receiveBuffer = Buffer.alloc(0);
      if (line) this.handleLine(line);
      offset = newline + 1;
    }
  }

  private appendProtocolFragment(fragment: Buffer): void {
    const limit = this.options.maxProtocolMessageBytes ?? 4 * 1024 * 1024;
    if (this.receiveBuffer.byteLength + fragment.byteLength > limit) {
      const error = new GatewayError("CODEX_EXECUTION_FAILED", "Codex sent an oversized protocol message", 502, false);
      this.failAll(error);
      this.proc.kill("SIGTERM");
      return;
    }
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, fragment]);
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      const error = new GatewayError("CODEX_EXECUTION_FAILED", "Codex sent an invalid protocol message", 502, false);
      this.failAll(error);
      this.proc.kill("SIGTERM");
      return;
    }
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;

    if (typeof record.id === "number" && this.pending.has(record.id)) {
      const pending = this.pending.get(record.id);
      if (!pending) return;
      this.pending.delete(record.id);
      clearTimeout(pending.timeout);
      if (record.error && typeof record.error === "object") {
        const error = record.error as Record<string, unknown>;
        pending.reject(new CodexRpcError(
          typeof error.code === "number" ? error.code : undefined,
          typeof error.message === "string" ? error.message : "Codex request failed",
          error.data
        ));
      } else {
        pending.resolve(record.result);
      }
      return;
    }

    if (typeof record.id === "number" && typeof record.method === "string") {
      this.write({
        id: record.id,
        error: { code: -32000, message: "Gateway policy rejects interactive App Server requests" }
      });
      return;
    }

    if (typeof record.method === "string") {
      this.pushNotification({ method: record.method, ...(record.params === undefined ? {} : { params: record.params }) });
    }
  }

  private pushNotification(notification: JsonRpcNotification): void {
    const waiter = this.notificationWaiters.shift();
    if (waiter) {
      clearTimeout(waiter.timeout);
      if (waiter.signal && waiter.abortListener) waiter.signal.removeEventListener("abort", waiter.abortListener);
      waiter.resolve(notification);
      return;
    }
    this.notifications.push(notification);
    const limit = this.options.maxBufferedNotifications ?? 2048;
    this.bufferedNotificationBytes += notificationBytes(notification);
    const byteLimit = this.options.maxBufferedNotificationBytes ?? 8 * 1024 * 1024;
    if (this.notifications.length > limit || this.bufferedNotificationBytes > byteLimit) {
      const error = new GatewayError("CODEX_EXECUTION_FAILED", "Codex event buffer overflowed", 502, false);
      this.failAll(error);
      this.proc.kill("SIGTERM");
    }
  }

  private removeWaiter(waiter: NotificationWaiter): void {
    const index = this.notificationWaiters.indexOf(waiter);
    if (index >= 0) this.notificationWaiters.splice(index, 1);
    clearTimeout(waiter.timeout);
    if (waiter.signal && waiter.abortListener) waiter.signal.removeEventListener("abort", waiter.abortListener);
  }

  private failAll(error: Error): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.notificationWaiters.splice(0)) {
      clearTimeout(waiter.timeout);
      if (waiter.signal && waiter.abortListener) waiter.signal.removeEventListener("abort", waiter.abortListener);
      waiter.reject(error);
    }
    this.notifications.length = 0;
    this.bufferedNotificationBytes = 0;
    this.receiveBuffer = Buffer.alloc(0);
  }
}

function notificationBytes(notification: JsonRpcNotification): number {
  return Buffer.byteLength(JSON.stringify(notification));
}
