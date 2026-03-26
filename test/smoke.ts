import http from "node:http";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { create, fromBinary, fromJson, toBinary } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import {
  AgentClientMessageSchema,
  AgentConversationTurnStructureSchema,
  AgentServerMessageSchema,
  AssistantMessageSchema,
  ConversationStateStructureSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  ExecServerMessageSchema,
  GetUsableModelsResponseSchema,
  McpArgsSchema,
  ModelDetailsSchema,
  NameAgentRequestSchema,
  NameAgentResponseSchema,
  UserMessageSchema,
} from "../src/proto/agent_pb";

type DiscoveryMode = "success" | "empty" | "auth-error";
type RunSSEMode =
  | "close-on-append"
  | "end-stream-hold"
  | "interaction-tool-call-pause"
  | "turn-ended-hold"
  | "checkpoint-then-close"
  | "tool-call-pause"
  | "unsupported-interaction-query-pause"
  | "unsupported-exec-pause"
  | "verbose-title-close";

interface ObservedRunRequest {
  conversationId: string;
  turnCount: number;
  actionCase: string;
  latestUserText: string;
  turns: Array<{ userText: string; assistantText: string }>;
  customSystemPrompt: string;
}

interface TestModules {
  startProxy: typeof import("../src/proxy").startProxy;
  stopProxy: typeof import("../src/proxy").stopProxy;
  getProxyPort: typeof import("../src/proxy").getProxyPort;
  callCursorUnaryRpc: typeof import("../src/proxy").callCursorUnaryRpc;
  configurePluginLogger: typeof import("../src/logger").configurePluginLogger;
  logPluginError: typeof import("../src/logger").logPluginError;
  flushPluginLogs: typeof import("../src/logger").flushPluginLogs;
  generateCursorAuthParams: typeof import("../src/auth").generateCursorAuthParams;
  getTokenExpiry: typeof import("../src/auth").getTokenExpiry;
  CursorAuthPlugin: typeof import("../src/index").CursorAuthPlugin;
  getCursorModels: typeof import("../src/models").getCursorModels;
  clearModelCache: typeof import("../src/models").clearModelCache;
}

