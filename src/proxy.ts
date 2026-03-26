/**
 * Local OpenAI-compatible proxy that translates requests to Cursor's gRPC protocol.
 *
 * Accepts POST /v1/chat/completions in OpenAI format, translates to Cursor's
 * protobuf/Connect protocol, and streams back OpenAI-format SSE.
 *
 * Tool calling uses Cursor's native MCP tool protocol:
 * - OpenAI tool defs → McpToolDefinition in RequestContext
 * - Cursor toolCallStarted/Delta/Completed → OpenAI tool_calls SSE chunks
 * - mcpArgs exec → pause stream, return tool_calls to caller
 * - Follow-up request with tool results → resume bridge with mcpResult
 *
 * Cursor agent streaming runs via RunSSE + BidiAppend, avoiding any Node sidecar.
 */
import { create, fromBinary, fromJson, type JsonValue, toBinary, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import {
  AgentClientMessageSchema,
  AgentRunRequestSchema,
  AgentServerMessageSchema,
  BidiRequestIdSchema,
  ClientHeartbeatSchema,
  ConversationActionSchema,
  ConversationStateStructureSchema,
  ConversationStepSchema,
  AgentConversationTurnStructureSchema,
  ConversationTurnStructureSchema,
  AssistantMessageSchema,
  BackgroundShellSpawnResultSchema,
  DeleteResultSchema,
  DeleteRejectedSchema,
  DiagnosticsResultSchema,
  ExecClientMessageSchema,
  FetchErrorSchema,
  FetchResultSchema,
  GetBlobResultSchema,
  GrepErrorSchema,
  GrepResultSchema,
  KvClientMessageSchema,
  LsRejectedSchema,
  LsResultSchema,
  McpErrorSchema,
  McpResultSchema,
  McpSuccessSchema,
  McpTextContentSchema,
  McpToolDefinitionSchema,
  McpToolResultContentItemSchema,
  ModelDetailsSchema,
  NameAgentRequestSchema,
  NameAgentResponseSchema,
  ReadRejectedSchema,
  ReadResultSchema,
  RequestContextResultSchema,
  RequestContextSchema,
  RequestContextSuccessSchema,
  SetBlobResultSchema,
  ShellRejectedSchema,
  ShellResultSchema,
  UserMessageActionSchema,
  UserMessageSchema,
  WriteRejectedSchema,
  WriteResultSchema,
  WriteShellStdinErrorSchema,
  WriteShellStdinResultSchema,
  type AgentServerMessage,
  type ConversationStateStructure,
  type ExecServerMessage,
  type KvServerMessage,
  type McpToolDefinition,
} from "./proto/agent_pb";
import { createHash } from "node:crypto";
import { connect as connectHttp2, type ClientHttp2Session, type ClientHttp2Stream, type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http2";
import { errorDetails, logPluginError, logPluginWarn } from "./logger";

const CURSOR_API_URL = process.env.CURSOR_API_URL ?? "https://api2.cursor.sh";
const CURSOR_CLIENT_VERSION = "cli-2026.01.09-231024f";
const CURSOR_CONNECT_PROTOCOL_VERSION = "1";
const CONNECT_END_STREAM_FLAG = 0b00000010;
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** A single element in an OpenAI multi-part content array. */
interface ContentPart {
  type: string;
  text?: string;
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | ContentPart[];
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface ChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  tools?: OpenAIToolDef[];
  tool_choice?: unknown;
}

interface ChatRequestContext {
  sessionId?: string;
  agentKey?: string;
}


interface CursorRequestPayload {
  requestBytes: Uint8Array;
  blobStore: Map<string, Uint8Array>;
  mcpTools: McpToolDefinition[];
}

/** A pending tool execution waiting for results from the caller. */
interface PendingExec {
  execId: string;
  execMsgId: number;
  toolCallId: string;
  toolName: string;
  /** Decoded arguments JSON string for SSE tool_calls emission. */
  decodedArgs: string;
}

/** A live Cursor session kept alive across requests for tool result continuation. */
interface ActiveBridge {
  bridge: CursorSession;
  heartbeatTimer: NodeJS.Timeout;
  blobStore: Map<string, Uint8Array>;
  mcpTools: McpToolDefinition[];
  pendingExecs: PendingExec[];
  modelId: string;
  metadata: ConversationRequestMetadata;
}

// Active bridges keyed by a session token (derived from conversation state).
// When tool_calls are returned, the bridge stays alive. The next request
// with tool results looks up the bridge and sends mcpResult messages.
const activeBridges = new Map<string, ActiveBridge>();

interface StoredConversation {
  conversationId: string;
  checkpoint: Uint8Array | null;
  blobStore: Map<string, Uint8Array>;
  lastAccessMs: number;
  systemPromptHash: string;
  completedTurnsFingerprint: string;
}

const conversationStates = new Map<string, StoredConversation>();
const CONVERSATION_TTL_MS = 30 * 60 * 1000; // 30 minutes

function evictStaleConversations(): void {
  const now = Date.now();
  for (const [key, stored] of conversationStates) {
    if (now - stored.lastAccessMs > CONVERSATION_TTL_MS) {
      conversationStates.delete(key);
    }
  }
}

function normalizeAgentKey(agentKey?: string): string {
  const trimmed = agentKey?.trim();
  return trimmed ? trimmed : "default";
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createStoredConversation(): StoredConversation {
  return {
    conversationId: crypto.randomUUID(),
    checkpoint: null,
    blobStore: new Map(),
    lastAccessMs: Date.now(),
    systemPromptHash: "",
    completedTurnsFingerprint: "",
  };
}

function resetStoredConversation(stored: StoredConversation): void {
  stored.conversationId = crypto.randomUUID();
  stored.checkpoint = null;
  stored.blobStore = new Map();
  stored.lastAccessMs = Date.now();
  stored.systemPromptHash = "";
  stored.completedTurnsFingerprint = "";
}

/** Connect protocol frame: [1-byte flags][4-byte BE length][payload] */
function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
  const frame = Buffer.alloc(5 + data.length);
  frame[0] = flags;
  frame.writeUInt32BE(data.length, 1);
  frame.set(data, 5);
  return frame;
}

function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | null {
  if (payload.length < 5) return null;

  let offset = 0;
  while (offset + 5 <= payload.length) {
    const flags = payload[offset]!;
    const view = new DataView(
      payload.buffer,
      payload.byteOffset + offset,
      payload.byteLength - offset,
    );
    const messageLength = view.getUint32(1, false);
    const frameEnd = offset + 5 + messageLength;
    if (frameEnd > payload.length) return null;
    if ((flags & 0b0000_0001) !== 0) return null;
    if ((flags & CONNECT_END_STREAM_FLAG) === 0) {
      return payload.subarray(offset + 5, frameEnd);
    }
    offset = frameEnd;
  }

  return null;
}

interface CursorBaseRequestOptions {
  accessToken: string;
  url?: string;
}

function buildCursorHeaders(
  options: CursorBaseRequestOptions,
  contentType: string,
  extra: Record<string, string> = {},
): Headers {
  const headers = new Headers(buildCursorHeaderValues(options, contentType, extra));

  return headers;
}

function buildCursorHeaderValues(
  options: CursorBaseRequestOptions,
  contentType: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    authorization: `Bearer ${options.accessToken}`,
    "content-type": contentType,
    "x-ghost-mode": "true",
    "x-cursor-client-version": CURSOR_CLIENT_VERSION,
    "x-cursor-client-type": "cli",
    "x-request-id": crypto.randomUUID(),
    ...extra,
  };
}

function encodeVarint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Unsupported varint value: ${value}`);
  }

  const bytes: number[] = [];
  let current = value;
  while (current >= 0x80) {
    bytes.push((current & 0x7f) | 0x80);
    current = Math.floor(current / 128);
  }
  bytes.push(current);
  return Uint8Array.from(bytes);
}

function encodeProtoField(tag: number, wireType: number, value: Uint8Array): Uint8Array {
  const key = encodeVarint((tag << 3) | wireType);
  const out = new Uint8Array(key.length + value.length);
  out.set(key, 0);
  out.set(value, key.length);
  return out;
}

function encodeProtoStringField(tag: number, value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  const len = encodeVarint(bytes.length);
  const payload = new Uint8Array(len.length + bytes.length);
  payload.set(len, 0);
  payload.set(bytes, len.length);
  return encodeProtoField(tag, 2, payload);
}

function encodeProtoMessageField(tag: number, value: Uint8Array): Uint8Array {
  const len = encodeVarint(value.length);
  const payload = new Uint8Array(len.length + value.length);
  payload.set(len, 0);
  payload.set(value, len.length);
  return encodeProtoField(tag, 2, payload);
}

function encodeProtoVarintField(tag: number, value: number): Uint8Array {
  return encodeProtoField(tag, 0, encodeVarint(value));
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function toFetchBody(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

function encodeBidiAppendRequest(
  dataHex: string,
  requestId: string,
  appendSeqno: number,
): Uint8Array {
  const requestIdBytes = toBinary(
    BidiRequestIdSchema,
    create(BidiRequestIdSchema, { requestId }),
  );
  return concatBytes([
    encodeProtoStringField(1, dataHex),
    encodeProtoMessageField(2, requestIdBytes),
    encodeProtoVarintField(3, appendSeqno),
  ]);
}

interface CursorSession {
  write: (data: Uint8Array) => void;
  end: () => void;
  onData: (cb: (chunk: Buffer) => void) => void;
  onClose: (cb: (code: number) => void) => void;
  readonly alive: boolean;
}

interface CreateCursorSessionOptions extends CursorBaseRequestOptions {
  requestId: string;
}

async function createCursorSession(
  options: CreateCursorSessionOptions,
): Promise<CursorSession> {
  const response = await fetch(
    new URL("/agent.v1.AgentService/RunSSE", options.url ?? CURSOR_API_URL),
    {
      method: "POST",
      headers: buildCursorHeaders(options, "application/connect+proto", {
        accept: "text/event-stream",
        "connect-protocol-version": "1",
      }),
      body: toFetchBody(frameConnectMessage(
        toBinary(
          BidiRequestIdSchema,
          create(BidiRequestIdSchema, { requestId: options.requestId }),
        ),
      )),
    },
  );

  if (!response.ok || !response.body) {
    const errorBody = await response.text().catch(() => "");
    logPluginError("Cursor RunSSE request failed", {
      requestId: options.requestId,
      status: response.status,
      responseBody: errorBody,
    });
    throw new Error(
      `RunSSE failed: ${response.status}${errorBody ? ` ${errorBody}` : ""}`,
    );
  }

  const cbs = {
    data: null as ((chunk: Buffer) => void) | null,
    close: null as ((code: number) => void) | null,
  };
  const abortController = new AbortController();
  const reader = response.body.getReader();
  let appendSeqno = 0;
  let alive = true;
  let closeCode = 0;
  let writeChain = Promise.resolve();
  const pendingChunks: Buffer[] = [];

  const finish = (code: number) => {
    if (!alive) return;
    alive = false;
    closeCode = code;
    cbs.close?.(code);
  };

  const append = async (data: Uint8Array) => {
    const requestBody = encodeBidiAppendRequest(
      Buffer.from(data).toString("hex"),
      options.requestId,
      appendSeqno++,
    );
    const appendResponse = await fetch(
      new URL("/aiserver.v1.BidiService/BidiAppend", options.url ?? CURSOR_API_URL),
      {
        method: "POST",
        headers: buildCursorHeaders(options, "application/proto"),
        body: toFetchBody(requestBody),
        signal: abortController.signal,
      },
    );

    if (!appendResponse.ok) {
      const errorBody = await appendResponse.text().catch(() => "");
      logPluginError("Cursor BidiAppend request failed", {
        requestId: options.requestId,
        appendSeqno: appendSeqno - 1,
        status: appendResponse.status,
        responseBody: errorBody,
      });
      throw new Error(
        `BidiAppend failed: ${appendResponse.status}${errorBody ? ` ${errorBody}` : ""}`,
      );
    }

    await appendResponse.arrayBuffer().catch(() => undefined);
  };

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          finish(0);
          break;
        }
        if (value && value.length > 0) {
          const chunk = Buffer.from(value);
          if (cbs.data) {
            cbs.data(chunk);
          } else {
            pendingChunks.push(chunk);
          }
        }
      }
    } catch (error) {
      logPluginWarn("Cursor stream reader closed with error", {
        requestId: options.requestId,
        ...errorDetails(error),
      });
      finish(alive ? 1 : closeCode);
    }
  })();

  return {
    get alive() {
      return alive;
    },
    write(data) {
      if (!alive) return;
      writeChain = writeChain
        .then(() => append(data))
        .catch((error) => {
          logPluginError("Cursor stream append failed", {
            requestId: options.requestId,
            ...errorDetails(error),
          });
          try {
            abortController.abort();
          } catch { }
          try {
            reader.cancel();
          } catch { }
          finish(1);
        });
    },
    end() {
      try {
        abortController.abort();
      } catch { }
      try {
        reader.cancel();
      } catch { }
      finish(0);
    },
    onData(cb) {
      cbs.data = cb;
      while (pendingChunks.length > 0) {
        cb(pendingChunks.shift()!);
      }
    },
    onClose(cb) {
      if (!alive) {
        queueMicrotask(() => cb(closeCode));
      } else {
        cbs.close = cb;
      }
    },
  };
}

interface CursorUnaryRpcOptions {
  accessToken: string;
  rpcPath: string;
  requestBody: Uint8Array;
  url?: string;
  timeoutMs?: number;
  transport?: "auto" | "fetch" | "http2";
}

export async function callCursorUnaryRpc(
  options: CursorUnaryRpcOptions,
): Promise<{ body: Uint8Array; exitCode: number; timedOut: boolean }> {
  const target = new URL(options.rpcPath, options.url ?? CURSOR_API_URL);
  const transport = options.transport ?? "auto";

  if (transport === "http2" || (transport === "auto" && target.protocol === "https:")) {
    const http2Result = await callCursorUnaryRpcOverHttp2(options, target);
    if (transport === "http2" || http2Result.timedOut || http2Result.exitCode !== 1) {
      return http2Result;
    }
  }

  return callCursorUnaryRpcOverFetch(options, target);
}

async function callCursorUnaryRpcOverFetch(
  options: CursorUnaryRpcOptions,
  target: URL,
): Promise<{ body: Uint8Array; exitCode: number; timedOut: boolean }> {
  let timedOut = false;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const controller = new AbortController();
  const timeout = timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs)
    : undefined;

  try {
    const response = await fetch(target, {
      method: "POST",
      headers: buildCursorHeaders(options, "application/proto", {
        accept: "application/proto, application/json",
        "connect-protocol-version": CURSOR_CONNECT_PROTOCOL_VERSION,
        "connect-timeout-ms": String(timeoutMs),
      }),
      body: toFetchBody(options.requestBody),
      signal: controller.signal,
    });

    const body = new Uint8Array(await response.arrayBuffer());
    return {
      body,
      exitCode: response.ok ? 0 : response.status,
      timedOut,
    };
  } catch {
    logPluginError("Cursor unary fetch transport failed", {
      rpcPath: options.rpcPath,
      url: target.toString(),
      timeoutMs,
      timedOut,
    });
    return {
      body: new Uint8Array(),
      exitCode: timedOut ? 124 : 1,
      timedOut,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function callCursorUnaryRpcOverHttp2(
  options: CursorUnaryRpcOptions,
  target: URL,
): Promise<{ body: Uint8Array; exitCode: number; timedOut: boolean }> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const authority = `${target.protocol}//${target.host}`;

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let session: ClientHttp2Session | undefined;
    let stream: ClientHttp2Stream | undefined;

    const finish = (result: { body: Uint8Array; exitCode: number; timedOut: boolean }) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      try {
        stream?.close();
      } catch { }
      try {
        session?.close();
      } catch { }
      resolve(result);
    };

    const timeout = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        finish({
          body: new Uint8Array(),
          exitCode: 124,
          timedOut: true,
        });
      }, timeoutMs)
      : undefined;

    try {
      session = connectHttp2(authority);
      session.once("error", (error) => {
        logPluginError("Cursor unary HTTP/2 session failed", {
          rpcPath: options.rpcPath,
          url: target.toString(),
          timedOut,
          ...errorDetails(error),
        });
        finish({
          body: new Uint8Array(),
          exitCode: timedOut ? 124 : 1,
          timedOut,
        });
      });

      const headers: OutgoingHttpHeaders = {
        ":method": "POST",
        ":path": `${target.pathname}${target.search}`,
        ...buildCursorHeaderValues(options, "application/proto", {
          accept: "application/proto, application/json",
          "connect-protocol-version": CURSOR_CONNECT_PROTOCOL_VERSION,
          "connect-timeout-ms": String(timeoutMs),
        }),
      };

      stream = session.request(headers);

      let statusCode = 0;
      const chunks: Buffer[] = [];

      stream.once("response", (responseHeaders: IncomingHttpHeaders) => {
        const statusHeader = responseHeaders[":status"];
        statusCode = typeof statusHeader === "number"
          ? statusHeader
          : Number(statusHeader ?? 0);
      });
      stream.on("data", (chunk: Buffer | Uint8Array) => {
        chunks.push(Buffer.from(chunk));
      });
      stream.once("end", () => {
        const body = new Uint8Array(Buffer.concat(chunks));
        finish({
          body,
          exitCode: statusCode >= 200 && statusCode < 300 ? 0 : (statusCode || 1),
          timedOut,
        });
      });
      stream.once("error", (error) => {
        logPluginError("Cursor unary HTTP/2 stream failed", {
          rpcPath: options.rpcPath,
          url: target.toString(),
          timedOut,
          ...errorDetails(error),
        });
        finish({
          body: new Uint8Array(),
          exitCode: timedOut ? 124 : 1,
          timedOut,
        });
      });
      // Bun's node:http2 client currently breaks on end(Buffer.alloc(0)) against
      // Cursor's HTTPS endpoint, but a header-only end() succeeds for empty unary bodies.
      if (options.requestBody.length > 0) {
        stream.end(Buffer.from(options.requestBody));
      } else {
        stream.end();
      }
    } catch (error) {
      logPluginError("Cursor unary HTTP/2 setup failed", {
        rpcPath: options.rpcPath,
        url: target.toString(),
        timedOut,
        ...errorDetails(error),
      });
      finish({
        body: new Uint8Array(),
        exitCode: timedOut ? 124 : 1,
        timedOut,
      });
    }
  });
}

