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
type RunMode =
  | "close-on-append"
  | "end-stream-hold"
  | "interaction-tool-call-pause"
  | "interaction-native-tool-complete"
  | "turn-ended-hold"
  | "checkpoint-then-close"
  | "tool-call-pause"
  | "unsupported-setup-vm-query-pause"
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
  createCursorSession: typeof import("../src/cursor").createCursorSession;
  processServerMessage: typeof import("../src/proxy/stream-dispatch").processServerMessage;
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
  setRunMode: (mode: RunMode) => void;
  resetObservations: () => void;
  getDiscoveryAuthHeaders: () => string[];
  getDiscoveryRequestBodies: () => Uint8Array[];
  getRefreshAuthHeaders: () => string[];
  getRunMessageCount: () => number;
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

function decodeConnectMessagePayloads(payload: Uint8Array): Uint8Array[] {
  const messages: Uint8Array[] = [];
  let offset = 0;

  while (offset + 5 <= payload.length) {
    const messageLength = new DataView(
      payload.buffer,
      payload.byteOffset + offset,
      payload.byteLength - offset,
    ).getUint32(1, false);
    const frameEnd = offset + 5 + messageLength;
    if (frameEnd > payload.length) {
      throw new Error("Invalid Connect frame payload");
    }
    messages.push(payload.subarray(offset + 5, frameEnd));
    offset = frameEnd;
  }

  if (offset !== payload.length) {
    throw new Error("Trailing bytes after Connect frame payload");
  }

  return messages;
}