interface TestCursorBackend {
  apiUrl: string;
  refreshUrl: string;
  setDiscoveryMode: (mode: DiscoveryMode) => void;
  setDiscoveredModels: (
    models: Array<{ id: string; name: string; reasoning?: boolean }>,
  ) => void;
  setRunSSEMode: (mode: RunSSEMode) => void;
  resetObservations: () => void;
  getDiscoveryAuthHeaders: () => string[];
  getDiscoveryRequestBodies: () => Uint8Array[];
  getRefreshAuthHeaders: () => string[];
  getBidiAppendCount: () => number;
  getObservedRunRequests: () => ObservedRunRequest[];
  getObservedNameAgentRequests: () => string[];
  close: () => Promise<void>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${String(expected)}, got ${String(actual)}`,
    );
  }
}

function assertArrayEqual(
  actual: readonly string[],
  expected: readonly string[],
  message: string,
): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}

function makeJwt(expiresAtSeconds: number): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ exp: expiresAtSeconds }));
  return `${header}.${payload}.fakesig`;
}

function frameConnectUnaryMessage(payload: Uint8Array): Buffer {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0;
  frame.writeUInt32BE(payload.length, 1);
  frame.set(payload, 5);
  return frame;
}

function frameConnectEndStreamMessage(payload: Uint8Array): Buffer {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0b00000010;
  frame.writeUInt32BE(payload.length, 1);
  frame.set(payload, 5);
  return frame;
}

function readVarint(
  bytes: Uint8Array,
  startOffset: number,
): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  let offset = startOffset;

  while (offset < bytes.length) {
    const byte = bytes[offset]!;
    value |= (byte & 0x7f) << shift;
    offset += 1;
    if ((byte & 0x80) === 0) {
      return { value, offset };
    }
    shift += 7;
  }

  throw new Error("Invalid varint");
}

function decodeObservedRunRequest(
  payload: Uint8Array,
): ObservedRunRequest | null {
  if (payload.length === 0 || payload[0] !== 0x0a) return null;

  const { value: hexLength, offset } = readVarint(payload, 1);
  const hexBytes = payload.subarray(offset, offset + hexLength);
  const dataHex = new TextDecoder().decode(hexBytes);
  if (!dataHex) return null;

  const clientMessage = fromBinary(
    AgentClientMessageSchema,
    new Uint8Array(Buffer.from(dataHex, "hex")),
  );
  if (clientMessage.message.case !== "runRequest") return null;

  const runRequest = clientMessage.message.value;
  const action = runRequest.action?.action;
  const turns = (runRequest.conversationState?.turns ?? []).map((turnBytes) => {
    const turnStructure = fromBinary(
      ConversationTurnStructureSchema,
      turnBytes,
    );
    const agentTurn =
      turnStructure.turn.case === "agentConversationTurn"
        ? turnStructure.turn.value
        : undefined;
    const userText = agentTurn?.userMessage
      ? fromBinary(UserMessageSchema, agentTurn.userMessage).text
      : "";
    const assistantText = (agentTurn?.steps ?? [])
      .map((stepBytes) => {
        const step = fromBinary(ConversationStepSchema, stepBytes);
        return step.message.case === "assistantMessage"
          ? step.message.value.text
          : "";
      })
      .filter(Boolean)
      .join("\n");

    return { userText, assistantText };
  });

  return {
    conversationId: runRequest.conversationId ?? "",
    turnCount: runRequest.conversationState?.turns.length ?? 0,
    actionCase: action?.case ?? "",
    latestUserText:
      action?.case === "userMessageAction"
        ? (action.value.userMessage?.text ?? "")
        : "",
    turns,
    customSystemPrompt: runRequest.customSystemPrompt ?? "",
  };
}

function makeToolCallFrame(): Buffer {
  const execMessage = create(ExecServerMessageSchema, {
    id: 1,
    execId: "exec-1",
    message: {
      case: "mcpArgs",
      value: create(McpArgsSchema, {
        name: "read_file",
        toolName: "read_file",
        toolCallId: "call-1",
        providerIdentifier: "opencode",
        args: {
          path: toBinary(ValueSchema, fromJson(ValueSchema, "src/index.ts")),
        },
      }),
    },
  });
  const serverMessage = create(AgentServerMessageSchema, {
    message: {
      case: "execServerMessage",
      value: execMessage,
    },
  });
  return frameConnectUnaryMessage(
    toBinary(AgentServerMessageSchema, serverMessage),
  );
}

function makeInteractionToolCallCompletedFrame(): Buffer {
  const serverMessage = create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: {
        message: {
          case: "toolCallCompleted",
          value: {
            callId: "interaction-call-1",
            modelCallId: "model-call-1",
            toolCall: {
              tool: {
                case: "mcpToolCall",
                value: {
                  args: {
                    name: "read_file",
                    toolName: "read_file",
                    toolCallId: "interaction-call-1",
                    providerIdentifier: "opencode",
                    args: {
                      path: toBinary(
                        ValueSchema,
                        fromJson(ValueSchema, "src/index.ts"),
                      ),
                    },
                  },
                },
              },
            },
          },
        },
      } as any,
    },
  });
  return frameConnectUnaryMessage(
    toBinary(AgentServerMessageSchema, serverMessage),
  );
}

function makeUnsupportedExecFrame(): Buffer {
  const execMessage = create(ExecServerMessageSchema, {
    id: 2,
    execId: "exec-unsupported",
  });
  const serverMessage = create(AgentServerMessageSchema, {
    message: {
      case: "execServerMessage",
      value: execMessage,
    },
  });
  return frameConnectUnaryMessage(
    toBinary(AgentServerMessageSchema, serverMessage),
  );
}

function makeUnsupportedInteractionQueryFrame(): Buffer {
  const serverMessage = create(AgentServerMessageSchema, {
    message: {
      case: "interactionQuery",
      value: {
        id: 9,
        query: {
          case: "askQuestionInteractionQuery",
          value: {
            toolCallId: "call-question-1",
            args: {
              title: "Question",
              questions: [],
              runAsync: false,
              asyncOriginalToolCallId: "",
            },
          },
        },
      } as any,
    },
  });
  return frameConnectUnaryMessage(
    toBinary(AgentServerMessageSchema, serverMessage),
  );
}

function makeCheckpointUpdateFrame(): Buffer {
  const userMessage = create(UserMessageSchema, {
    text: "remembered context",
    messageId: "test-user-message",
  });
  const step = create(ConversationStepSchema, {
    message: {
      case: "assistantMessage",
      value: create(AssistantMessageSchema, { text: "remembered reply" }),
    },
  });
  const turn = create(ConversationTurnStructureSchema, {
    turn: {
      case: "agentConversationTurn",
      value: create(AgentConversationTurnStructureSchema, {
        userMessage: toBinary(UserMessageSchema, userMessage),
        steps: [toBinary(ConversationStepSchema, step)],
      }),
    },
  });
  const checkpoint = create(ConversationStateStructureSchema, {
    rootPromptMessagesJson: [new Uint8Array([1])],
    turns: [toBinary(ConversationTurnStructureSchema, turn)],
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
  const serverMessage = create(AgentServerMessageSchema, {
    message: {
      case: "conversationCheckpointUpdate",
      value: checkpoint,
    },
  });
  return frameConnectUnaryMessage(
    toBinary(AgentServerMessageSchema, serverMessage),
  );
}

function makeTextDeltaFrame(text: string): Buffer {
  const serverMessage = create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: {
        message: {
          case: "textDelta",
          value: { text },
        },
      } as any,
    },
  });
  return frameConnectUnaryMessage(
    toBinary(AgentServerMessageSchema, serverMessage),
  );
}

function makeTurnEndedFrame(): Buffer {
  const serverMessage = create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: {
        message: {
          case: "turnEnded",
          value: {},
        },
      } as any,
    },
  });
  return frameConnectUnaryMessage(
    toBinary(AgentServerMessageSchema, serverMessage),
  );
}

async function createTestCursorBackend(): Promise<TestCursorBackend> {
  let discoveryMode: DiscoveryMode = "success";
  let runSSEMode: RunSSEMode = "close-on-append";
  let discoveredModels: Array<{
    id: string;
    name: string;
    reasoning?: boolean;
  }> = [{ id: "composer-2", name: "Composer 2", reasoning: true }];
  const discoveryAuthHeaders: string[] = [];
  const discoveryRequestBodies: Uint8Array[] = [];
  const refreshAuthHeaders: string[] = [];
  const observedRunRequests: ObservedRunRequest[] = [];
  const observedNameAgentRequests: string[] = [];
  let bidiAppendCount = 0;

  const refreshServer = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/auth/exchange_user_api_key") {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    const authHeader = req.headers.authorization ?? "";
    refreshAuthHeaders.push(authHeader);

    if (authHeader !== "Bearer valid-refresh") {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("bad refresh token");
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        accessToken: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        refreshToken: "valid-refresh",
      }),
    );
  });
  await new Promise<void>((resolve) =>
    refreshServer.listen(0, "127.0.0.1", resolve),
  );
  const refreshPort = (refreshServer.address() as AddressInfo).port;

  let pendingRunSSE: http.ServerResponse | null = null;
  let toolCallIssued = false;

  const apiServer = http.createServer((req, res) => {
    const path = req.url ?? "";
    const authHeader = req.headers.authorization ?? "";
    const chunks: Buffer[] = [];

    req.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    req.on("end", () => {
      if (req.method !== "POST") {
        res.writeHead(404);
        res.end();
        return;
      }

      if (path === "/agent.v1.AgentService/GetUsableModels") {
        discoveryAuthHeaders.push(authHeader);
        discoveryRequestBodies.push(new Uint8Array(Buffer.concat(chunks)));

        if (discoveryMode === "auth-error") {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              code: "unauthenticated",
              message: "expired token",
            }),
          );
          return;
        }

        const responseBody =
          discoveryMode === "empty"
            ? frameConnectUnaryMessage(new Uint8Array())
            : frameConnectUnaryMessage(
                toBinary(
                  GetUsableModelsResponseSchema,
                  create(GetUsableModelsResponseSchema, {
                    models: discoveredModels.map((model) =>
                      create(ModelDetailsSchema, {
                        modelId: model.id,
                        displayModelId: model.id,
                        displayName: model.name,
                        displayNameShort: model.name,
                        aliases: [],
                      }),
                    ),
                  }),
                ),
              );
        res.writeHead(200, { "Content-Type": "application/connect+proto" });
        res.end(responseBody);
        return;
      }

      if (path === "/agent.v1.AgentService/RunSSE") {
        pendingRunSSE = res;
        res.on("close", () => {
          if (pendingRunSSE === res) {
            pendingRunSSE = null;
          }
        });
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.flushHeaders();
        return;
      }

      if (path === "/agent.v1.AgentService/NameAgent") {
        const request = fromBinary(
          NameAgentRequestSchema,
          new Uint8Array(Buffer.concat(chunks)),
        );
        observedNameAgentRequests.push(request.userMessage);
        const responseBody = frameConnectUnaryMessage(
          toBinary(
            NameAgentResponseSchema,
            create(NameAgentResponseSchema, {
              name: "Fish Price Question",
            }),
          ),
        );
        res.writeHead(200, { "Content-Type": "application/connect+proto" });
        res.end(responseBody);
        return;
      }

      if (path === "/aiserver.v1.BidiService/BidiAppend") {
        bidiAppendCount += 1;
        const observed = decodeObservedRunRequest(
          new Uint8Array(Buffer.concat(chunks)),
        );
        if (observed) observedRunRequests.push(observed);
        res.writeHead(200, { "Content-Type": "application/proto" });
        res.end();

        if (runSSEMode === "close-on-append" && pendingRunSSE) {
          pendingRunSSE.end();
          pendingRunSSE = null;
        } else if (
          runSSEMode === "end-stream-hold" &&
          pendingRunSSE &&
          bidiAppendCount === 1
        ) {
          pendingRunSSE.write(
            frameConnectEndStreamMessage(new TextEncoder().encode("{}")),
          );
          setTimeout(() => {
            try {
              pendingRunSSE?.end();
            } catch {}
            pendingRunSSE = null;
          }, 6_100);
        } else if (runSSEMode === "checkpoint-then-close" && pendingRunSSE) {
          pendingRunSSE.write(makeCheckpointUpdateFrame());
          pendingRunSSE.end();
          pendingRunSSE = null;
        } else if (
          runSSEMode === "interaction-tool-call-pause" &&
          pendingRunSSE
        ) {
          pendingRunSSE.write(makeInteractionToolCallCompletedFrame());
        } else if (
          runSSEMode === "unsupported-interaction-query-pause" &&
          pendingRunSSE
        ) {
          pendingRunSSE.write(makeUnsupportedInteractionQueryFrame());
        } else if (runSSEMode === "turn-ended-hold" && pendingRunSSE) {
          pendingRunSSE.write(makeTextDeltaFrame("completed response"));
          pendingRunSSE.write(makeTurnEndedFrame());
        } else if (runSSEMode === "verbose-title-close" && pendingRunSSE) {
          pendingRunSSE.write(
            makeTextDeltaFrame(
              "# That depends on which fish you're looking for! If you're referring to the famous 1998 techno hit ...",
            ),
          );
          pendingRunSSE.end();
          pendingRunSSE = null;
        } else if (runSSEMode === "tool-call-pause" && pendingRunSSE) {
          if (!toolCallIssued) {
            toolCallIssued = true;
            pendingRunSSE.write(makeToolCallFrame());
          } else {
            pendingRunSSE.end();
            pendingRunSSE = null;
            toolCallIssued = false;
          }
        } else if (runSSEMode === "unsupported-exec-pause" && pendingRunSSE) {
          pendingRunSSE.write(makeUnsupportedExecFrame());
          setTimeout(() => {
            try {
              pendingRunSSE?.end();
            } catch {}
            pendingRunSSE = null;
          }, 2_000);
        }
        return;
      }

      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) =>
    apiServer.listen(0, "127.0.0.1", resolve),
  );
  const apiPort = (apiServer.address() as AddressInfo).port;

  return {
    apiUrl: `http://127.0.0.1:${apiPort}`,
    refreshUrl: `http://127.0.0.1:${refreshPort}/auth/exchange_user_api_key`,
    setDiscoveryMode(mode) {
      discoveryMode = mode;
    },
    setDiscoveredModels(models) {
      discoveredModels = models;
    },
    setRunSSEMode(mode) {
      runSSEMode = mode;
    },
    resetObservations() {
      discoveryAuthHeaders.length = 0;
      discoveryRequestBodies.length = 0;
      refreshAuthHeaders.length = 0;
      observedRunRequests.length = 0;
      observedNameAgentRequests.length = 0;
      bidiAppendCount = 0;
      toolCallIssued = false;
    },
    getDiscoveryAuthHeaders() {
      return [...discoveryAuthHeaders];
    },
    getDiscoveryRequestBodies() {
      return discoveryRequestBodies.map((body) => new Uint8Array(body));
    },
    getRefreshAuthHeaders() {
      return [...refreshAuthHeaders];
    },
    getBidiAppendCount() {
      return bidiAppendCount;
    },
    getObservedRunRequests() {
      return observedRunRequests.map((request) => ({
        ...request,
        turns: request.turns.map((turn) => ({ ...turn })),
      }));
    },
    getObservedNameAgentRequests() {
      return [...observedNameAgentRequests];
    },
    async close() {
      for (const server of [apiServer, refreshServer]) {
        try {
          server.closeIdleConnections?.();
        } catch {}
        try {
          server.closeAllConnections?.();
        } catch {}
        try {
          server.close();
        } catch {}
      }
    },
  };
}

