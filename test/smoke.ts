import http from "node:http";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  GetUsableModelsResponseSchema,
  ModelDetailsSchema,
} from "../src/proto/agent_pb";

type DiscoveryMode = "success" | "empty" | "auth-error";
type RunSSEMode = "close-on-append" | "end-stream-hold";

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
  setDiscoveredModels: (models: Array<{ id: string; name: string; reasoning?: boolean }>) => void;
  setRunSSEMode: (mode: RunSSEMode) => void;
  resetObservations: () => void;
  getDiscoveryAuthHeaders: () => string[];
  getDiscoveryRequestBodies: () => Uint8Array[];
  getRefreshAuthHeaders: () => string[];
  getBidiAppendCount: () => number;
  close: () => Promise<void>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
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

async function createTestCursorBackend(): Promise<TestCursorBackend> {
  let discoveryMode: DiscoveryMode = "success";
  let runSSEMode: RunSSEMode = "close-on-append";
  let discoveredModels: Array<{ id: string; name: string; reasoning?: boolean }> = [
    { id: "composer-2", name: "Composer 2", reasoning: true },
  ];
  const discoveryAuthHeaders: string[] = [];
  const discoveryRequestBodies: Uint8Array[] = [];
  const refreshAuthHeaders: string[] = [];
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
  await new Promise<void>((resolve) => refreshServer.listen(0, "127.0.0.1", resolve));
  const refreshPort = (refreshServer.address() as AddressInfo).port;

  let pendingRunSSE: http.ServerResponse | null = null;

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
          res.end(JSON.stringify({ code: "unauthenticated", message: "expired token" }));
          return;
        }

        const responseBody = discoveryMode === "empty"
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
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.flushHeaders();
        return;
      }

      if (path === "/aiserver.v1.BidiService/BidiAppend") {
        bidiAppendCount += 1;
        res.writeHead(200, { "Content-Type": "application/proto" });
        res.end();

        if (runSSEMode === "close-on-append" && pendingRunSSE) {
          pendingRunSSE.end();
          pendingRunSSE = null;
        } else if (runSSEMode === "end-stream-hold" && pendingRunSSE && bidiAppendCount === 1) {
          pendingRunSSE.write(frameConnectEndStreamMessage(new TextEncoder().encode("{}")));
          setTimeout(() => {
            try {
              pendingRunSSE?.end();
            } catch {}
            pendingRunSSE = null;
          }, 6_100);
        }
        return;
      }

      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
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
      bidiAppendCount = 0;
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
    async close() {
      await Promise.all([
        new Promise<void>((resolve, reject) =>
          apiServer.close((error) => (error ? reject(error) : resolve())),
        ),
        new Promise<void>((resolve, reject) =>
          refreshServer.close((error) => (error ? reject(error) : resolve())),
        ),
      ]);
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

  assertEqual(logEntries.length, 1, "Expected one forwarded OpenCode log entry");
  assertEqual(logEntries[0]?.body?.service, "opencode-cursor-oauth", "Expected plugin log service name");
  assertEqual(logEntries[0]?.body?.level, "error", "Expected error log level");
  assertEqual(logEntries[0]?.body?.message, "Logger smoke test", "Expected forwarded log message");
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
    throw new Error(`Expected empty model list data array, got ${JSON.stringify(modelsBody.data)}`);
  }
  console.log("[test] /v1/models OK");

  const badRes = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "test", messages: [] }),
  });
  if (badRes.status !== 400) {
    throw new Error(`Expected 400 for missing user message, got ${badRes.status}`);
  }
  const badBody = await badRes.json();
  if (!badBody.error?.message?.includes("No user message")) {
    throw new Error(`Expected 'No user message' error, got: ${badBody.error?.message}`);
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

  if (!params.verifier || !params.challenge || !params.uuid || !params.loginUrl) {
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
    throw new Error(`Token expiry ${expiry} out of expected range [${expectedMin}, ${expectedMax}]`);
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
    throw new Error(`Expected method type 'oauth', got '${hooks.auth.methods[0].type}'`);
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
      throw new Error(
        "Array content not normalized — plan mode messages lost",
      );
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
  const writes: Array<{ access: string; refresh: string; expires: number }> = [];
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
    backend.getDiscoveryAuthHeaders().every((header) => header === `Bearer ${writes[0]?.access}`),
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
  const toasts: Array<{ title?: string; message: string; variant: string }> = [];
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
  const degradedResponse = await degradedConfig.fetch("http://localhost/unused");
  assertEqual(degradedResponse.status, 503, "Expected disabled config fetch to fail cleanly");
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
  assertEqual(toasts.length, 1, "Expected exactly one toast for discovery failure");
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
  assertEqual(discoveredModelsRes.status, 200, "Expected discovered /v1/models to succeed");
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
    const response = await fetch(`http://localhost:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "composer-2",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assertEqual(response.status, 200, "Expected streaming chat completion to succeed");
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
    await testEndStreamStopsHeartbeats(modules, backend);
    await testExpiredTokenRefreshBeforeDiscovery(modules, backend);
    await testDiscoveryFailureAndSuccess(modules, backend);
    console.log("\n✓ All smoke tests passed");
    process.exitCode = 0;
  } catch (err) {
    console.error("\n✗ Smoke test failed:", err);
    process.exitCode = 1;
  } finally {
    modules.stopProxy();
    await backend.close();
  }
}

main();