let proxyServer: ReturnType<typeof Bun.serve> | undefined;
let proxyPort: number | undefined;
let proxyAccessTokenProvider: (() => Promise<string>) | undefined;
let proxyModels: Array<{ id: string; name: string }> = [];

function buildOpenAIModelList(models: ReadonlyArray<{ id: string; name: string }>): Array<{
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}> {
  return models.map((model) => ({
    id: model.id,
    object: "model",
    created: 0,
    owned_by: "cursor",
  }));
}

export function getProxyPort(): number | undefined {
  return proxyPort;
}

export async function startProxy(
  getAccessToken: () => Promise<string>,
  models: ReadonlyArray<{ id: string; name: string }> = [],
): Promise<number> {
  proxyAccessTokenProvider = getAccessToken;
  proxyModels = models.map((model) => ({
    id: model.id,
    name: model.name,
  }));
  if (proxyServer && proxyPort) return proxyPort;

  proxyServer = Bun.serve({
    port: 0,
    idleTimeout: 255, // max — Cursor responses can take 30s+
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/v1/models") {
        return new Response(
          JSON.stringify({
            object: "list",
            data: buildOpenAIModelList(proxyModels),
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        try {
          const body = (await req.json()) as ChatCompletionRequest;
          if (!proxyAccessTokenProvider) {
            throw new Error("Cursor proxy access token provider not configured");
          }
          const accessToken = await proxyAccessTokenProvider();
          const sessionId = req.headers.get("x-opencode-session-id")
            ?? req.headers.get("x-session-id")
            ?? undefined;
          const agentKey = req.headers.get("x-opencode-agent") ?? undefined;
          return handleChatCompletion(body, accessToken, { sessionId, agentKey });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logPluginError("Cursor proxy request failed", {
            path: url.pathname,
            method: req.method,
            ...errorDetails(err),
          });
          return new Response(
            JSON.stringify({
              error: { message, type: "server_error", code: "internal_error" },
            }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  proxyPort = proxyServer.port;
  if (!proxyPort) throw new Error("Failed to bind proxy to a port");
  return proxyPort;
}

export function stopProxy(): void {
  if (proxyServer) {
    proxyServer.stop();
    proxyServer = undefined;
    proxyPort = undefined;
    proxyAccessTokenProvider = undefined;
    proxyModels = [];
  }
  // Clean up any lingering bridges
  for (const active of activeBridges.values()) {
    clearInterval(active.heartbeatTimer);
    active.bridge.end();
  }
  activeBridges.clear();
  conversationStates.clear();
}

function handleChatCompletion(
  body: ChatCompletionRequest,
  accessToken: string,
  context: ChatRequestContext = {},
): Response | Promise<Response> {
  const parsed = parseMessages(body.messages);
  const {
    systemPrompt,
    userText,
    turns,
    toolResults,
    pendingAssistantSummary,
    completedTurnsFingerprint,
  } = parsed;
  const modelId = body.model;
  const normalizedAgentKey = normalizeAgentKey(context.agentKey);
  const isTitleAgent = normalizedAgentKey === "title";
  if (isTitleAgent) {
    const titleSourceText = buildTitleSourceText(userText, turns, pendingAssistantSummary, toolResults);
    if (!titleSourceText) {
      return new Response(
        JSON.stringify({
          error: {
            message: "No title source text found",
            type: "invalid_request_error",
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    return handleTitleGenerationRequest(titleSourceText, accessToken, modelId, body.stream !== false);
  }

  const tools = selectToolsForChoice(body.tools ?? [], body.tool_choice);

  if (!userText && toolResults.length === 0) {
    return new Response(
      JSON.stringify({
        error: {
          message: "No user message found",
          type: "invalid_request_error",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // bridgeKey: session/agent-scoped, for active tool-call bridges
  // convKey: model-independent, for conversation state that survives model switches
  const bridgeKey = deriveBridgeKey(modelId, body.messages, context.sessionId, context.agentKey);
  const convKey = deriveConversationKey(body.messages, context.sessionId, context.agentKey);
  const activeBridge = activeBridges.get(bridgeKey);

  if (activeBridge && toolResults.length > 0) {
    activeBridges.delete(bridgeKey);

    if (activeBridge.bridge.alive) {
      if (activeBridge.modelId !== modelId) {
        logPluginWarn("Resuming pending Cursor tool call on original model after model switch", {
          requestedModelId: modelId,
          resumedModelId: activeBridge.modelId,
          convKey,
          bridgeKey,
        });
      }
      // Resume the live bridge with tool results
      return handleToolResultResume(activeBridge, toolResults, bridgeKey, convKey);
    }

    // Bridge died (timeout, server disconnect, etc.).
    // Clean up and fall through to start a fresh bridge.
    clearInterval(activeBridge.heartbeatTimer);
    activeBridge.bridge.end();
  }

  // Clean up stale bridge if present
  if (activeBridge && activeBridges.has(bridgeKey)) {
    clearInterval(activeBridge.heartbeatTimer);
    activeBridge.bridge.end();
    activeBridges.delete(bridgeKey);
  }

  let stored = conversationStates.get(convKey);
  if (!stored) {
    stored = createStoredConversation();
    conversationStates.set(convKey, stored);
  }

  const systemPromptHash = hashString(systemPrompt);
  if (
    stored.checkpoint
    && (
      stored.systemPromptHash !== systemPromptHash
      || (turns.length > 0 && stored.completedTurnsFingerprint !== completedTurnsFingerprint)
    )
  ) {
    resetStoredConversation(stored);
  }

  stored.systemPromptHash = systemPromptHash;
  stored.completedTurnsFingerprint = completedTurnsFingerprint;
  stored.lastAccessMs = Date.now();
  evictStaleConversations();

  // Build the request. When tool results are present but the bridge died,
  // we must still include the last user text so Cursor has context.
  const mcpTools = buildMcpToolDefinitions(tools);
  const needsInitialHandoff = !stored.checkpoint && (turns.length > 0 || pendingAssistantSummary || toolResults.length > 0);
  const replayTurns = needsInitialHandoff ? [] : turns;
  let effectiveUserText = needsInitialHandoff
    ? buildInitialHandoffPrompt(userText, turns, pendingAssistantSummary, toolResults)
    : toolResults.length > 0
      ? buildToolResumePrompt(userText, pendingAssistantSummary, toolResults)
      : userText;
  const payload = buildCursorRequest(
    modelId, systemPrompt, effectiveUserText, replayTurns,
    stored.conversationId, stored.checkpoint, stored.blobStore,
  );
  payload.mcpTools = mcpTools;

  if (body.stream === false) {
    return handleNonStreamingResponse(payload, accessToken, modelId, convKey, {
      systemPrompt,
      systemPromptHash,
      completedTurnsFingerprint,
      turns,
      userText,
      agentKey: normalizedAgentKey,
    });
  }
  return handleStreamingResponse(payload, accessToken, modelId, bridgeKey, convKey, {
    systemPrompt,
    systemPromptHash,
    completedTurnsFingerprint,
    turns,
    userText,
    agentKey: normalizedAgentKey,
  });
}

interface ToolResultInfo {
  toolCallId: string;
  content: string;
}

interface ParsedMessages {
  systemPrompt: string;
  userText: string;
  turns: Array<{ userText: string; assistantText: string }>;
  toolResults: ToolResultInfo[];
  pendingAssistantSummary: string;
  completedTurnsFingerprint: string;
}

/** Normalize OpenAI message content to a plain string. */
function textContent(content: OpenAIMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!)
    .join("\n");
}

interface TurnSegmentText {
  kind: "assistantText";
  text: string;
}

interface TurnSegmentToolCalls {
  kind: "assistantToolCalls";
  toolCalls: OpenAIToolCall[];
}

interface TurnSegmentToolResult {
  kind: "toolResult";
  result: ToolResultInfo;
}

type TurnSegment = TurnSegmentText | TurnSegmentToolCalls | TurnSegmentToolResult;

interface ParsedTurnState {
  userText: string;
  segments: TurnSegment[];
}

function parseMessages(messages: OpenAIMessage[]): ParsedMessages {
  let systemPrompt = "You are a helpful assistant.";

  // Collect system messages
  const systemParts = messages
    .filter((m) => m.role === "system")
    .map((m) => textContent(m.content));
  if (systemParts.length > 0) {
    systemPrompt = systemParts.join("\n");
  }

  const nonSystem = messages.filter((m) => m.role !== "system");
  const parsedTurns: ParsedTurnState[] = [];
  let currentTurn: ParsedTurnState | undefined;

  for (const msg of nonSystem) {
    if (msg.role === "user") {
      if (currentTurn) parsedTurns.push(currentTurn);
      currentTurn = {
        userText: textContent(msg.content),
        segments: [],
      };
      continue;
    }

    if (!currentTurn) {
      currentTurn = { userText: "", segments: [] };
    }

    if (msg.role === "assistant") {
      const text = textContent(msg.content);
      if (text) {
        currentTurn.segments.push({ kind: "assistantText", text });
      }
      if (msg.tool_calls?.length) {
        currentTurn.segments.push({
          kind: "assistantToolCalls",
          toolCalls: msg.tool_calls,
        });
      }
      continue;
    }

    if (msg.role === "tool") {
      currentTurn.segments.push({
        kind: "toolResult",
        result: {
          toolCallId: msg.tool_call_id ?? "",
          content: textContent(msg.content),
        },
      });
    }
  }

  if (currentTurn) parsedTurns.push(currentTurn);

  let userText = "";
  let toolResults: ToolResultInfo[] = [];
  let pendingAssistantSummary = "";
  let completedTurnStates = parsedTurns;

  const lastTurn = parsedTurns.at(-1);
  if (lastTurn) {
    const trailingSegments = splitTrailingToolResults(lastTurn.segments);
    const hasAssistantSummary = trailingSegments.base.length > 0;

    if (trailingSegments.trailing.length > 0 && hasAssistantSummary) {
      completedTurnStates = parsedTurns.slice(0, -1);
      userText = lastTurn.userText;
      toolResults = trailingSegments.trailing.map((segment) => segment.result);
      pendingAssistantSummary = summarizeTurnSegments(trailingSegments.base);
    } else if (lastTurn.userText && lastTurn.segments.length === 0) {
      completedTurnStates = parsedTurns.slice(0, -1);
      userText = lastTurn.userText;
    }
  }

  const turns = completedTurnStates
    .map((turn) => ({
      userText: turn.userText,
      assistantText: summarizeTurnSegments(turn.segments),
    }))
    .filter((turn) => turn.userText || turn.assistantText);

  return {
    systemPrompt,
    userText,
    turns,
    toolResults,
    pendingAssistantSummary,
    completedTurnsFingerprint: buildCompletedTurnsFingerprint(systemPrompt, turns),
  };
}

function splitTrailingToolResults(segments: TurnSegment[]): {
  base: TurnSegment[];
  trailing: TurnSegmentToolResult[];
} {
  let index = segments.length;
  while (index > 0 && segments[index - 1]?.kind === "toolResult") {
    index -= 1;
  }

  return {
    base: segments.slice(0, index),
    trailing: segments.slice(index).filter(
      (segment): segment is TurnSegmentToolResult => segment.kind === "toolResult",
    ),
  };
}

function summarizeTurnSegments(segments: TurnSegment[]): string {
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment.kind === "assistantText") {
      const trimmed = segment.text.trim();
      if (trimmed) parts.push(trimmed);
      continue;
    }

    if (segment.kind === "assistantToolCalls") {
      const summary = segment.toolCalls.map(formatToolCallSummary).join("\n\n");
      if (summary) parts.push(summary);
      continue;
    }

    parts.push(formatToolResultSummary(segment.result));
  }

  return parts.join("\n\n").trim();
}

function formatToolCallSummary(call: OpenAIToolCall): string {
  const args = call.function.arguments?.trim();
  return args
    ? `[assistant requested tool ${call.function.name} id=${call.id}]\n${args}`
    : `[assistant requested tool ${call.function.name} id=${call.id}]`;
}

function formatToolResultSummary(result: ToolResultInfo): string {
  const label = result.toolCallId
    ? `[tool result id=${result.toolCallId}]`
    : "[tool result]";
  const content = result.content.trim();
  return content ? `${label}\n${content}` : label;
}

function buildCompletedTurnsFingerprint(
  systemPrompt: string,
  turns: Array<{ userText: string; assistantText: string }>,
): string {
  return hashString(JSON.stringify({ systemPrompt, turns }));
}

function buildToolResumePrompt(
  userText: string,
  pendingAssistantSummary: string,
  toolResults: ToolResultInfo[],
): string {
  const parts = [userText.trim()];
  if (pendingAssistantSummary.trim()) {
    parts.push(`[previous assistant tool activity]\n${pendingAssistantSummary.trim()}`);
  }
  if (toolResults.length > 0) {
    parts.push(toolResults.map(formatToolResultSummary).join("\n\n"));
  }
  return parts.filter(Boolean).join("\n\n");
}

function buildInitialHandoffPrompt(
  userText: string,
  turns: Array<{ userText: string; assistantText: string }>,
  pendingAssistantSummary: string,
  toolResults: ToolResultInfo[],
): string {
  const transcript = turns.map((turn, index) => {
    const sections = [`Turn ${index + 1}`];
    if (turn.userText.trim()) sections.push(`User: ${turn.userText.trim()}`);
    if (turn.assistantText.trim()) sections.push(`Assistant: ${turn.assistantText.trim()}`);
    return sections.join("\n");
  });

  const inProgress = buildToolResumePrompt("", pendingAssistantSummary, toolResults).trim();
  const history = [
    ...transcript,
    ...(inProgress ? [`In-progress turn\n${inProgress}`] : []),
  ].join("\n\n").trim();

  if (!history) return userText;

  return [
    "[OpenCode session handoff]",
    "You are continuing an existing session that previously ran on another provider/model.",
    "Treat the transcript below as prior conversation history before answering the latest user message.",
    "",
    "<previous-session-transcript>",
    history,
    "</previous-session-transcript>",
    "",
    "Latest user message:",
    userText.trim(),
  ].filter(Boolean).join("\n");
}

function buildTitleSourceText(
  userText: string,
  turns: Array<{ userText: string; assistantText: string }>,
  pendingAssistantSummary: string,
  toolResults: ToolResultInfo[],
): string {
  const history = turns.map((turn) => [turn.userText.trim(), turn.assistantText.trim()].filter(Boolean).join("\n")).filter(Boolean);
  if (pendingAssistantSummary.trim()) {
    history.push(pendingAssistantSummary.trim());
  }
  if (toolResults.length > 0) {
    history.push(toolResults.map(formatToolResultSummary).join("\n\n"));
  }
  if (userText.trim()) {
    history.push(userText.trim());
  }
  return history.join("\n\n").trim();
}

function selectToolsForChoice(
  tools: OpenAIToolDef[],
  toolChoice: unknown,
): OpenAIToolDef[] {
  if (!tools.length) return [];
  if (toolChoice === undefined || toolChoice === null || toolChoice === "auto" || toolChoice === "required") {
    return tools;
  }
  if (toolChoice === "none") {
    return [];
  }

  if (typeof toolChoice === "object") {
    const choice = toolChoice as {
      type?: unknown;
      function?: { name?: unknown };
    };
    if (choice.type === "function" && typeof choice.function?.name === "string") {
      return tools.filter((tool) => tool.function.name === choice.function!.name);
    }
  }

  return tools;
}

/** Convert OpenAI tool definitions to Cursor's MCP tool protobuf format. */
function buildMcpToolDefinitions(tools: OpenAIToolDef[]): McpToolDefinition[] {
  return tools.map((t) => {
    const fn = t.function;
    const jsonSchema: JsonValue =
      fn.parameters && typeof fn.parameters === "object"
        ? (fn.parameters as JsonValue)
        : { type: "object", properties: {}, required: [] };
    const inputSchema = toBinary(ValueSchema, fromJson(ValueSchema, jsonSchema));
    return create(McpToolDefinitionSchema, {
      name: fn.name,
      description: fn.description || "",
      providerIdentifier: "opencode",
      toolName: fn.name,
      inputSchema,
    });
  });
}

/** Decode a Cursor MCP arg value (protobuf Value bytes) to a JS value. */
function decodeMcpArgValue(value: Uint8Array): unknown {
  try {
    const parsed = fromBinary(ValueSchema, value);
    return toJson(ValueSchema, parsed);
  } catch { }
  return new TextDecoder().decode(value);
}

/** Decode a map of MCP arg values. */
function decodeMcpArgsMap(args: Record<string, Uint8Array>): Record<string, unknown> {
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    decoded[key] = decodeMcpArgValue(value);
  }
  return decoded;
}

function buildCursorRequest(
  modelId: string,
  systemPrompt: string,
  userText: string,
  turns: Array<{ userText: string; assistantText: string }>,
  conversationId: string,
  checkpoint: Uint8Array | null,
  existingBlobStore?: Map<string, Uint8Array>,
): CursorRequestPayload {
  const blobStore = new Map<string, Uint8Array>(existingBlobStore ?? []);

  // System prompt → blob store (Cursor requests it back via KV handshake)
  const systemJson = JSON.stringify({ role: "system", content: systemPrompt });
  const systemBytes = new TextEncoder().encode(systemJson);
  const systemBlobId = new Uint8Array(
    createHash("sha256").update(systemBytes).digest(),
  );
  blobStore.set(Buffer.from(systemBlobId).toString("hex"), systemBytes);

  let conversationState;
  if (checkpoint) {
    conversationState = fromBinary(ConversationStateStructureSchema, checkpoint);
  } else {
    const turnBytes: Uint8Array[] = [];
    for (const turn of turns) {
      const userMsg = create(UserMessageSchema, {
        text: turn.userText,
        messageId: crypto.randomUUID(),
      });
      const userMsgBytes = toBinary(UserMessageSchema, userMsg);

      const stepBytes: Uint8Array[] = [];
      if (turn.assistantText) {
        const step = create(ConversationStepSchema, {
          message: {
            case: "assistantMessage",
            value: create(AssistantMessageSchema, { text: turn.assistantText }),
          },
        });
        stepBytes.push(toBinary(ConversationStepSchema, step));
      }

      const agentTurn = create(AgentConversationTurnStructureSchema, {
        userMessage: userMsgBytes,
        steps: stepBytes,
      });
      const turnStructure = create(ConversationTurnStructureSchema, {
        turn: { case: "agentConversationTurn", value: agentTurn },
      });
      turnBytes.push(toBinary(ConversationTurnStructureSchema, turnStructure));
    }

    conversationState = create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: [systemBlobId],
      turns: turnBytes,
      todos: [],
      pendingToolCalls: [],
      previousWorkspaceUris: [],
      fileStates: {},
      fileStatesV2: {},
      summaryArchives: [],
      turnTimings: [],
      subagentStates: {},
      selfSummaryCount: 0,
      readPaths: [],
    });
  }

  const userMessage = create(UserMessageSchema, {
    text: userText,
    messageId: crypto.randomUUID(),
  });
  const action = create(ConversationActionSchema, {
    action: {
      case: "userMessageAction",
      value: create(UserMessageActionSchema, { userMessage }),
    },
  });

  const modelDetails = create(ModelDetailsSchema, {
    modelId,
    displayModelId: modelId,
    displayName: modelId,
  });

  const runRequest = create(AgentRunRequestSchema, {
    conversationState,
    action,
    modelDetails,
    conversationId,
  });

  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "runRequest", value: runRequest },
  });

  return {
    requestBytes: toBinary(AgentClientMessageSchema, clientMessage),
    blobStore,
    mcpTools: [],
  };
}

function parseConnectEndStream(data: Uint8Array): Error | null {
  try {
    const payload = JSON.parse(new TextDecoder().decode(data));
    const error = payload?.error;
    if (error) {
      const code = error.code ?? "unknown";
      const message = error.message ?? "Unknown error";
      return new Error(`Connect error ${code}: ${message}`);
    }
    return null;
  } catch {
    return new Error("Failed to parse Connect end stream");
  }
}

function makeHeartbeatBytes(): Uint8Array {
  const heartbeat = create(AgentClientMessageSchema, {
    message: {
      case: "clientHeartbeat",
      value: create(ClientHeartbeatSchema, {}),
    },
  });
  return toBinary(AgentClientMessageSchema, heartbeat);
}

function scheduleBridgeEnd(bridge: CursorSession): void {
  queueMicrotask(() => {
    if (bridge.alive) bridge.end();
  });
}

/**
 * Create a stateful parser for Connect protocol frames.
 * Handles buffering partial data across chunks.
 */
function createConnectFrameParser(
  onMessage: (bytes: Uint8Array) => void,
  onEndStream: (bytes: Uint8Array) => void,
): (incoming: Buffer) => void {
  let pending = Buffer.alloc(0);
  return (incoming: Buffer) => {
    pending = Buffer.concat([pending, incoming]);
    while (pending.length >= 5) {
      const flags = pending[0]!;
      const msgLen = pending.readUInt32BE(1);
      if (pending.length < 5 + msgLen) break;
      const messageBytes = pending.subarray(5, 5 + msgLen);
      pending = pending.subarray(5 + msgLen);
      if (flags & CONNECT_END_STREAM_FLAG) {
        onEndStream(messageBytes);
      } else {
        onMessage(messageBytes);
      }
    }
  };
}

const THINKING_TAG_NAMES = ['think', 'thinking', 'reasoning', 'thought', 'think_intent'];
const MAX_THINKING_TAG_LEN = 16; // </think_intent> is 15 chars

/**
 * Strip thinking tags from streamed text, routing tagged content to reasoning.
 * Buffers partial tags across chunk boundaries.
 */
function createThinkingTagFilter(): {
  process(text: string): { content: string; reasoning: string };
  flush(): { content: string; reasoning: string };
} {
  let buffer = '';
  let inThinking = false;

  return {
    process(text: string) {
      const input = buffer + text;
      buffer = '';
      let content = '';
      let reasoning = '';
      let lastIdx = 0;

      const re = new RegExp(`<(/?)(?:${THINKING_TAG_NAMES.join('|')})\\s*>`, 'gi');
      let match: RegExpExecArray | null;
      while ((match = re.exec(input)) !== null) {
        const before = input.slice(lastIdx, match.index);
        if (inThinking) reasoning += before;
        else content += before;
        inThinking = match[1] !== '/';
        lastIdx = re.lastIndex;
      }

      const rest = input.slice(lastIdx);
      // Buffer a trailing '<' that could be the start of a thinking tag.
      const ltPos = rest.lastIndexOf('<');
      if (ltPos >= 0 && rest.length - ltPos < MAX_THINKING_TAG_LEN && /^<\/?[a-z_]*$/i.test(rest.slice(ltPos))) {
        buffer = rest.slice(ltPos);
        const before = rest.slice(0, ltPos);
        if (inThinking) reasoning += before;
        else content += before;
      } else {
        if (inThinking) reasoning += rest;
        else content += rest;
      }

      return { content, reasoning };
    },
    flush() {
      const b = buffer;
      buffer = '';
      if (!b) return { content: '', reasoning: '' };
      return inThinking ? { content: '', reasoning: b } : { content: b, reasoning: '' };
    },
  };
}

interface StreamState {
  toolCallIndex: number;
  pendingExecs: PendingExec[];
  outputTokens: number;
  totalTokens: number;
}

function computeUsage(state: StreamState) {
  const completion_tokens = state.outputTokens;
  const total_tokens = state.totalTokens || completion_tokens;
  const prompt_tokens = Math.max(0, total_tokens - completion_tokens);
  return { prompt_tokens, completion_tokens, total_tokens };
}

function processServerMessage(
  msg: AgentServerMessage,
  blobStore: Map<string, Uint8Array>,
  mcpTools: McpToolDefinition[],
  sendFrame: (data: Uint8Array) => void,
  state: StreamState,
  onText: (text: string, isThinking?: boolean) => void,
  onMcpExec: (exec: PendingExec) => void,
  onCheckpoint?: (checkpointBytes: Uint8Array) => void,
): void {
  const msgCase = msg.message.case;

  if (msgCase === "interactionUpdate") {
    handleInteractionUpdate(msg.message.value, state, onText);
  } else if (msgCase === "kvServerMessage") {
    handleKvMessage(msg.message.value as KvServerMessage, blobStore, sendFrame);
  } else if (msgCase === "execServerMessage") {
    handleExecMessage(
      msg.message.value as ExecServerMessage,
      mcpTools,
      sendFrame,
      onMcpExec,
    );
  } else if (msgCase === "conversationCheckpointUpdate") {
    const stateStructure = msg.message.value as ConversationStateStructure;
    if (stateStructure.tokenDetails) {
      state.totalTokens = stateStructure.tokenDetails.usedTokens;
    }
    if (onCheckpoint) {
      onCheckpoint(toBinary(ConversationStateStructureSchema, stateStructure));
    }
  }
}

function handleInteractionUpdate(
  update: any,
  state: StreamState,
  onText: (text: string, isThinking?: boolean) => void,
): void {
  const updateCase = update.message?.case;

  if (updateCase === "textDelta") {
    const delta = update.message.value.text || "";
    if (delta) onText(delta, false);
  } else if (updateCase === "thinkingDelta") {
    const delta = update.message.value.text || "";
    if (delta) onText(delta, true);
  } else if (updateCase === "tokenDelta") {
    state.outputTokens += update.message.value.tokens ?? 0;
  }
  // toolCallStarted, partialToolCall, toolCallDelta, toolCallCompleted
  // are intentionally ignored. MCP tool calls flow through the exec
  // message path (mcpArgs → mcpResult), not interaction updates.
}

/** Send a KV client response back to Cursor. */
function sendKvResponse(
  kvMsg: KvServerMessage,
  messageCase: string,
  value: unknown,
  sendFrame: (data: Uint8Array) => void,
): void {
  const response = create(KvClientMessageSchema, {
    id: kvMsg.id,
    message: { case: messageCase as any, value: value as any },
  });
  const clientMsg = create(AgentClientMessageSchema, {
    message: { case: "kvClientMessage", value: response },
  });
  sendFrame(toBinary(AgentClientMessageSchema, clientMsg));
}

function handleKvMessage(
  kvMsg: KvServerMessage,
  blobStore: Map<string, Uint8Array>,
  sendFrame: (data: Uint8Array) => void,
): void {
  const kvCase = kvMsg.message.case;

  if (kvCase === "getBlobArgs") {
    const blobId = kvMsg.message.value.blobId;
    const blobIdKey = Buffer.from(blobId).toString("hex");
    const blobData = blobStore.get(blobIdKey);
    if (!blobData) {
      logPluginWarn("Cursor requested missing blob", {
        blobId: blobIdKey,
        knownBlobCount: blobStore.size,
      });
    }
    sendKvResponse(
      kvMsg, "getBlobResult",
      create(GetBlobResultSchema, blobData ? { blobData } : {}),
      sendFrame,
    );
  } else if (kvCase === "setBlobArgs") {
    const { blobId, blobData } = kvMsg.message.value;
    blobStore.set(Buffer.from(blobId).toString("hex"), blobData);
    sendKvResponse(
      kvMsg, "setBlobResult",
      create(SetBlobResultSchema, {}),
      sendFrame,
    );
  }
}

function handleExecMessage(
  execMsg: ExecServerMessage,
  mcpTools: McpToolDefinition[],
  sendFrame: (data: Uint8Array) => void,
  onMcpExec: (exec: PendingExec) => void,
): void {
  const execCase = execMsg.message.case;

  if (execCase === "requestContextArgs") {
    const requestContext = create(RequestContextSchema, {
      rules: [],
      repositoryInfo: [],
      tools: mcpTools,
      gitRepos: [],
      projectLayouts: [],
      mcpInstructions: [],
      fileContents: {},
      customSubagents: [],
    });
    const result = create(RequestContextResultSchema, {
      result: {
        case: "success",
        value: create(RequestContextSuccessSchema, { requestContext }),
      },
    });
    sendExecResult(execMsg, "requestContextResult", result, sendFrame);
    return;
  }

  if (execCase === "mcpArgs") {
    const mcpArgs = execMsg.message.value;
    const decoded = decodeMcpArgsMap(mcpArgs.args ?? {});
    onMcpExec({
      execId: execMsg.execId,
      execMsgId: execMsg.id,
      toolCallId: mcpArgs.toolCallId || crypto.randomUUID(),
      toolName: mcpArgs.toolName || mcpArgs.name,
      decodedArgs: JSON.stringify(decoded),
    });
    return;
  }

  // --- Reject native Cursor tools ---
  // The model tries these first. We must respond with rejection/error
  // so it falls back to our MCP tools (registered via RequestContext).
  const REJECT_REASON = "Tool not available in this environment. Use the MCP tools provided instead.";

  if (execCase === "readArgs") {
    const args = execMsg.message.value;
    const result = create(ReadResultSchema, {
      result: { case: "rejected", value: create(ReadRejectedSchema, { path: args.path, reason: REJECT_REASON }) },
    });
    sendExecResult(execMsg, "readResult", result, sendFrame);
    return;
  }
  if (execCase === "lsArgs") {
    const args = execMsg.message.value;
    const result = create(LsResultSchema, {
      result: { case: "rejected", value: create(LsRejectedSchema, { path: args.path, reason: REJECT_REASON }) },
    });
    sendExecResult(execMsg, "lsResult", result, sendFrame);
    return;
  }
  if (execCase === "grepArgs") {
    const result = create(GrepResultSchema, {
      result: { case: "error", value: create(GrepErrorSchema, { error: REJECT_REASON }) },
    });
    sendExecResult(execMsg, "grepResult", result, sendFrame);
    return;
  }
  if (execCase === "writeArgs") {
    const args = execMsg.message.value;
    const result = create(WriteResultSchema, {
      result: { case: "rejected", value: create(WriteRejectedSchema, { path: args.path, reason: REJECT_REASON }) },
    });
    sendExecResult(execMsg, "writeResult", result, sendFrame);
    return;
  }
  if (execCase === "deleteArgs") {
    const args = execMsg.message.value;
    const result = create(DeleteResultSchema, {
      result: { case: "rejected", value: create(DeleteRejectedSchema, { path: args.path, reason: REJECT_REASON }) },
    });
    sendExecResult(execMsg, "deleteResult", result, sendFrame);
    return;
  }
  if (execCase === "shellArgs" || execCase === "shellStreamArgs") {
    const args = execMsg.message.value;
    const result = create(ShellResultSchema, {
      result: {
        case: "rejected",
        value: create(ShellRejectedSchema, {
          command: args.command ?? "",
          workingDirectory: args.workingDirectory ?? "",
          reason: REJECT_REASON,
          isReadonly: false,
        }),
      },
    });
    sendExecResult(execMsg, "shellResult", result, sendFrame);
    return;
  }
  if (execCase === "backgroundShellSpawnArgs") {
    const args = execMsg.message.value;
    const result = create(BackgroundShellSpawnResultSchema, {
      result: {
        case: "rejected",
        value: create(ShellRejectedSchema, {
          command: args.command ?? "",
          workingDirectory: args.workingDirectory ?? "",
          reason: REJECT_REASON,
          isReadonly: false,
        }),
      },
    });
    sendExecResult(execMsg, "backgroundShellSpawnResult", result, sendFrame);
    return;
  }
  if (execCase === "writeShellStdinArgs") {
    const result = create(WriteShellStdinResultSchema, {
      result: { case: "error", value: create(WriteShellStdinErrorSchema, { error: REJECT_REASON }) },
    });
    sendExecResult(execMsg, "writeShellStdinResult", result, sendFrame);
    return;
  }
  if (execCase === "fetchArgs") {
    const args = execMsg.message.value;
    const result = create(FetchResultSchema, {
      result: { case: "error", value: create(FetchErrorSchema, { url: args.url ?? "", error: REJECT_REASON }) },
    });
    sendExecResult(execMsg, "fetchResult", result, sendFrame);
    return;
  }
  if (execCase === "diagnosticsArgs") {
    const result = create(DiagnosticsResultSchema, {});
    sendExecResult(execMsg, "diagnosticsResult", result, sendFrame);
    return;
  }

  // MCP resource/screen/computer exec types
  const miscCaseMap: Record<string, string> = {
    listMcpResourcesExecArgs: "listMcpResourcesExecResult",
    readMcpResourceExecArgs: "readMcpResourceExecResult",
    recordScreenArgs: "recordScreenResult",
    computerUseArgs: "computerUseResult",
  };
  const resultCase = miscCaseMap[execCase as string];
  if (resultCase) {
    sendExecResult(execMsg, resultCase, create(McpResultSchema, {}), sendFrame);
    return;
  }

  // Unknown exec type — log and ignore
  console.error(`[proxy] unhandled exec: ${execCase}`);
}

/** Send an exec client message back to Cursor. */
function sendExecResult(
  execMsg: ExecServerMessage,
  messageCase: string,
  value: unknown,
  sendFrame: (data: Uint8Array) => void,
): void {
  const execClientMessage = create(ExecClientMessageSchema, {
    id: execMsg.id,
    execId: execMsg.execId,
    message: { case: messageCase as any, value: value as any },
  });
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "execClientMessage", value: execClientMessage },
  });
  sendFrame(toBinary(AgentClientMessageSchema, clientMessage));
}

/** Derive a key for active bridge lookup (tool-call continuations). */
function deriveBridgeKey(
  modelId: string,
  messages: OpenAIMessage[],
  sessionId?: string,
  agentKey?: string,
): string {
  if (sessionId) {
    const normalizedAgent = normalizeAgentKey(agentKey);
    return createHash("sha256")
      .update(`bridge:${sessionId}:${normalizedAgent}`)
      .digest("hex")
      .slice(0, 16);
  }

  const firstUserMsg = messages.find((m) => m.role === "user");
  const firstUserText = firstUserMsg ? textContent(firstUserMsg.content) : "";
  const normalizedAgent = normalizeAgentKey(agentKey);
  return createHash("sha256")
    .update(`bridge:${normalizedAgent}:${modelId}:${firstUserText.slice(0, 200)}`)
    .digest("hex")
    .slice(0, 16);
}

/** Derive a key for conversation state. Model-independent so context survives model switches. */
function deriveConversationKey(
  messages: OpenAIMessage[],
  sessionId?: string,
  agentKey?: string,
): string {
  if (sessionId) {
    const normalizedAgent = normalizeAgentKey(agentKey);
    return createHash("sha256")
      .update(`session:${sessionId}:${normalizedAgent}`)
      .digest("hex")
      .slice(0, 16);
  }

  return createHash("sha256")
    .update(`${normalizeAgentKey(agentKey)}:${buildConversationFingerprint(messages)}`)
    .digest("hex")
    .slice(0, 16);
}

function buildConversationFingerprint(messages: OpenAIMessage[]): string {
  return messages.map((message) => {
    const toolCallIDs = (message.tool_calls ?? []).map((call) => call.id).join(",");
    return `${message.role}:${textContent(message.content)}:${message.tool_call_id ?? ""}:${toolCallIDs}`;
  }).join("\n---\n");
}

interface ConversationRequestMetadata {
  systemPrompt: string;
  systemPromptHash: string;
  completedTurnsFingerprint: string;
  turns: Array<{ userText: string; assistantText: string }>;
  userText: string;
  assistantSeedText?: string;
  agentKey?: string;
}

function updateStoredConversationAfterCompletion(
  convKey: string,
  metadata: ConversationRequestMetadata,
  assistantText: string,
): void {
  const stored = conversationStates.get(convKey);
  if (!stored) return;

  const nextTurns = metadata.userText
    ? [...metadata.turns, { userText: metadata.userText, assistantText: assistantText.trim() }]
    : metadata.turns;

  stored.systemPromptHash = metadata.systemPromptHash;
  stored.completedTurnsFingerprint = buildCompletedTurnsFingerprint(
    metadata.systemPrompt,
    nextTurns,
  );
  stored.lastAccessMs = Date.now();
}

function deriveFallbackTitle(text: string): string {
  const cleaned = text
    .replace(/<[^>]+>/g, " ")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/[^\p{L}\p{N}'’\-\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "";

  const words = cleaned.split(" ").filter(Boolean).slice(0, 6);
  return finalizeTitle(words.map(titleCaseWord).join(" "));
}

function titleCaseWord(word: string): string {
  if (!word) return word;
  return word[0]!.toUpperCase() + word.slice(1);
}

function finalizeTitle(value: string): string {
  return value
    .replace(/^#{1,6}\s*/, "")
    .replace(/[.!?,:;]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
}

function createBufferedSSETextResponse(
  modelId: string,
  text: string,
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
): Response {
  const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 28)}`;
  const created = Math.floor(Date.now() / 1000);
  const payload = [
    {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    },
    {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
    {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices: [],
      usage,
    },
  ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";

  return new Response(payload, { headers: SSE_HEADERS });
}

async function handleTitleGenerationRequest(
  sourceText: string,
  accessToken: string,
  modelId: string,
  stream: boolean,
): Promise<Response> {
  const requestBody = toBinary(
    NameAgentRequestSchema,
    create(NameAgentRequestSchema, {
      userMessage: sourceText,
    }),
  );

  const response = await callCursorUnaryRpc({
    accessToken,
    rpcPath: "/agent.v1.AgentService/NameAgent",
    requestBody,
    timeoutMs: 5_000,
  });

  if (response.timedOut) {
    throw new Error("Cursor title generation timed out");
  }
  if (response.exitCode !== 0) {
    throw new Error(`Cursor title generation failed with HTTP ${response.exitCode}`);
  }

  const payload = decodeConnectUnaryBody(response.body) ?? response.body;
  const decoded = fromBinary(NameAgentResponseSchema, payload);
  const title = finalizeTitle(decoded.name) || deriveFallbackTitle(sourceText) || "Untitled Session";
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  if (stream) {
    return createBufferedSSETextResponse(modelId, title, usage);
  }

  const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 28)}`;
  const created = Math.floor(Date.now() / 1000);
  return new Response(
    JSON.stringify({
      id: completionId,
      object: "chat.completion",
      created,
      model: modelId,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: title },
          finish_reason: "stop",
        },
      ],
      usage,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

/** Create an SSE streaming Response that reads from a live bridge. */
function createBridgeStreamResponse(
  bridge: CursorSession,
  heartbeatTimer: NodeJS.Timeout,
  blobStore: Map<string, Uint8Array>,
  mcpTools: McpToolDefinition[],
  modelId: string,
  bridgeKey: string,
  convKey: string,
  metadata: ConversationRequestMetadata,
): Response {
  const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 28)}`;
  const created = Math.floor(Date.now() / 1000);

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const sendSSE = (data: object) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };
      const sendDone = () => {
        if (closed) return;
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      };
      const closeController = () => {
        if (closed) return;
        closed = true;
        controller.close();
      };

      const makeChunk = (
        delta: Record<string, unknown>,
        finishReason: string | null = null,
      ) => ({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: modelId,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      });

      const makeUsageChunk = () => {
        const { prompt_tokens, completion_tokens, total_tokens } = computeUsage(state);
        return {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: modelId,
          choices: [],
          usage: { prompt_tokens, completion_tokens, total_tokens },
        };
      };

      const state: StreamState = {
        toolCallIndex: 0,
        pendingExecs: [],
        outputTokens: 0,
        totalTokens: 0,
      };
      const tagFilter = createThinkingTagFilter();
      let assistantText = metadata.assistantSeedText ?? "";

      let mcpExecReceived = false;
      let endStreamError: Error | null = null;

      const processChunk = createConnectFrameParser(
        (messageBytes) => {
          try {
            const serverMessage = fromBinary(
              AgentServerMessageSchema,
              messageBytes,
            );
            processServerMessage(
              serverMessage,
              blobStore,
              mcpTools,
              (data) => bridge.write(data),
              state,
              (text, isThinking) => {
                if (isThinking) {
                  sendSSE(makeChunk({ reasoning_content: text }));
                } else {
                  const { content, reasoning } = tagFilter.process(text);
                  if (reasoning) sendSSE(makeChunk({ reasoning_content: reasoning }));
                  if (content) {
                    assistantText += content;
                    sendSSE(makeChunk({ content }));
                  }
                }
              },
              // onMcpExec — the model wants to execute a tool.
              (exec) => {
                state.pendingExecs.push(exec);
                mcpExecReceived = true;

                const flushed = tagFilter.flush();
                if (flushed.reasoning) sendSSE(makeChunk({ reasoning_content: flushed.reasoning }));
                if (flushed.content) {
                  assistantText += flushed.content;
                  sendSSE(makeChunk({ content: flushed.content }));
                }

                const assistantSeedText = [
                  assistantText.trim(),
                  formatToolCallSummary({
                    id: exec.toolCallId,
                    type: "function",
                    function: {
                      name: exec.toolName,
                      arguments: exec.decodedArgs,
                    },
                  }),
                ].filter(Boolean).join("\n\n");

                const toolCallIndex = state.toolCallIndex++;
                sendSSE(makeChunk({
                  tool_calls: [{
                    index: toolCallIndex,
                    id: exec.toolCallId,
                    type: "function",
                    function: {
                      name: exec.toolName,
                      arguments: exec.decodedArgs,
                    },
                  }],
                }));

                // Keep the bridge alive for tool result continuation.
                activeBridges.set(bridgeKey, {
                  bridge,
                  heartbeatTimer,
                  blobStore,
                  mcpTools,
                  pendingExecs: state.pendingExecs,
                  modelId,
                  metadata: {
                    ...metadata,
                    assistantSeedText,
                  },
                });

                sendSSE(makeChunk({}, "tool_calls"));
                sendDone();
                closeController();
              },
              (checkpointBytes) => {
                const stored = conversationStates.get(convKey);
                if (stored) {
                  stored.checkpoint = checkpointBytes;
                  stored.lastAccessMs = Date.now();
                }
              },
            );
          } catch {
            // Skip unparseable messages
          }
        },
        (endStreamBytes) => {
          endStreamError = parseConnectEndStream(endStreamBytes);
          if (endStreamError) {
            logPluginError("Cursor stream returned Connect end-stream error", {
              modelId,
              bridgeKey,
              convKey,
              ...errorDetails(endStreamError),
            });
          }
          scheduleBridgeEnd(bridge);
        },
      );

      bridge.onData(processChunk);

      bridge.onClose((code) => {
        clearInterval(heartbeatTimer);
        const stored = conversationStates.get(convKey);
        if (stored) {
          for (const [k, v] of blobStore) stored.blobStore.set(k, v);
          stored.lastAccessMs = Date.now();
        }
        if (endStreamError) {
          activeBridges.delete(bridgeKey);
          if (!closed) {
            closed = true;
            controller.error(endStreamError);
          }
          return;
        }
        if (!mcpExecReceived) {
          const flushed = tagFilter.flush();
          if (flushed.reasoning) sendSSE(makeChunk({ reasoning_content: flushed.reasoning }));
          if (flushed.content) {
            assistantText += flushed.content;
            sendSSE(makeChunk({ content: flushed.content }));
          }
          updateStoredConversationAfterCompletion(convKey, metadata, assistantText);
          sendSSE(makeChunk({}, "stop"));
          sendSSE(makeUsageChunk());
          sendDone();
          closeController();
        } else {
          activeBridges.delete(bridgeKey);
          if (code !== 0 && !closed) {
            // Bridge died while tool calls are pending (timeout, crash, etc.).
            // Close the SSE stream so the client doesn't hang forever.
            sendSSE(makeChunk({ content: "\n[Error: bridge connection lost]" }));
            sendSSE(makeChunk({}, "stop"));
            sendSSE(makeUsageChunk());
            sendDone();
            closeController();
          }
        }
      });
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

/** Start a Cursor RunSSE session, send the initial request, and start heartbeats. */
async function startBridge(
  accessToken: string,
  requestBytes: Uint8Array,
): Promise<{ bridge: CursorSession; heartbeatTimer: NodeJS.Timeout }> {
  const requestId = crypto.randomUUID();
  const bridge = await createCursorSession({
    accessToken,
    requestId,
  });
  bridge.write(requestBytes);
  const heartbeatTimer = setInterval(() => bridge.write(makeHeartbeatBytes()), 5_000);
  return { bridge, heartbeatTimer };
}

async function handleStreamingResponse(
  payload: CursorRequestPayload,
  accessToken: string,
  modelId: string,
  bridgeKey: string,
  convKey: string,
  metadata: ConversationRequestMetadata,
): Promise<Response> {
  const { bridge, heartbeatTimer } = await startBridge(accessToken, payload.requestBytes);
  return createBridgeStreamResponse(
    bridge, heartbeatTimer,
    payload.blobStore, payload.mcpTools,
    modelId, bridgeKey, convKey, metadata,
  );
}

/** Resume a paused bridge by sending MCP results and continuing to stream. */
function handleToolResultResume(
  active: ActiveBridge,
  toolResults: ToolResultInfo[],
  bridgeKey: string,
  convKey: string,
): Response {
  const { bridge, heartbeatTimer, blobStore, mcpTools, pendingExecs, modelId, metadata } = active;
  const resumeMetadata: ConversationRequestMetadata = {
    ...metadata,
    assistantSeedText: [
      metadata.assistantSeedText?.trim() ?? "",
      toolResults.map(formatToolResultSummary).join("\n\n"),
    ].filter(Boolean).join("\n\n"),
  };

  // Send mcpResult for each pending exec that has a matching tool result
  for (const exec of pendingExecs) {
    const result = toolResults.find(
      (r) => r.toolCallId === exec.toolCallId,
    );
    const mcpResult = result
      ? create(McpResultSchema, {
        result: {
          case: "success",
          value: create(McpSuccessSchema, {
            content: [
              create(McpToolResultContentItemSchema, {
                content: {
                  case: "text",
                  value: create(McpTextContentSchema, { text: result.content }),
                },
              }),
            ],
            isError: false,
          }),
        },
      })
      : create(McpResultSchema, {
        result: {
          case: "error",
          value: create(McpErrorSchema, { error: "Tool result not provided" }),
        },
      });

    const execClientMessage = create(ExecClientMessageSchema, {
      id: exec.execMsgId,
      execId: exec.execId,
      message: {
        case: "mcpResult" as any,
        value: mcpResult as any,
      },
    });

    const clientMessage = create(AgentClientMessageSchema, {
      message: { case: "execClientMessage", value: execClientMessage },
    });

    bridge.write(toBinary(AgentClientMessageSchema, clientMessage));
  }

  return createBridgeStreamResponse(
    bridge, heartbeatTimer,
    blobStore, mcpTools,
    modelId, bridgeKey, convKey, resumeMetadata,
  );
}

async function handleNonStreamingResponse(
  payload: CursorRequestPayload,
  accessToken: string,
  modelId: string,
  convKey: string,
  metadata: ConversationRequestMetadata,
): Promise<Response> {
  const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 28)}`;
  const created = Math.floor(Date.now() / 1000);
  const { text, usage, finishReason, toolCalls } = await collectFullResponse(
    payload,
    accessToken,
    modelId,
    convKey,
    metadata,
  );

  const message = finishReason === "tool_calls"
    ? { role: "assistant", content: null, tool_calls: toolCalls }
    : { role: "assistant", content: text };

  return new Response(
    JSON.stringify({
      id: completionId,
      object: "chat.completion",
      created,
      model: modelId,
      choices: [
        {
          index: 0,
          message,
          finish_reason: finishReason,
        },
      ],
      usage,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

interface CollectedResponse {
  text: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  finishReason: "stop" | "tool_calls";
  toolCalls: OpenAIToolCall[];
}

async function collectFullResponse(
  payload: CursorRequestPayload,
  accessToken: string,
  modelId: string,
  convKey: string,
  metadata: ConversationRequestMetadata,
): Promise<CollectedResponse> {
  const { promise, resolve, reject } = Promise.withResolvers<CollectedResponse>();
  let fullText = "";
  let endStreamError: Error | null = null;
  const pendingToolCalls: OpenAIToolCall[] = [];

  const { bridge, heartbeatTimer } = await startBridge(accessToken, payload.requestBytes);

  const state: StreamState = {
    toolCallIndex: 0,
    pendingExecs: [],
    outputTokens: 0,
    totalTokens: 0,
  };
  const tagFilter = createThinkingTagFilter();

  bridge.onData(createConnectFrameParser(
    (messageBytes) => {
      try {
        const serverMessage = fromBinary(
          AgentServerMessageSchema,
          messageBytes,
        );
        processServerMessage(
          serverMessage,
          payload.blobStore,
          payload.mcpTools,
          (data) => bridge.write(data),
          state,
          (text, isThinking) => {
            if (isThinking) return;
            const { content } = tagFilter.process(text);
            fullText += content;
          },
          (exec) => {
            pendingToolCalls.push({
              id: exec.toolCallId,
              type: "function",
              function: {
                name: exec.toolName,
                arguments: exec.decodedArgs,
              },
            });
            scheduleBridgeEnd(bridge);
          },
          (checkpointBytes) => {
            const stored = conversationStates.get(convKey);
            if (stored) {
              stored.checkpoint = checkpointBytes;
              stored.lastAccessMs = Date.now();
            }
          },
        );
      } catch {
        // Skip
      }
    },
    (endStreamBytes) => {
      endStreamError = parseConnectEndStream(endStreamBytes);
      if (endStreamError) {
        logPluginError("Cursor non-streaming response returned Connect end-stream error", {
          modelId,
          convKey,
          ...errorDetails(endStreamError),
        });
      }
      scheduleBridgeEnd(bridge);
    },
  ));

  bridge.onClose(() => {
    clearInterval(heartbeatTimer);
    const stored = conversationStates.get(convKey);
    if (stored) {
      for (const [k, v] of payload.blobStore) stored.blobStore.set(k, v);
      stored.lastAccessMs = Date.now();
    }
    const flushed = tagFilter.flush();
    fullText += flushed.content;

    if (endStreamError) {
      reject(endStreamError);
      return;
    }

    if (pendingToolCalls.length === 0) {
      updateStoredConversationAfterCompletion(convKey, metadata, fullText);
    }

    const usage = computeUsage(state);
    resolve({
      text: fullText,
      usage,
      finishReason: pendingToolCalls.length > 0 ? "tool_calls" : "stop",
      toolCalls: pendingToolCalls,
    });
  });

  return promise;
}