async function loadModules(): Promise<TestModules> {
  const proxy = await import("../src/proxy");
  const auth = await import("../src/auth");
  const index = await import("../src/index");
  const logger = await import("../src/logger");
  const models = await import("../src/models");
  return {
    startProxy: proxy.startProxy,
    stopProxy: proxy.stopProxy,
    getProxyPort: proxy.getProxyPort,
    callCursorUnaryRpc: proxy.callCursorUnaryRpc,
    configurePluginLogger: logger.configurePluginLogger,
    logPluginError: logger.logPluginError,
    flushPluginLogs: logger.flushPluginLogs,
    generateCursorAuthParams: auth.generateCursorAuthParams,
    getTokenExpiry: auth.getTokenExpiry,
    CursorAuthPlugin: index.CursorAuthPlugin,
    getCursorModels: models.getCursorModels,
    clearModelCache: models.clearModelCache,
  };
}

async function testPluginLogging(modules: TestModules) {
  console.log("[test] Testing OpenCode log forwarding...");

  const logEntries: any[] = [];
  modules.configurePluginLogger({
    directory: "/tmp/opencode-cursor-logger-test",
    client: {
      app: {
        log: async (entry: any) => {
          logEntries.push(entry);
          return true;
        },
      },
    },
  } as any);

  modules.logPluginError("Logger smoke test", {
    stage: "smoke",
    responseBody: new Uint8Array([65, 66]),
    nested: { ok: true },
  });
  await modules.flushPluginLogs();

  assertEqual(
    logEntries.length,
    1,
    "Expected one forwarded OpenCode log entry",
  );
  assertEqual(
    logEntries[0]?.body?.service,
    "opencode-cursor-oauth",
    "Expected plugin log service name",
  );
  assertEqual(logEntries[0]?.body?.level, "error", "Expected error log level");
  assertEqual(
    logEntries[0]?.body?.message,
    "Logger smoke test",
    "Expected forwarded log message",
  );
  assertEqual(
    logEntries[0]?.query?.directory,
    "/tmp/opencode-cursor-logger-test",
    "Expected logger to use the configured OpenCode directory",
  );
  assertEqual(
    logEntries[0]?.body?.extra?.responseBody?.type,
    "uint8array",
    "Expected binary payloads to be serialized for logging",
  );

  console.log("[test] OpenCode log forwarding OK");
}