function decodeObservedRunRequest(
  payload: Uint8Array,
): ObservedRunRequest | null {
  const clientMessage = fromBinary(AgentClientMessageSchema, payload);
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

function makeInteractionNativeToolCallCompletedFrame(): Buffer {
  const serverMessage = create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: {
        message: {
          case: "toolCallCompleted",
          value: {
            callId: "native-call-1",
            modelCallId: "native-model-call-1",
            toolCall: {
              tool: {
                case: "globToolCall",
                value: {
                  args: new Uint8Array(),
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
          case: "setupVmEnvironmentArgs",
          value: {
            installCommand: "npm install",
            startCommand: "npm run dev",
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
  let runMode: RunMode = "close-on-append";
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
  let runMessageCount = 0;

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

  let activeRunStream: http2.ServerHttp2Stream | null = null;
  let activeRunBuffer = Buffer.alloc(0);
  let activeRunCloseTimer: NodeJS.Timeout | undefined;
  let toolCallIssued = false;

  const clearActiveRunCloseTimer = () => {
    if (!activeRunCloseTimer) return;
    clearTimeout(activeRunCloseTimer);
    activeRunCloseTimer = undefined;
  };

  const endActiveRunStream = () => {
    clearActiveRunCloseTimer();
    try {
      activeRunStream?.end();
    } catch {}
    activeRunStream = null;
    activeRunBuffer = Buffer.alloc(0);
  };

  const writeRunFrame = (frame: Buffer) => {
    if (!activeRunStream) return;
    activeRunStream.write(frame);
  };

  const handleRunMessage = (payload: Uint8Array) => {
    runMessageCount += 1;
    const observed = decodeObservedRunRequest(payload);
    if (observed) observedRunRequests.push(observed);
    if (!activeRunStream) return;

    if (runMode === "close-on-append") {
      endActiveRunStream();
    } else if (runMode === "end-stream-hold" && runMessageCount === 1) {
      writeRunFrame(frameConnectEndStreamMessage(new TextEncoder().encode("{}")));
      activeRunCloseTimer = setTimeout(endActiveRunStream, 6_100);
    } else if (runMode === "checkpoint-then-close") {
      writeRunFrame(makeCheckpointUpdateFrame());
      endActiveRunStream();
    } else if (runMode === "interaction-tool-call-pause") {
      writeRunFrame(makeInteractionToolCallCompletedFrame());
    } else if (runMode === "interaction-native-tool-complete") {
      writeRunFrame(makeTextDeltaFrame("native tool update ignored"));
      writeRunFrame(makeInteractionNativeToolCallCompletedFrame());
      writeRunFrame(makeTurnEndedFrame());
    } else if (runMode === "unsupported-setup-vm-query-pause") {
      writeRunFrame(makeUnsupportedInteractionQueryFrame());
    } else if (runMode === "turn-ended-hold") {
      writeRunFrame(makeTextDeltaFrame("completed response"));
      writeRunFrame(makeTurnEndedFrame());
    } else if (runMode === "verbose-title-close") {
      writeRunFrame(
        makeTextDeltaFrame(
          "# That depends on which fish you're looking for! If you're referring to the famous 1998 techno hit ...",
        ),
      );
      endActiveRunStream();
    } else if (runMode === "tool-call-pause") {
      if (!toolCallIssued) {
        toolCallIssued = true;
        writeRunFrame(makeToolCallFrame());
      } else {
        toolCallIssued = false;
        endActiveRunStream();
      }
    } else if (runMode === "unsupported-exec-pause") {
      writeRunFrame(makeUnsupportedExecFrame());
      activeRunCloseTimer = setTimeout(endActiveRunStream, 2_000);
    }
  };

  const appendRunData = (incoming: Buffer) => {
    activeRunBuffer = Buffer.concat([activeRunBuffer, incoming]);
    while (activeRunBuffer.length >= 5) {
      const frameLength = activeRunBuffer.readUInt32BE(1);
      if (activeRunBuffer.length < 5 + frameLength) break;
      const payload = activeRunBuffer.subarray(5, 5 + frameLength);
      activeRunBuffer = activeRunBuffer.subarray(5 + frameLength);
      handleRunMessage(new Uint8Array(payload));
    }
  };

  const readHeaderValue = (value: string | string[] | undefined): string =>
    Array.isArray(value) ? value[0] ?? "" : (value ?? "");

  const apiServer = http2.createServer();
  apiServer.on("stream", (stream: http2.ServerHttp2Stream, headers) => {
    const method = readHeaderValue(headers[":method"] as string | string[] | undefined);
    const path = readHeaderValue(headers[":path"] as string | string[] | undefined);
    const authHeader = readHeaderValue(headers.authorization);

    if (method !== "POST") {
      stream.respond({ ":status": 404 });
      stream.end();
      return;
    }

    if (path === "/agent.v1.AgentService/Run") {
      clearActiveRunCloseTimer();
      activeRunStream = stream;
      activeRunBuffer = Buffer.alloc(0);
      stream.respond({
        ":status": 200,
        "content-type": "application/connect+proto",
      });
      stream.on("data", (chunk) => {
        appendRunData(Buffer.from(chunk));
      });
      stream.once("close", () => {
        if (activeRunStream === stream) {
          clearActiveRunCloseTimer();
          activeRunStream = null;
          activeRunBuffer = Buffer.alloc(0);
        }
      });
      return;
    }

    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    stream.once("end", () => {
      if (path === "/agent.v1.AgentService/GetUsableModels") {
        discoveryAuthHeaders.push(authHeader);
        discoveryRequestBodies.push(new Uint8Array(Buffer.concat(chunks)));

        if (discoveryMode === "auth-error") {
          stream.respond({ ":status": 401, "content-type": "application/json" });
          stream.end(
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
        stream.respond({
          ":status": 200,
          "content-type": "application/connect+proto",
        });
        stream.end(Buffer.from(responseBody));
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
        stream.respond({
          ":status": 200,
          "content-type": "application/connect+proto",
        });
        stream.end(Buffer.from(responseBody));
        return;
      }

      stream.respond({ ":status": 404 });
      stream.end();
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
    setRunMode(mode) {
      runMode = mode;
    },
    resetObservations() {
      discoveryAuthHeaders.length = 0;
      discoveryRequestBodies.length = 0;
      refreshAuthHeaders.length = 0;
      observedRunRequests.length = 0;
      observedNameAgentRequests.length = 0;
      runMessageCount = 0;
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
    getRunMessageCount() {
      return runMessageCount;
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
      clearActiveRunCloseTimer();
      try {
        activeRunStream?.close();
      } catch {}
      for (const server of [apiServer, refreshServer]) {
        const closable = server as any;
        try {
          closable.closeIdleConnections?.();
        } catch {}
        try {
          closable.closeAllConnections?.();
        } catch {}
        try {
          server.close();
        } catch {}
      }
    },
  };
}

async function loadModules(): Promise<TestModules> {
  const cursor = await import("../src/cursor");
  const proxy = await import("../src/proxy");
  const streamDispatch = await import("../src/proxy/stream-dispatch");
  const auth = await import("../src/auth");
  const index = await import("../src/index");
  const logger = await import("../src/logger");
  const models = await import("../src/models");
  return {
    startProxy: proxy.startProxy,
    stopProxy: proxy.stopProxy,
    getProxyPort: proxy.getProxyPort,
    callCursorUnaryRpc: proxy.callCursorUnaryRpc,
    createCursorSession: cursor.createCursorSession,
    processServerMessage: streamDispatch.processServerMessage,
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

async function testRejectedChatCompletionLogging(modules: TestModules) {
  console.log("[test] Testing rejected chat completion logging...");

  const logEntries: any[] = [];
  modules.configurePluginLogger({
    directory: "/tmp/opencode-cursor-rejected-log-test",
    client: {
      app: {
        log: async (entry: any) => {
          logEntries.push(entry);
          return true;
        },
      },
    },
  } as any);

  const port = await modules.startProxy(async () => "test-token");
  try {
    const response = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "composer-2",
        stream: false,
        messages: [{ role: "assistant", content: "partial answer" }],
      }),
    });

    assertEqual(
      response.status,
      400,
      "Expected invalid assistant-only request to be rejected",
    );
    await modules.flushPluginLogs();

    const rejectedLog = logEntries.find(
      (entry) => entry?.body?.message === "Rejected Cursor chat completion",
    );
    assert(rejectedLog, "Expected rejected chat completion log entry");
    assertEqual(
      rejectedLog?.body?.extra?.status,
      400,
      "Expected rejected request log to include status",
    );
    assert(
      String(rejectedLog?.body?.extra?.requestBodyText).includes(
        "partial answer",
      ),
      `Expected rejected request log to include raw request body, got ${JSON.stringify(rejectedLog)}`,
    );
    assert(
      String(rejectedLog?.body?.extra?.responseBody).includes(
        "No user message found",
      ),
      `Expected rejected request log to include raw response body, got ${JSON.stringify(rejectedLog)}`,
    );
  } finally {
    modules.stopProxy();
  }

  console.log("[test] Rejected chat completion logging OK");
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

async function testHttp2BidiSessionTransport(modules: TestModules) {
  console.log("[test] Testing HTTP/2 bidi Cursor transport...");

  let observedHeaders: http2.IncomingHttpHeaders | undefined;
  let observedFrames: Uint8Array[] = [];
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const serverResponse = frameConnectUnaryMessage(new Uint8Array([4, 5, 6]));

  const server = http2.createServer();
  server.on("stream", (stream: http2.ServerHttp2Stream, headers) => {
    observedHeaders = headers;
    const chunks: Buffer[] = [];

    stream.respond({
      ":status": 200,
      "content-type": "application/connect+proto",
    });
    stream.write(serverResponse);
    stream.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    stream.once("close", () => {
      observedFrames = decodeConnectMessagePayloads(
        new Uint8Array(Buffer.concat(chunks)),
      );
      resolveClosed?.();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const session = await modules.createCursorSession({
      accessToken: "test-access-token",
      initialRequestBytes: new Uint8Array([1, 2, 3]),
      url: `http://127.0.0.1:${port}`,
    });

    const responseChunks: Buffer[] = [];
    session.onData((chunk) => {
      responseChunks.push(Buffer.from(chunk));
    });

    session.write(new Uint8Array([9, 8, 7]));
    await new Promise((resolve) => setTimeout(resolve, 25));
    session.end();
    await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("HTTP/2 bidi session did not close")), 1_000),
      ),
    ]);

    assertEqual(
      observedHeaders?.[":path"],
      "/agent.v1.AgentService/Run",
      "Expected HTTP/2 bidi run path",
    );
    assertEqual(
      observedHeaders?.["connect-protocol-version"],
      "1",
      "Expected Connect protocol version header on bidi transport",
    );
    assertEqual(
      observedHeaders?.["content-type"],
      "application/connect+proto",
      "Expected Connect streaming content type on bidi transport",
    );
    assertEqual(
      observedHeaders?.authorization,
      "Bearer test-access-token",
      "Expected bearer token auth on bidi transport",
    );
    assertEqual(
      observedFrames.length,
      2,
      "Expected initial and follow-up Connect request messages",
    );
    assertArrayEqual(
      [...observedFrames[0]!].map(String),
      ["1", "2", "3"],
      "Expected initial request message to be framed and forwarded",
    );
    assertArrayEqual(
      [...observedFrames[1]!].map(String),
      ["9", "8", "7"],
      "Expected follow-up request message to use the same HTTP/2 stream",
    );
    assertArrayEqual(
      [...Buffer.concat(responseChunks)].map(String),
      [...serverResponse].map(String),
      "Expected bidi transport to surface streamed server frames",
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  console.log("[test] HTTP/2 bidi Cursor transport OK");
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
    backend.setRunMode("end-stream-hold");
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
      backend.getRunMessageCount(),
      1,
      "Expected proxy to stop heartbeats after receiving Connect end-stream",
    );
  } finally {
    modules.stopProxy();
    backend.setRunMode("close-on-append");
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
    backend.setRunMode("turn-ended-hold");
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
      backend.getRunMessageCount(),
      1,
      "Expected proxy to stop heartbeats after receiving turn-ended",
    );
  } finally {
    modules.stopProxy();
    backend.setRunMode("close-on-append");
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
    backend.setRunMode("interaction-tool-call-pause");
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
    backend.setRunMode("close-on-append");
  }

  console.log("[test] Interaction-update MCP tool call handling OK");
}

async function testNativeInteractionToolCallCompletedDoesNotAbort(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing native interaction tool completion is ignored...");

  try {
    backend.resetObservations();
    backend.setRunMode("interaction-native-tool-complete");
    modules.stopProxy();
    const proxyPort = await modules.startProxy(async () => "test-token");
    const response = await fetch(
      `http://localhost:${proxyPort}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-session-id": "ses-native-tool" },
        body: JSON.stringify({
          model: "composer-2",
          messages: [{ role: "user", content: "look around the repo" }],
        }),
      },
    );

    assertEqual(
      response.status,
      200,
      "Expected streaming chat completion with native interaction tool completion to succeed",
    );
    const body = await response.text();
    assert(
      body.includes("native tool update ignored"),
      `Expected streamed text to survive native tool completion update, got ${JSON.stringify(body)}`,
    );
    assert(
      body.includes('"finish_reason":"stop"'),
      `Expected stream to complete normally after native tool completion update, got ${JSON.stringify(body)}`,
    );
    assert(
      body.includes("data: [DONE]"),
      `Expected native tool completion update flow to terminate cleanly, got ${JSON.stringify(body)}`,
    );

    const observed = backend.getObservedRunRequests();
    assertEqual(
      observed.length,
      1,
      "Expected native interaction tool completion update not to trigger a retry request",
    );
  } finally {
    modules.stopProxy();
    backend.setRunMode("close-on-append");
  }

  console.log("[test] Native interaction tool completion ignore OK");
}

async function testSessionHeadersPreserveConversationState(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing session header conversation reuse...");

  try {
    backend.resetObservations();
    backend.setRunMode("checkpoint-then-close");
    modules.stopProxy();
    const proxyPort = await modules.startProxy(async () => "test-token");
    const headers = {
      "Content-Type": "application/json",
      "x-session-id": "ses-test-shared",
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
    backend.setRunMode("close-on-append");
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
    backend.setRunMode("checkpoint-then-close");
    modules.stopProxy();
    const proxyPort = await modules.startProxy(async () => "test-token");
    const buildHeaders = {
      "Content-Type": "application/json",
      "x-session-id": "ses-agent-shared",
      "x-opencode-agent": "build",
    };
    const titleHeaders = {
      "Content-Type": "application/json",
      "x-session-id": "ses-agent-shared",
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
    backend.setRunMode("close-on-append");
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
    backend.setRunMode("checkpoint-then-close");
    modules.stopProxy();
    const proxyPort = await modules.startProxy(async () => "test-token");
    const headers = {
      "Content-Type": "application/json",
      "x-session-id": "ses-model-shared",
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
    backend.setRunMode("close-on-append");
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
    backend.setRunMode("verbose-title-close");
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
    backend.setRunMode("close-on-append");
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

async function testAssistantLastContinuationWithoutCheckpointUsesGenericHandling(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log(
    "[test] Testing assistant-last continuation generic handling without checkpoint...",
  );

  try {
    backend.resetObservations();
    backend.setRunMode("close-on-append");
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
      200,
      "Expected assistant-last continuation without checkpoint to use generic request handling",
    );
    await response.json();
    const observed = backend.getObservedRunRequests();
    assertEqual(
      observed.length,
      1,
      "Expected assistant-last continuation to produce one Cursor run request",
    );
    assert(
      observed[0]?.latestUserText.includes("Please try out all the tools."),
      `Expected request to include the user message, got ${JSON.stringify(observed[0])}`,
    );
    assert(
      observed[0]?.latestUserText.includes(
        "Demonstrating each available tool with minimal, safe invocations.",
      ),
      `Expected request to include the pending assistant content, got ${JSON.stringify(observed[0])}`,
    );
  } finally {
    modules.stopProxy();
  }

  console.log(
    "[test] Assistant-last continuation generic handling without checkpoint OK",
  );
}

async function testAssistantLastContinuationWithCheckpointUsesGenericHandling(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing assistant-last continuation generic handling with checkpoint...");

  try {
    backend.resetObservations();
    backend.setRunMode("checkpoint-then-close");
    modules.stopProxy();
    const proxyPort = await modules.startProxy(async () => "test-token");
    const headers = {
      "Content-Type": "application/json",
      "x-session-id": "ses-assistant-last",
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
    backend.setRunMode("close-on-append");

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
      200,
      "Expected assistant-last continuation with checkpoint to use generic request handling",
    );
    await secondResponse.json();

    const observed = backend.getObservedRunRequests();
    assertEqual(
      observed.length,
      1,
      "Expected assistant-last continuation with checkpoint to produce one Cursor run request",
    );
    assert(
      observed[0]?.latestUserText.includes(
        "Demonstrating each available tool with minimal, safe invocations.",
      ),
      `Expected resumed generic request to include the pending assistant content, got ${JSON.stringify(observed[0])}`,
    );
  } finally {
    modules.stopProxy();
    backend.setRunMode("close-on-append");
  }

  console.log("[test] Assistant-last continuation generic handling with checkpoint OK");
}

async function testSystemPromptForwardedToCursorRunRequest(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing source-backed title-agent naming RPC...");

  try {
    backend.resetObservations();
    backend.setRunMode("close-on-append");
    modules.stopProxy();
    const proxyPort = await modules.startProxy(async () => "test-token");

    const response = await fetch(
      `http://localhost:${proxyPort}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-session-id": "ses-title-agent",
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
    backend.setRunMode("close-on-append");
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
    backend.setRunMode("tool-call-pause");
    modules.stopProxy();
    const proxyPort = await modules.startProxy(async () => "test-token");
    const headers = {
      "Content-Type": "application/json",
      "x-session-id": "ses-pending-tool",
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
    backend.setRunMode("close-on-append");
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
    backend.setRunMode("unsupported-exec-pause");
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
      response.text().then((body) => ({ kind: "resolved", body })),
      new Promise<{ kind: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), 1_500),
      ),
    ]);

    assert(
      settled.kind !== "timeout",
      "Expected unsupported exec stream to fail fast instead of hanging",
    );
    assert(
      settled.kind === "resolved" &&
        settled.body.includes(
          '"error":{"message":"Cursor requested unsupported exec type: undefined"',
        ),
      `Expected unsupported exec stream to surface an explicit SSE error, got ${JSON.stringify(settled)}`,
    );
  } finally {
    modules.stopProxy();
    backend.setRunMode("close-on-append");
  }

  console.log("[test] Unsupported exec fast failure OK");
}

async function testHandledInteractionQueriesProduceClientResponses(
  modules: TestModules,
) {
  console.log("[test] Testing handled interaction query responses...");

  const buildState = () => ({
    toolCallIndex: 0,
    pendingExecs: [],
    outputTokens: 0,
    totalTokens: 0,
    interactionToolArgsText: new Map(),
    emittedToolCallIds: new Set(),
  });

  const sentFrames: Uint8Array[] = [];
  const unsupported: Array<{ category: string; caseName: string }> = [];

  const assertInteractionResponse = (
    expectedId: number,
    expectedCase: string,
  ): any => {
    const payload = sentFrames[sentFrames.length - 1];
    assert(payload, "Expected an interaction response frame to be sent");
    const clientMessage = fromBinary(AgentClientMessageSchema, payload) as any;
    assertEqual(
      clientMessage.message.case,
      "interactionResponse",
      "Expected an interaction response client message",
    );
    assertEqual(
      clientMessage.message.value.id,
      expectedId,
      "Expected interaction response ID to match the query ID",
    );
    assertEqual(
      clientMessage.message.value.result.case,
      expectedCase,
      "Expected interaction response case to match the handled query",
    );
    return clientMessage.message.value.result.value;
  };

  const processInteractionQuery = (id: number, queryCase: string, value: any) => {
    const serverMessage = create(AgentServerMessageSchema, {
      message: {
        case: "interactionQuery",
        value: {
          id,
          query: {
            case: queryCase,
            value,
          },
        } as any,
      },
    });

    modules.processServerMessage(
      serverMessage,
      new Map(),
      [],
      (data) => sentFrames.push(data),
      buildState() as any,
      () => {},
      () => {},
      undefined,
      undefined,
      (info) => unsupported.push(info as any),
    );
  };

  processInteractionQuery(11, "webSearchRequestQuery", {
    args: { searchTerm: "opencode", toolCallId: "web-1" },
  });
  const webSearchResponse = assertInteractionResponse(11, "webSearchRequestResponse");
  assertEqual(
    webSearchResponse.result.case,
    "rejected",
    "Expected web search request to be rejected back to MCP",
  );
  assert(
    webSearchResponse.result.value.reason.includes("websearch"),
    `Expected web search rejection reason to mention MCP websearch, got ${JSON.stringify(webSearchResponse)}`,
  );

  processInteractionQuery(12, "askQuestionInteractionQuery", {
    toolCallId: "question-1",
    args: {
      title: "Pick an option",
      questions: [
        {
          id: "q1",
          prompt: "Proceed?",
          options: [{ id: "yes", label: "Yes" }],
          allowMultiple: false,
        },
      ],
      runAsync: false,
      asyncOriginalToolCallId: "",
    },
  });
  const askQuestionResponse = assertInteractionResponse(
    12,
    "askQuestionInteractionResponse",
  );
  assertEqual(
    askQuestionResponse.result.result.case,
    "rejected",
    "Expected ask-question interaction to be rejected back to MCP",
  );
  assert(
    askQuestionResponse.result.result.value.reason.includes("question"),
    `Expected ask-question rejection reason to mention MCP question, got ${JSON.stringify(askQuestionResponse)}`,
  );

  processInteractionQuery(13, "switchModeRequestQuery", {
    args: {
      targetModeId: "plan",
      explanation: "Need planning",
      toolCallId: "switch-1",
    },
  });
  const switchModeResponse = assertInteractionResponse(
    13,
    "switchModeRequestResponse",
  );
  assertEqual(
    switchModeResponse.result.case,
    "rejected",
    "Expected switch-mode interaction to be rejected",
  );

  processInteractionQuery(14, "exaSearchRequestQuery", {
    args: { query: "opencode", type: "auto", numResults: 5, toolCallId: "exa-1" },
  });
  const exaSearchResponse = assertInteractionResponse(
    14,
    "exaSearchRequestResponse",
  );
  assertEqual(
    exaSearchResponse.result.case,
    "rejected",
    "Expected Exa search interaction to be rejected back to MCP",
  );
  assert(
    exaSearchResponse.result.value.reason.includes("websearch"),
    `Expected Exa search rejection reason to mention MCP websearch, got ${JSON.stringify(exaSearchResponse)}`,
  );

  processInteractionQuery(15, "exaFetchRequestQuery", {
    args: { ids: ["doc-1"], toolCallId: "exafetch-1" },
  });
  const exaFetchResponse = assertInteractionResponse(
    15,
    "exaFetchRequestResponse",
  );
  assertEqual(
    exaFetchResponse.result.case,
    "rejected",
    "Expected Exa fetch interaction to be rejected back to MCP",
  );
  assert(
    exaFetchResponse.result.value.reason.includes("webfetch"),
    `Expected Exa fetch rejection reason to mention MCP tools, got ${JSON.stringify(exaFetchResponse)}`,
  );

  processInteractionQuery(16, "createPlanRequestQuery", {
    toolCallId: "plan-1",
    args: {
      plan: "Outline the work",
      todos: [],
      overview: "overview",
      name: "plan",
      isProject: false,
      phases: [],
    },
  });
  const createPlanResponse = assertInteractionResponse(
    16,
    "createPlanRequestResponse",
  );
  assertEqual(
    createPlanResponse.result.result.case,
    "error",
    "Expected create-plan interaction to return an error response",
  );
  assert(
    createPlanResponse.result.result.value.error.includes("planning tools"),
    `Expected create-plan error to explain the MCP fallback, got ${JSON.stringify(createPlanResponse)}`,
  );

  processInteractionQuery(17, "setupVmEnvironmentArgs", {
    installCommand: "npm install",
    startCommand: "npm run dev",
  });
  assertEqual(
    sentFrames.length,
    6,
    "Expected setup VM query to remain unsupported and not send a response",
  );
  assertEqual(
    unsupported.length,
    1,
    "Expected exactly one unsupported interaction query callback",
  );
  assertEqual(
    unsupported[0]?.caseName,
    "setupVmEnvironmentArgs",
    "Expected setup VM interaction query to remain unsupported",
  );

  console.log("[test] Handled interaction query responses OK");
}

async function testExecMcpArgsPreferredOverInteractionToolCompletion(
  modules: TestModules,
) {
  console.log("[test] Testing exec MCP args win over duplicate interaction tool completions...");

  const state = {
    toolCallIndex: 0,
    pendingExecs: [],
    outputTokens: 0,
    totalTokens: 0,
    interactionToolArgsText: new Map(),
    emittedToolCallIds: new Set(),
  };
  const observedExecs: Array<{ execId: string; execMsgId: number }> = [];

  const processServerMessage = (message: any) => {
    modules.processServerMessage(
      message,
      new Map(),
      [],
      () => {},
      state as any,
      () => {},
      (exec) => observedExecs.push({ execId: exec.execId, execMsgId: exec.execMsgId }),
    );
  };

  processServerMessage(
    create(AgentServerMessageSchema, {
      message: {
        case: "interactionUpdate",
        value: {
          message: {
            case: "toolCallCompleted",
            value: {
              callId: "call-dup",
              modelCallId: "model-call-dup",
              toolCall: {
                tool: {
                  case: "mcpToolCall",
                  value: {
                    args: {
                      name: "bash",
                      toolName: "bash",
                      toolCallId: "call-dup",
                      providerIdentifier: "opencode",
                      args: {
                        command: toBinary(
                          ValueSchema,
                          fromJson(ValueSchema, 'echo "opencode_bash_ok"'),
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
    }),
  );

  processServerMessage(
    create(AgentServerMessageSchema, {
      message: {
        case: "execServerMessage",
        value: create(ExecServerMessageSchema, {
          id: 42,
          execId: "exec-dup",
          message: {
            case: "mcpArgs",
            value: create(McpArgsSchema, {
              name: "bash",
              toolName: "bash",
              toolCallId: "call-dup",
              providerIdentifier: "opencode",
              args: {
                command: toBinary(
                  ValueSchema,
                  fromJson(ValueSchema, 'echo "opencode_bash_ok"'),
                ),
              },
            }),
          },
        }),
      },
    }),
  );

  assertEqual(
    observedExecs.length,
    1,
    "Expected interaction-side MCP completion to emit the first tool call immediately",
  );
  assertEqual(
    observedExecs[0]?.execMsgId,
    0,
    "Expected interaction-side MCP completion to emit provisional exec metadata before mcpArgs arrives",
  );

  assertEqual(
    state.emittedToolCallIds.size,
    1,
    "Expected duplicate interaction and exec MCP tool events to surface only one tool call",
  );
  assertEqual(
    observedExecs.length,
    1,
    "Expected later execServerMessage metadata upgrade to avoid emitting a second tool call",
  );
  assertEqual(
    (state.pendingExecs as Array<{ execId: string }>)[0]?.execId,
    "exec-dup",
    "Expected the actionable execServerMessage metadata to win when both Cursor channels report the same tool call",
  );
  assertEqual(
    (state.pendingExecs as Array<{ execMsgId: number }>)[0]?.execMsgId,
    42,
    "Expected the actionable execServerMessage id to be preserved for tool result resume",
  );
  assertEqual(
    state.pendingExecs.length,
    1,
    "Expected pending exec state to retain only one actionable MCP exec",
  );

  console.log("[test] Exec MCP args preference over duplicate interaction completions OK");
}

async function testInteractionToolCompletionDoesNotDowngradeExecMetadata(
  modules: TestModules,
) {
  console.log("[test] Testing interaction duplicate does not downgrade exec metadata...");

  const state = {
    toolCallIndex: 0,
    pendingExecs: [],
    outputTokens: 0,
    totalTokens: 0,
    interactionToolArgsText: new Map(),
    emittedToolCallIds: new Set(),
  };
  const observedExecs: Array<{ execId: string; execMsgId: number }> = [];

  const processServerMessage = (message: any) => {
    modules.processServerMessage(
      message,
      new Map(),
      [],
      () => {},
      state as any,
      () => {},
      (exec) => observedExecs.push({ execId: exec.execId, execMsgId: exec.execMsgId }),
    );
  };

  processServerMessage(
    create(AgentServerMessageSchema, {
      message: {
        case: "execServerMessage",
        value: create(ExecServerMessageSchema, {
          id: 42,
          execId: "exec-dup",
          message: {
            case: "mcpArgs",
            value: create(McpArgsSchema, {
              name: "bash",
              toolName: "bash",
              toolCallId: "call-dup",
              providerIdentifier: "opencode",
              args: {
                command: toBinary(
                  ValueSchema,
                  fromJson(ValueSchema, 'echo "opencode_bash_ok"'),
                ),
              },
            }),
          },
        }),
      },
    }),
  );

  processServerMessage(
    create(AgentServerMessageSchema, {
      message: {
        case: "interactionUpdate",
        value: {
          message: {
            case: "toolCallCompleted",
            value: {
              callId: "call-dup",
              modelCallId: "model-call-dup",
              toolCall: {
                tool: {
                  case: "mcpToolCall",
                  value: {
                    args: {
                      name: "bash",
                      toolName: "bash",
                      toolCallId: "call-dup",
                      providerIdentifier: "opencode",
                      args: {
                        command: toBinary(
                          ValueSchema,
                          fromJson(ValueSchema, 'echo "opencode_bash_ok"'),
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
    }),
  );

  assertEqual(
    observedExecs.length,
    1,
    "Expected execServerMessage-first MCP tool flow to emit only one tool call",
  );
  assertEqual(
    (state.pendingExecs as Array<{ execId: string }>)[0]?.execId,
    "exec-dup",
    "Expected later interaction duplicate to preserve authoritative exec id",
  );
  assertEqual(
    (state.pendingExecs as Array<{ execMsgId: number }>)[0]?.execMsgId,
    42,
    "Expected later interaction duplicate to preserve authoritative exec message id",
  );

  console.log("[test] Interaction duplicate does not downgrade exec metadata OK");
}

async function testUnsupportedSetupVmInteractionQueryFailsFast(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing unsupported setup VM interaction query fast failure...");

  try {
    backend.resetObservations();
    backend.setRunMode("unsupported-setup-vm-query-pause");
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
      response.text().then((body) => ({ kind: "resolved", body })),
      new Promise<{ kind: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), 1_500),
      ),
    ]);

    assert(
      settled.kind !== "timeout",
      "Expected unsupported setup VM interaction query stream to fail fast instead of hanging",
    );
    assert(
      settled.kind === "resolved" &&
        settled.body.includes(
          '"error":{"message":"Cursor returned unsupported interactionQuery: setupVmEnvironmentArgs"',
        ),
      `Expected unsupported setup VM interaction query stream to surface an explicit SSE error, got ${JSON.stringify(settled)}`,
    );
  } finally {
    modules.stopProxy();
    backend.setRunMode("close-on-append");
  }

  console.log("[test] Unsupported setup VM interaction query fast failure OK");
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
    await testRejectedChatCompletionLogging(modules);
    await testHttp2UnaryRpc(modules);
    await testHttp2BidiSessionTransport(modules);
    await testArrayContentParsing(modules);
    await testSessionHeadersPreserveConversationState(modules, backend);
    await testAgentScopedSessionIsolation(modules, backend);
    await testModelSwitchPreservesConversationState(modules, backend);
    await testProviderSwitchHistoryReconstruction(modules, backend);
    await testPlainTextProviderSwitchHandoff(modules, backend);
    await testAssistantLastContinuationWithoutCheckpointUsesGenericHandling(
      modules,
      backend,
    );
    await testAssistantLastContinuationWithCheckpointUsesGenericHandling(
      modules,
      backend,
    );
    await testSystemPromptForwardedToCursorRunRequest(modules, backend);
    await testPendingToolResultResumeAcrossModelSwitch(modules, backend);
    await testUnsupportedExecFailsFast(modules, backend);
    await testHandledInteractionQueriesProduceClientResponses(modules);
    await testExecMcpArgsPreferredOverInteractionToolCompletion(modules);
    await testInteractionToolCompletionDoesNotDowngradeExecMetadata(modules);
    await testUnsupportedSetupVmInteractionQueryFailsFast(modules, backend);
    await testEndStreamStopsHeartbeats(modules, backend);
    await testTurnEndedStopsStreamingResponse(modules, backend);
    await testInteractionToolCallCompletesStreamingResponse(modules, backend);
    await testNativeInteractionToolCallCompletedDoesNotAbort(modules, backend);
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
