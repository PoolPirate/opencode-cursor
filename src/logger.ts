import type { PluginInput } from "@opencode-ai/plugin";

type LogLevel = "debug" | "info" | "warn" | "error";

const PLUGIN_LOG_SERVICE = "opencode-cursor-oauth";
const MAX_STRING_LENGTH = 1_500;
const MAX_ARRAY_LENGTH = 20;
const MAX_OBJECT_KEYS = 25;

let currentLogger:
  | {
      client: PluginInput["client"];
      directory: string;
    }
  | undefined;
let pendingLogWrites: Promise<void> = Promise.resolve();

export function configurePluginLogger(input: PluginInput): void {
  currentLogger = {
    client: input.client,
    directory: input.directory,
  };
}

export function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack,
      errorCause: serializeValue(error.cause, 1),
    };
  }

  return {
    errorType: typeof error,
    errorValue: serializeValue(error, 1),
  };
}

export function logPluginWarn(
  message: string,
  extra: Record<string, unknown> = {},
): void {
  logPlugin("warn", message, extra);
}

export function logPluginInfo(
  message: string,
  extra: Record<string, unknown> = {},
): void {
  logPlugin("info", message, extra);
}

export function logPluginError(
  message: string,
  extra: Record<string, unknown> = {},
): void {
  logPlugin("error", message, extra);
}

export function flushPluginLogs(): Promise<void> {
  return pendingLogWrites;
}

function logPlugin(
  level: LogLevel,
  message: string,
  extra: Record<string, unknown>,
): void {
  const serializedExtra = serializeValue(extra, 0) as Record<string, unknown>;

  writeConsoleLog(level, message, serializedExtra);

  if (!currentLogger?.client?.app?.log) {
    return;
  }

  pendingLogWrites = pendingLogWrites
    .catch(() => {})
    .then(async () => {
      try {
        await currentLogger?.client.app.log({
          query: { directory: currentLogger.directory },
          body: {
            service: PLUGIN_LOG_SERVICE,
            level,
            message,
            extra: serializedExtra,
          },
        });
      } catch (logError) {
        writeConsoleLog("warn", "Failed to forward plugin log to OpenCode", {
          originalLevel: level,
          originalMessage: message,
          ...errorDetails(logError),
        });
      }
    });
}

function writeConsoleLog(
  level: LogLevel,
  message: string,
  extra: Record<string, unknown>,
): void {
  const prefix = `[${PLUGIN_LOG_SERVICE}] ${message}`;
  const suffix =
    Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : "";

  if (level === "error") {
    console.error(`${prefix}${suffix}`);
    return;
  }

  console.warn(`${prefix}${suffix}`);
}

function serializeValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") return truncateString(value);
  const valueType = typeof value;
  if (valueType === "number" || valueType === "boolean") return value;
  if (valueType === "bigint") return value.toString();
  if (valueType === "symbol") return String(value);
  if (valueType === "function")
    return `[function ${(value as Function).name || "anonymous"}]`;

  if (value instanceof URL) return value.toString();
  if (value instanceof Headers) return Object.fromEntries(value.entries());
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: truncateString(value.stack),
      cause: serializeValue(value.cause, depth + 1, seen),
    };
  }
  if (value instanceof Uint8Array) {
    return serializeBinary(value);
  }
  if (Array.isArray(value)) {
    if (depth >= 3) return `[array(${value.length})]`;
    return value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((entry) => serializeValue(entry, depth + 1, seen));
  }

  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);

    if (depth >= 3) {
      return `[object ${value.constructor?.name || "Object"}]`;
    }

    const entries = Object.entries(value as Record<string, unknown>).slice(
      0,
      MAX_OBJECT_KEYS,
    );
    return Object.fromEntries(
      entries.map(([key, entry]) => [
        key,
        serializeValue(entry, depth + 1, seen),
      ]),
    );
  }

  return String(value);
}

function serializeBinary(value: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder().decode(value);
  const printable = /^[\x09\x0a\x0d\x20-\x7e]*$/.test(text);

  if (printable) {
    return {
      type: "uint8array",
      length: value.length,
      text: truncateString(text),
    };
  }

  return {
    type: "uint8array",
    length: value.length,
    base64: truncateString(Buffer.from(value).toString("base64")),
  };
}

function truncateString(value?: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= MAX_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_STRING_LENGTH - 3)}...`;
}