async function testHttp2UnaryRpc(modules: TestModules) {
  console.log("[test] Testing HTTP/2 unary discovery transport...");

  let observedHeaders: http2.IncomingHttpHeaders | undefined;
  let observedBody = new Uint8Array();
  const responseBody = toBinary(
    GetUsableModelsResponseSchema,
    create(GetUsableModelsResponseSchema, {
      models: [
        create(ModelDetailsSchema, {
          modelId: "composer-2",
          displayModelId: "composer-2",
          displayName: "Composer 2",
          displayNameShort: "Composer 2",
          aliases: [],
        }),
      ],
    }),
  );

  const server = http2.createServer();
  server.on("stream", (stream: http2.ServerHttp2Stream, headers) => {
    observedHeaders = headers;
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    stream.on("end", () => {
      observedBody = new Uint8Array(Buffer.concat(chunks));
      stream.respond({
        ":status": 200,
        "content-type": "application/proto",
      });
      stream.end(Buffer.from(responseBody));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const result = await modules.callCursorUnaryRpc({
      accessToken: "test-access-token",
      rpcPath: "/agent.v1.AgentService/GetUsableModels",
      requestBody: new Uint8Array([1, 2, 3]),
      timeoutMs: 5_000,
      transport: "http2",
      url: `http://127.0.0.1:${port}`,
    });

    assertEqual(result.exitCode, 0, "Expected HTTP/2 unary call to succeed");
    assert(!result.timedOut, "Expected HTTP/2 unary call not to time out");
    assertEqual(
      observedHeaders?.["connect-protocol-version"],
      "1",
      "Expected Connect protocol version header",
    );
    assertEqual(
      observedHeaders?.["content-type"],
      "application/proto",
      "Expected unary Connect content type",
    );
    assertEqual(
      observedHeaders?.authorization,
      "Bearer test-access-token",
      "Expected bearer token auth header",
    );
    assertEqual(
      observedHeaders?.["x-cursor-client-type"],
      "cli",
      "Expected Cursor client type header",
    );
    assertArrayEqual(
      [...observedBody].map(String),
      ["1", "2", "3"],
      "Expected raw unary protobuf body to be forwarded",
    );

    const decoded = fromBinary(GetUsableModelsResponseSchema, result.body);
    assertArrayEqual(
      decoded.models.map((model) => model.modelId),
      ["composer-2"],
      "Expected HTTP/2 unary response body to round-trip",
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  console.log("[test] HTTP/2 unary discovery transport OK");
}

async function testProxyStartStop(modules: TestModules) {
  console.log("[test] Starting proxy...");
  const port = await modules.startProxy(async () => "test-token");
  console.log(`[test] Proxy started on port ${port}`);

  if (port < 1) {
    throw new Error(`Expected a valid port number, got ${port}`);
  }
  if (modules.getProxyPort() !== port) {
    throw new Error("getProxyPort() mismatch");
  }

  const modelsRes = await fetch(`http://localhost:${port}/v1/models`);
  if (!modelsRes.ok) {
    throw new Error(`/v1/models returned ${modelsRes.status}`);
  }
  const modelsBody = await modelsRes.json();
  if (modelsBody.object !== "list") {
    throw new Error(`Expected object=list, got ${modelsBody.object}`);
  }
  if (!Array.isArray(modelsBody.data) || modelsBody.data.length !== 0) {
    throw new Error(
      `Expected empty model list data array, got ${JSON.stringify(modelsBody.data)}`,
    );
  }
  console.log("[test] /v1/models OK");

  const badRes = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "test", messages: [] }),
  });
  if (badRes.status !== 400) {
    throw new Error(
      `Expected 400 for missing user message, got ${badRes.status}`,
    );
  }
  const badBody = await badRes.json();
  if (!badBody.error?.message?.includes("No user message")) {
    throw new Error(
      `Expected 'No user message' error, got: ${badBody.error?.message}`,
    );
  }
  console.log("[test] Missing user message validation OK");

  const notFoundRes = await fetch(`http://localhost:${port}/unknown`);
  if (notFoundRes.status !== 404) {
    throw new Error(`Expected 404, got ${notFoundRes.status}`);
  }
  console.log("[test] 404 handling OK");

  modules.stopProxy();
  if (modules.getProxyPort() !== undefined) {
    throw new Error("Proxy port should be undefined after stop");
  }
  console.log("[test] Proxy stop OK");
}

async function testAuthParams(modules: TestModules) {
  console.log("[test] Generating auth params...");
  const params = await modules.generateCursorAuthParams();

  if (
    !params.verifier ||
    !params.challenge ||
    !params.uuid ||
    !params.loginUrl
  ) {
    throw new Error("Missing auth params");
  }
  if (!params.loginUrl.includes("cursor.com/loginDeepControl")) {
    throw new Error(`Unexpected login URL: ${params.loginUrl}`);
  }
  if (!params.loginUrl.includes(params.uuid)) {
    throw new Error("Login URL missing UUID");
  }

  const data = new TextEncoder().encode(params.verifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const expectedChallenge = Buffer.from(hashBuffer).toString("base64url");
  if (params.challenge !== expectedChallenge) {
    throw new Error(
      `PKCE challenge mismatch: expected ${expectedChallenge}, got ${params.challenge}`,
    );
  }

  console.log("[test] Auth params OK");
}

async function testTokenExpiry(modules: TestModules) {
  console.log("[test] Testing token expiry parsing...");

  const futureExp = Math.floor(Date.now() / 1000) + 7200;
  const fakeJwt = makeJwt(futureExp);

  const expiry = modules.getTokenExpiry(fakeJwt);
  const expectedMin = futureExp * 1000 - 5 * 60 * 1000 - 1000;
  const expectedMax = futureExp * 1000 - 5 * 60 * 1000 + 1000;

  if (expiry < expectedMin || expiry > expectedMax) {
    throw new Error(
      `Token expiry ${expiry} out of expected range [${expectedMin}, ${expectedMax}]`,
    );
  }

  const fallbackExpiry = modules.getTokenExpiry("not-a-jwt");
  const now = Date.now();
  const expectedFallback = now + 3600 * 1000;
  if (Math.abs(fallbackExpiry - expectedFallback) > 5000) {
    throw new Error(
      `Fallback expiry off by ${Math.abs(fallbackExpiry - expectedFallback)}ms, expected ~1h from now`,
    );
  }

  console.log("[test] Token expiry OK");
}

async function testPluginShape(modules: TestModules) {
  console.log("[test] Checking plugin export shape...");

  const fakeInput = {
    client: { auth: { set: async () => {} } },
  } as any;
  const hooks = await modules.CursorAuthPlugin(fakeInput);

  if (!hooks.auth) {
    throw new Error("Plugin hooks missing 'auth'");
  }
  if (hooks.auth.provider !== "cursor") {
    throw new Error(`Expected provider 'cursor', got '${hooks.auth.provider}'`);
  }
  if (typeof hooks.auth.loader !== "function") {
    throw new Error("Plugin hooks.auth.loader is not a function");
  }
  if (!Array.isArray(hooks.auth.methods) || hooks.auth.methods.length === 0) {
    throw new Error("Plugin hooks.auth.methods missing or empty");
  }
  if (hooks.auth.methods[0].type !== "oauth") {
    throw new Error(
      `Expected method type 'oauth', got '${hooks.auth.methods[0].type}'`,
    );
  }
  if (typeof hooks.auth.methods[0].authorize !== "function") {
    throw new Error("Plugin auth method missing authorize function");
  }

  console.log("[test] Plugin shape OK");
}

async function testArrayContentParsing(modules: TestModules) {
  console.log("[test] Testing array content (plan-mode) parsing...");
  const port = await modules.startProxy(async () => "test-token");

  const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "test",
      stream: false,
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "You are a helpful assistant." },
            { type: "text", text: "Plan mode is active." },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "lazy-load recharts" },
            { type: "text", text: "work on a plan" },
          ],
        },
      ],
    }),
  });

  if (res.status === 400) {
    const body = await res.json();
    if (body.error?.message?.includes("No user message")) {
      throw new Error("Array content not normalized — plan mode messages lost");
    }
  }

  modules.stopProxy();
  console.log("[test] Array content parsing OK");
}

async function testExpiredTokenRefreshBeforeDiscovery(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing refresh-before-discovery...");
  modules.clearModelCache();
  backend.resetObservations();
  backend.setDiscoveryMode("success");
  backend.setDiscoveredModels([
    { id: "fresh-model", name: "Fresh Model", reasoning: true },
  ]);

  let authState = {
    type: "oauth" as const,
    access: "expired-access",
    refresh: "valid-refresh",
    expires: Date.now() - 10_000,
  };
  const writes: Array<{ access: string; refresh: string; expires: number }> =
    [];
  const hooks = await modules.CursorAuthPlugin({
    client: {
      auth: {
        set: async ({ body }: any) => {
          writes.push(body);
          authState = body;
        },
      },
    },
  } as any);
  const provider = { models: {} as Record<string, unknown> } as any;
  const loader = hooks.auth?.loader;
  assert(loader, "Expected auth loader to be defined");

  await loader(async () => authState, provider);

  assertEqual(writes.length, 1, "Expected refreshed auth to be persisted once");
  assert(
    writes[0]?.access && writes[0].access !== "expired-access",
    "Expected refreshed access token to replace the expired token",
  );
  assertArrayEqual(
    backend.getRefreshAuthHeaders(),
    ["Bearer valid-refresh"],
    "Expected refresh endpoint to be called with the stored refresh token",
  );
  assert(
    backend
      .getDiscoveryAuthHeaders()
      .every((header) => header === `Bearer ${writes[0]?.access}`),
    `Expected discovery to use the refreshed token, got ${JSON.stringify(backend.getDiscoveryAuthHeaders())}`,
  );
  assertArrayEqual(
    Object.keys(provider.models),
    ["fresh-model"],
    "Expected provider models to come from successful discovery",
  );

  modules.stopProxy();
  console.log("[test] Refresh-before-discovery OK");
}

async function testDiscoveryFailureAndSuccess(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing discovery failure visibility and success...");

  const authState = {
    type: "oauth" as const,
    access: makeJwt(Math.floor(Date.now() / 1000) + 3600),
    refresh: "valid-refresh",
    expires: Date.now() + 3_600_000,
  };
  const toasts: Array<{ title?: string; message: string; variant: string }> =
    [];
  const hooks = await modules.CursorAuthPlugin({
    client: {
      auth: {
        set: async () => {},
      },
      tui: {
        showToast: async ({ body }: any) => {
          toasts.push(body);
          return true;
        },
      },
    },
  } as any);
  const provider = { models: { stale: { id: "stale" } } } as any;
  const loader = hooks.auth?.loader;
  assert(loader, "Expected auth loader to be defined");

  // Failed discovery should disable the provider without throwing.
  modules.clearModelCache();
  backend.setDiscoveryMode("empty");
  const degradedConfig = await loader(async () => authState, provider);
  assert(
    typeof degradedConfig === "object" && degradedConfig !== null,
    "Expected loader to return a disabled config when discovery fails",
  );
  const degradedResponse = await degradedConfig.fetch(
    "http://localhost/unused",
  );
  assertEqual(
    degradedResponse.status,
    503,
    "Expected disabled config fetch to fail cleanly",
  );
  const degradedBody = await degradedResponse.json();
  assert(
    degradedBody.error?.message?.includes("Cursor model discovery returned"),
    `Expected disabled config fetch to expose the discovery error, got ${JSON.stringify(degradedBody)}`,
  );
  assertArrayEqual(
    Object.keys(provider.models),
    [],
    "Expected failed discovery to clear provider models",
  );
  assertEqual(
    toasts.length,
    1,
    "Expected exactly one toast for discovery failure",
  );
  assert(
    toasts[0]?.message.includes("Cursor model discovery returned"),
    `Expected discovery failure message to be shown in a toast, got ${JSON.stringify(toasts)}`,
  );

  // Successful discovery should replace with real models
  modules.clearModelCache();
  backend.setDiscoveryMode("success");
  backend.setDiscoveredModels([
    { id: "real-model-a", name: "Real Model A" },
    { id: "real-model-b", name: "Real Model B", reasoning: true },
  ]);
  const discoveredConfig = await loader(async () => authState, provider);
  assertArrayEqual(
    Object.keys(provider.models).sort(),
    ["real-model-a", "real-model-b"],
    "Expected successful discovery to replace fallback models",
  );
  const discoveredModelsRes = await fetch(`${discoveredConfig.baseURL}/models`);
  assertEqual(
    discoveredModelsRes.status,
    200,
    "Expected discovered /v1/models to succeed",
  );
  const discoveredModelsBody = await discoveredModelsRes.json();
  assertArrayEqual(
    discoveredModelsBody.data.map((model: { id: string }) => model.id).sort(),
    ["real-model-a", "real-model-b"],
    "Expected proxy /v1/models to expose discovered models",
  );

  modules.stopProxy();
  console.log("[test] Discovery failure visibility and success OK");
}

async function testEndStreamStopsHeartbeats(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing Connect end-stream bridge shutdown...");

  try {
    backend.resetObservations();
    backend.setRunSSEMode("end-stream-hold");
    modules.stopProxy();
    const proxyPort = await modules.startProxy(async () => "test-token");
    const response = await fetch(
      `http://localhost:${proxyPort}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "composer-2",
          messages: [{ role: "user", content: "hello" }],
        }),
      },
    );

    assertEqual(
      response.status,
      200,
      "Expected streaming chat completion to succeed",
    );
    const body = await response.text();
    assert(
      body.includes("data: [DONE]"),
      `Expected SSE stream to terminate cleanly, got ${JSON.stringify(body)}`,
    );

    await new Promise((resolve) => setTimeout(resolve, 5_500));
    assertEqual(
      backend.getBidiAppendCount(),
      1,
      "Expected proxy to stop heartbeats after receiving Connect end-stream",
    );
  } finally {
    modules.stopProxy();
    backend.setRunSSEMode("close-on-append");
  }

  console.log("[test] Connect end-stream bridge shutdown OK");
}

async function testTurnEndedStopsStreamingResponse(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing turn-ended bridge shutdown...");

  try {
    backend.resetObservations();
    backend.setRunSSEMode("turn-ended-hold");
    modules.stopProxy();
    const proxyPort = await modules.startProxy(async () => "test-token");
    const response = await fetch(
      `http://localhost:${proxyPort}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "composer-2",
          messages: [{ role: "user", content: "hello" }],
        }),
      },
    );

    assertEqual(
      response.status,
      200,
      "Expected streaming chat completion to succeed",
    );
    const body = await response.text();
    assert(
      body.includes('"finish_reason":"stop"'),
      `Expected SSE stream to emit a stop chunk after turn-ended, got ${JSON.stringify(body)}`,
    );
    assert(
      body.includes("data: [DONE]"),
      `Expected SSE stream to terminate after turn-ended, got ${JSON.stringify(body)}`,
    );

    await new Promise((resolve) => setTimeout(resolve, 5_500));
    assertEqual(
      backend.getBidiAppendCount(),
      1,
      "Expected proxy to stop heartbeats after receiving turn-ended",
    );
  } finally {
    modules.stopProxy();
    backend.setRunSSEMode("close-on-append");
  }

  console.log("[test] Turn-ended bridge shutdown OK");
}

async function testInteractionToolCallCompletesStreamingResponse(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing interaction-update MCP tool call handling...");

  try {
    backend.resetObservations();
    backend.setRunSSEMode("interaction-tool-call-pause");
    modules.stopProxy();
    const proxyPort = await modules.startProxy(async () => "test-token");
    const response = await fetch(
      `http://localhost:${proxyPort}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "composer-2",
          messages: [{ role: "user", content: "inspect the file" }],
        }),
      },
    );

    assertEqual(
      response.status,
      200,
      "Expected streaming chat completion to succeed",
    );
    const body = await response.text();
    assert(
      body.includes('"finish_reason":"tool_calls"'),
      `Expected SSE stream to emit tool_calls finish after interaction update, got ${JSON.stringify(body)}`,
    );
    assert(
      body.includes("data: [DONE]"),
      `Expected SSE stream to terminate after interaction update tool call, got ${JSON.stringify(body)}`,
    );
  } finally {
    modules.stopProxy();
    backend.setRunSSEMode("close-on-append");
  }

  console.log("[test] Interaction-update MCP tool call handling OK");
}

async function testSessionHeadersPreserveConversationState(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing session header conversation reuse...");

  try {
    backend.resetObservations();
    backend.setRunSSEMode("checkpoint-then-close");
    modules.stopProxy();
    const proxyPort = await modules.startProxy(async () => "test-token");
    const headers = {
      "Content-Type": "application/json",
      "x-opencode-session-id": "ses-test-shared",
    };

    const firstResponse = await fetch(
      `http://localhost:${proxyPort}/v1/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "composer-2",
          messages: [{ role: "user", content: "first prompt" }],
        }),
      },
    );
    assertEqual(
      firstResponse.status,
      200,
      "Expected first session request to succeed",
    );
    await firstResponse.text();

    const secondResponse = await fetch(
      `http://localhost:${proxyPort}/v1/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "composer-2",
          messages: [{ role: "user", content: "follow up only" }],
        }),
      },
    );
    assertEqual(
      secondResponse.status,
      200,
      "Expected follow-up session request to succeed",
    );
    await secondResponse.text();

    const observed = backend.getObservedRunRequests();
    assertEqual(
      observed.length,
      2,
      "Expected two observed Cursor run requests",
    );
    assertEqual(
      observed[1]?.conversationId,
      observed[0]?.conversationId,
      "Expected follow-up request to reuse the same Cursor conversation id",
    );
    assertEqual(
      observed[1]?.turnCount,
      1,
      "Expected follow-up request to reuse checkpointed conversation turns",
    );
    assertEqual(
      observed[1]?.latestUserText,
      "follow up only",
      "Expected latest user message to remain the new prompt",
    );
  } finally {
    modules.stopProxy();
    backend.setRunSSEMode("close-on-append");
  }

  console.log("[test] Session header conversation reuse OK");
}

async function testAgentScopedSessionIsolation(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing agent-scoped session isolation...");

  try {
    backend.resetObservations();
    backend.setRunSSEMode("checkpoint-then-close");
    modules.stopProxy();
    const proxyPort = await modules.startProxy(async () => "test-token");
    const buildHeaders = {
      "Content-Type": "application/json",
      "x-opencode-session-id": "ses-agent-shared",
      "x-opencode-agent": "build",
    };
    const titleHeaders = {
      "Content-Type": "application/json",
      "x-opencode-session-id": "ses-agent-shared",
      "x-opencode-agent": "title",
    };

    await fetch(`http://localhost:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers: buildHeaders,
      body: JSON.stringify({
        model: "composer-2",
        messages: [{ role: "user", content: "debug the plugin" }],
      }),
    }).then((response) => response.text());

    await fetch(`http://localhost:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers: titleHeaders,
      body: JSON.stringify({
        model: "composer-2",
        messages: [
          {
            role: "user",
            content: "Generate a title for this conversation:\n",
          },
          { role: "user", content: "generate a short title" },
        ],
      }),
    }).then((response) => response.text());

    await fetch(`http://localhost:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers: buildHeaders,
      body: JSON.stringify({
        model: "composer-2",
        messages: [{ role: "user", content: "continue the debugging" }],
      }),
    }).then((response) => response.text());

    const observed = backend.getObservedRunRequests();
    assertEqual(
      observed.length,
      2,
      "Expected only build-agent requests to use Cursor RunSSE",
    );
    const titleRequests = backend.getObservedNameAgentRequests();
    assertEqual(
      titleRequests.length,
      1,
      "Expected title agent request to use Cursor NameAgent",
    );
    assert(
      titleRequests[0]?.includes("generate a short title"),
      `Expected title agent naming request to include title source text, got ${JSON.stringify(titleRequests)}`,
    );
    assertEqual(
      observed[0]?.conversationId,
      observed[1]?.conversationId,
      "Expected build agent requests to keep sharing the same Cursor conversation id",
    );
    assertEqual(
      observed[1]?.turnCount,
      1,
      "Expected build agent follow-up to reuse its checkpointed conversation state",
    );
  } finally {
    modules.stopProxy();
    backend.setRunSSEMode("close-on-append");
  }

  console.log("[test] Agent-scoped session isolation OK");
}

async function testModelSwitchPreservesConversationState(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing model switch conversation reuse...");

  try {
    backend.resetObservations();
    backend.setRunSSEMode("checkpoint-then-close");
    modules.stopProxy();
    const proxyPort = await modules.startProxy(async () => "test-token");
    const headers = {
      "Content-Type": "application/json",
      "x-opencode-session-id": "ses-model-shared",
      "x-opencode-agent": "build",
    };

    await fetch(`http://localhost:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "composer-2",
        messages: [{ role: "user", content: "first model prompt" }],
      }),
    }).then((response) => response.text());

    await fetch(`http://localhost:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "composer-2-fast",
        messages: [{ role: "user", content: "follow up on the faster model" }],
      }),
    }).then((response) => response.text());

    const observed = backend.getObservedRunRequests();
    assertEqual(
      observed.length,
      2,
      "Expected two observed Cursor run requests",
    );
    assertEqual(
      observed[1]?.conversationId,
      observed[0]?.conversationId,
      "Expected model switch to preserve Cursor conversation id within the same session",
    );
    assertEqual(
      observed[1]?.turnCount,
      1,
      "Expected model switch follow-up to reuse checkpointed conversation turns",
    );
  } finally {
    modules.stopProxy();
    backend.setRunSSEMode("close-on-append");
  }

  console.log("[test] Model switch conversation reuse OK");
}

async function testProviderSwitchHistoryReconstruction(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing provider-switch history reconstruction...");

  try {
    backend.resetObservations();
    backend.setRunSSEMode("verbose-title-close");
    modules.stopProxy();
    const proxyPort = await modules.startProxy(async () => "test-token");

    const response = await fetch(
      `http://localhost:${proxyPort}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "composer-2",
          stream: false,
          messages: [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "inspect the config" },
            {
              role: "assistant",
              content: "I will inspect the config file.",
              tool_calls: [
                {
                  id: "call-read-1",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: JSON.stringify({ path: "opencode.json" }),
                  },
                },
              ],
            },
            {
              role: "tool",
              tool_call_id: "call-read-1",
              content: '{"model":"anthropic/claude-sonnet-4-5"}',
            },
            {
              role: "assistant",
              content: "The config currently uses an Anthropic model.",
            },
            { role: "user", content: "switch this session to cursor" },
          ],
        }),
      },
    );

    assertEqual(
      response.status,
      200,
      "Expected reconstructed provider-switch request to succeed",
    );
    const observed = backend.getObservedRunRequests();
    assertEqual(observed.length, 1, "Expected one observed Cursor run request");
    assertEqual(
      observed[0]?.turnCount,
      0,
      "Expected first Cursor handoff request to flatten prior history into the latest prompt instead of relying on Cursor replay turns",
    );
    assert(
      observed[0]?.latestUserText.includes("[OpenCode session handoff]"),
      `Expected latest user text to include a handoff transcript, got ${JSON.stringify(observed[0])}`,
    );
    assert(
      observed[0]?.latestUserText.includes("User: inspect the config"),
      `Expected latest user text to include the prior user prompt, got ${JSON.stringify(observed[0])}`,
    );
    assert(
      observed[0]?.latestUserText.includes(
        "Assistant: I will inspect the config file.",
      ),
      `Expected latest user text to include the prior assistant reply, got ${JSON.stringify(observed[0])}`,
    );
    assert(
      observed[0]?.latestUserText.includes(
        "[assistant requested tool read_file id=call-read-1]",
      ),
      `Expected reconstructed assistant history to include the prior tool call, got ${JSON.stringify(observed[0])}`,
    );
    assert(
      observed[0]?.latestUserText.includes("[tool result id=call-read-1]"),
      `Expected reconstructed assistant history to include the prior tool result, got ${JSON.stringify(observed[0])}`,
    );
    assert(
      observed[0]?.latestUserText.includes(
        "The config currently uses an Anthropic model.",
      ),
      `Expected reconstructed assistant history to preserve the prior assistant reply, got ${JSON.stringify(observed[0])}`,
    );
    assert(
      observed[0]?.latestUserText.includes(
        "Latest user message:\nswitch this session to cursor",
      ),
      `Expected latest user message to remain present at the end of the handoff prompt, got ${JSON.stringify(observed[0])}`,
    );
  } finally {
    modules.stopProxy();
  }

  console.log("[test] Provider-switch history reconstruction OK");
}

async function testPlainTextProviderSwitchHandoff(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing plain-text provider-switch handoff...");

  try {
    backend.resetObservations();
    backend.setRunSSEMode("close-on-append");
    modules.stopProxy();
    const proxyPort = await modules.startProxy(async () => "test-token");

    const response = await fetch(
      `http://localhost:${proxyPort}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "composer-2",
          stream: false,
          messages: [
            { role: "user", content: "Respond with Hi" },
            { role: "assistant", content: "Hi" },
            {
              role: "user",
              content: "What was the first prompt in this session?",
            },
          ],
        }),
      },
    );

    assertEqual(
      response.status,
      200,
      "Expected plain-text handoff request to succeed",
    );
    const observed = backend.getObservedRunRequests();
    assertEqual(observed.length, 1, "Expected one observed Cursor run request");
    assertEqual(
      observed[0]?.turnCount,
      0,
      "Expected plain-text handoff to flatten prior turns into the latest prompt",
    );
    assert(
      observed[0]?.latestUserText.includes("User: Respond with Hi"),
      `Expected handoff prompt to include the first user message, got ${JSON.stringify(observed[0])}`,
    );
    assert(
      observed[0]?.latestUserText.includes("Assistant: Hi"),
      `Expected handoff prompt to include the prior assistant reply, got ${JSON.stringify(observed[0])}`,
    );
    assert(
      observed[0]?.latestUserText.includes(
        "Latest user message:\nWhat was the first prompt in this session?",
      ),
      `Expected handoff prompt to end with the latest user message, got ${JSON.stringify(observed[0])}`,
    );
  } finally {
    modules.stopProxy();
  }

  console.log("[test] Plain-text provider-switch handoff OK");
}

async function testAssistantLastContinuationWithoutCheckpointFails(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log(
    "[test] Testing assistant-last continuation failure without checkpoint...",
  );

  try {
    backend.resetObservations();
    backend.setRunSSEMode("close-on-append");
    modules.stopProxy();
    const proxyPort = await modules.startProxy(async () => "test-token");

    const response = await fetch(
      `http://localhost:${proxyPort}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "composer-2",
          stream: false,
          messages: [
            { role: "user", content: "Please try out all the tools." },
            {
              role: "assistant",
              content: "Demonstrating each available tool with minimal, safe invocations.",
            },
          ],
        }),
      },
    );

    assertEqual(
      response.status,
      400,
      "Expected assistant-last continuation without checkpoint to fail",
    );
    const body = (await response.json()) as { error?: { message?: string } };
    const observed = backend.getObservedRunRequests();
    assertEqual(
      body.error?.message,
      "Assistant-last continuation is not supported by the Cursor provider",
      "Expected explicit assistant-last continuation error",
    );
    assertEqual(
      observed.length,
      0,
      "Expected no Cursor run request for unsupported assistant-last continuation",
    );
  } finally {
    modules.stopProxy();
  }

  console.log(
    "[test] Assistant-last continuation failure without checkpoint OK",
  );
}

async function testAssistantLastContinuationWithCheckpointFails(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing assistant-last continuation failure with checkpoint...");

  try {
    backend.resetObservations();
    backend.setRunSSEMode("checkpoint-then-close");
    modules.stopProxy();
    const proxyPort = await modules.startProxy(async () => "test-token");
    const headers = {
      "Content-Type": "application/json",
      "x-opencode-session-id": "ses-assistant-last",
    };

    const firstResponse = await fetch(
      `http://localhost:${proxyPort}/v1/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "composer-2",
          stream: false,
          messages: [{ role: "user", content: "Please try out all the tools." }],
        }),
      },
    );
    assertEqual(firstResponse.status, 200, "Expected initial request to succeed");

    backend.resetObservations();
    backend.setRunSSEMode("close-on-append");

    const secondResponse = await fetch(
      `http://localhost:${proxyPort}/v1/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "composer-2",
          stream: false,
          messages: [
            { role: "user", content: "Please try out all the tools." },
            {
              role: "assistant",
              content:
                "Demonstrating each available tool with minimal, safe invocations.",
            },
          ],
        }),
      },
    );
    assertEqual(
      secondResponse.status,
      400,
      "Expected assistant-last continuation with checkpoint to fail",
    );
    const body = (await secondResponse.json()) as {
      error?: { message?: string };
    };

    const observed = backend.getObservedRunRequests();
    assertEqual(
      body.error?.message,
      "Assistant-last continuation is not supported by the Cursor provider",
      "Expected explicit assistant-last continuation error even with checkpoint",
    );
    assertEqual(
      observed.length,
      0,
      "Expected no Cursor run request when assistant-last continuation is rejected",
    );
  } finally {
    modules.stopProxy();
    backend.setRunSSEMode("close-on-append");
  }

  console.log("[test] Assistant-last continuation failure with checkpoint OK");
}

async function testSystemPromptForwardedToCursorRunRequest(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing source-backed title-agent naming RPC...");

  try {
    backend.resetObservations();
    backend.setRunSSEMode("close-on-append");
    modules.stopProxy();
    const proxyPort = await modules.startProxy(async () => "test-token");

    const response = await fetch(
      `http://localhost:${proxyPort}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-opencode-session-id": "ses-title-agent",
        },
        body: JSON.stringify({
          model: "composer-2",
          stream: false,
          messages: [
            {
              role: "system",
              content:
                "You are a title generator. You output ONLY a thread title. Nothing else.",
            },
            {
              role: "user",
              content: "Generate a title for this conversation:\n",
            },
            {
              role: "user",
              content: "What determines fish prices in Tokyo markets?",
            },
          ],
        }),
      },
    );

    assertEqual(response.status, 200, "Expected title-like request to succeed");
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    assertEqual(
      body.choices?.[0]?.message?.content,
      "Fish Price Question",
      "Expected title request to use Cursor's naming RPC response",
    );
    const observed = backend.getObservedRunRequests();
    assertEqual(
      observed.length,
      0,
      "Expected title request marker to bypass Cursor RunSSE chat requests",
    );
    const nameRequests = backend.getObservedNameAgentRequests();
    assertEqual(
      nameRequests.length,
      1,
      "Expected one observed NameAgent request",
    );
    assert(
      !nameRequests[0]?.includes("Generate a title for this conversation:"),
      `Expected NameAgent request to omit the OpenCode title marker, got ${JSON.stringify(nameRequests)}`,
    );
    assert(
      nameRequests[0]?.includes(
        "What determines fish prices in Tokyo markets?",
      ),
      `Expected NameAgent request to include the title source text, got ${JSON.stringify(nameRequests)}`,
    );
  } finally {
    modules.stopProxy();
    backend.setRunSSEMode("close-on-append");
  }

  console.log("[test] Source-backed title-agent naming RPC OK");
}

async function testPendingToolResultResumeAcrossModelSwitch(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log(
    "[test] Testing pending tool result resume across model switch...",
  );

  try {
    backend.resetObservations();
    backend.setRunSSEMode("tool-call-pause");
    modules.stopProxy();
    const proxyPort = await modules.startProxy(async () => "test-token");
    const headers = {
      "Content-Type": "application/json",
      "x-opencode-session-id": "ses-pending-tool",
      "x-opencode-agent": "build",
    };

    const firstResponse = await fetch(
      `http://localhost:${proxyPort}/v1/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "composer-2",
          messages: [
            { role: "user", content: "use a tool to inspect the file" },
          ],
        }),
      },
    );
    assertEqual(
      firstResponse.status,
      200,
      "Expected initial tool-call request to succeed",
    );
    const firstBody = await firstResponse.text();
    assert(
      firstBody.includes('"finish_reason":"tool_calls"'),
      `Expected initial response to pause for tool calls, got ${JSON.stringify(firstBody)}`,
    );

    const secondResponse = await fetch(
      `http://localhost:${proxyPort}/v1/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "composer-2-fast",
          messages: [
            { role: "user", content: "use a tool to inspect the file" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: JSON.stringify({ path: "src/index.ts" }),
                  },
                },
              ],
            },
            {
              role: "tool",
              tool_call_id: "call-1",
              content: "file contents",
            },
          ],
        }),
      },
    );
    assertEqual(
      secondResponse.status,
      200,
      "Expected resumed request to succeed after model switch",
    );
    const secondBody = await secondResponse.text();
    assert(
      secondBody.includes("data: [DONE]"),
      `Expected resumed stream to terminate cleanly, got ${JSON.stringify(secondBody)}`,
    );

    const observed = backend.getObservedRunRequests();
    assertEqual(
      observed.length,
      1,
      "Expected tool result continuation to resume the existing Cursor bridge instead of starting a new run request",
    );
  } finally {
    modules.stopProxy();
    backend.setRunSSEMode("close-on-append");
  }

  console.log("[test] Pending tool result resume across model switch OK");
}

async function testUnsupportedExecFailsFast(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing unsupported exec fast failure...");

  try {
    backend.resetObservations();
    backend.setRunSSEMode("unsupported-exec-pause");
    modules.stopProxy();
    const proxyPort = await modules.startProxy(async () => "test-token");
    const response = await fetch(
      `http://localhost:${proxyPort}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "composer-2",
          messages: [{ role: "user", content: "hello" }],
        }),
      },
    );

    assertEqual(
      response.status,
      200,
      "Expected streaming chat completion headers to be accepted before stream failure",
    );

    const settled = await Promise.race([
      response
        .text()
        .then(() => "resolved")
        .catch(() => "rejected"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 1_500)),
    ]);

    assert(
      settled !== "timeout",
      "Expected unsupported exec stream to fail fast instead of hanging",
    );
  } finally {
    modules.stopProxy();
    backend.setRunSSEMode("close-on-append");
  }

  console.log("[test] Unsupported exec fast failure OK");
}

async function testUnsupportedInteractionQueryFailsFast(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing unsupported interaction query fast failure...");

  try {
    backend.resetObservations();
    backend.setRunSSEMode("unsupported-interaction-query-pause");
    modules.stopProxy();
    const proxyPort = await modules.startProxy(async () => "test-token");
    const response = await fetch(
      `http://localhost:${proxyPort}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "composer-2",
          messages: [{ role: "user", content: "hello" }],
        }),
      },
    );

    assertEqual(
      response.status,
      200,
      "Expected streaming chat completion headers to be accepted before stream failure",
    );

    const settled = await Promise.race([
      response
        .text()
        .then(() => "resolved")
        .catch(() => "rejected"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 1_500)),
    ]);

    assert(
      settled !== "timeout",
      "Expected unsupported interaction query stream to fail fast instead of hanging",
    );
  } finally {
    modules.stopProxy();
    backend.setRunSSEMode("close-on-append");
  }

  console.log("[test] Unsupported interaction query fast failure OK");
}

async function main() {
  const backend = await createTestCursorBackend();
  process.env.CURSOR_API_URL = backend.apiUrl;
  process.env.CURSOR_REFRESH_URL = backend.refreshUrl;

  const modules = await loadModules();

  try {
    await testProxyStartStop(modules);
    await testAuthParams(modules);
    await testTokenExpiry(modules);
    await testPluginShape(modules);
    await testPluginLogging(modules);
    await testHttp2UnaryRpc(modules);
    await testArrayContentParsing(modules);
    await testSessionHeadersPreserveConversationState(modules, backend);
    await testAgentScopedSessionIsolation(modules, backend);
    await testModelSwitchPreservesConversationState(modules, backend);
    await testProviderSwitchHistoryReconstruction(modules, backend);
    await testPlainTextProviderSwitchHandoff(modules, backend);
    await testAssistantLastContinuationWithoutCheckpointFails(
      modules,
      backend,
    );
    await testAssistantLastContinuationWithCheckpointFails(modules, backend);
    await testSystemPromptForwardedToCursorRunRequest(modules, backend);
    await testPendingToolResultResumeAcrossModelSwitch(modules, backend);
    await testUnsupportedExecFailsFast(modules, backend);
    await testUnsupportedInteractionQueryFailsFast(modules, backend);
    await testEndStreamStopsHeartbeats(modules, backend);
    await testTurnEndedStopsStreamingResponse(modules, backend);
    await testInteractionToolCallCompletesStreamingResponse(modules, backend);
    await testExpiredTokenRefreshBeforeDiscovery(modules, backend);
    await testDiscoveryFailureAndSuccess(modules, backend);
    console.log("\n✓ All smoke tests passed");
    process.exitCode = 0;
  } catch (err) {
    console.error("\n✗ Smoke test failed:", err);
    process.exitCode = 1;
  } finally {
    modules.stopProxy();
    const forcedExit = setTimeout(() => {
      console.warn("[test] Cleanup timed out, forcing process exit");
      process.exit(process.exitCode ?? 1);
    }, 1_000);
    forcedExit.unref?.();
    try {
      await backend.close();
    } finally {
      clearTimeout(forcedExit);
    }
    process.exit(process.exitCode ?? 1);
  }
}

main();
