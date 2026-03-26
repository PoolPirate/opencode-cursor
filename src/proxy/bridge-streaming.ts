import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ExecClientMessageSchema,
  McpErrorSchema,
  McpResultSchema,
  McpSuccessSchema,
  McpTextContentSchema,
  McpToolResultContentItemSchema,
  type McpToolDefinition,
} from "../proto/agent_pb";
import type { CursorSession } from "../cursor/bidi-session";
import { errorDetails, logPluginError, logPluginWarn } from "../logger";
import {
  formatToolCallSummary,
  formatToolResultSummary,
  type ToolResultInfo,
} from "../openai/messages";
import {
  activeBridges,
  updateStoredConversationAfterCompletion,
} from "./conversation-state";
import type { ConversationRequestMetadata } from "./conversation-meta";
import { startBridge } from "./bridge-session";
import {
  updateConversationCheckpoint,
  syncStoredBlobStore,
} from "./state-sync";
import { SSE_HEADERS } from "./sse";
import type { StreamState } from "./stream-state";
import type { ActiveBridge, CursorRequestPayload } from "./types";
import {
  computeUsage,
  createConnectFrameParser,
  createThinkingTagFilter,
  parseConnectEndStream,
  processServerMessage,
  scheduleBridgeEnd,
} from "./stream-dispatch";

const SSE_KEEPALIVE_INTERVAL_MS = 15_000;

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
  let keepaliveTimer: NodeJS.Timeout | undefined;

  const stopKeepalive = () => {
    if (!keepaliveTimer) return;
    clearInterval(keepaliveTimer);
    keepaliveTimer = undefined;
  };

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const state: StreamState = {
        toolCallIndex: 0,
        pendingExecs: [],
        outputTokens: 0,
        totalTokens: 0,
        interactionToolArgsText: new Map(),
        emittedToolCallIds: new Set(),
      };
      const tagFilter = createThinkingTagFilter();
      let assistantText = metadata.assistantSeedText ?? "";
      let mcpExecReceived = false;
      let endStreamError: Error | null = null;

      const sendSSE = (data: object) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };
      const sendKeepalive = () => {
        if (closed) return;
        controller.enqueue(encoder.encode(": keep-alive\n\n"));
      };
      const sendDone = () => {
        if (closed) return;
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      };
      const failStream = (message: string, code?: string) => {
        if (closed) return;
        sendSSE({
          error: {
            message,
            type: "server_error",
            ...(code ? { code } : {}),
          },
        });
        sendDone();
        closeController();
      };
      const closeController = () => {
        if (closed) return;
        closed = true;
        stopKeepalive();
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
        const { prompt_tokens, completion_tokens, total_tokens } =
          computeUsage(state);
        return {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: modelId,
          choices: [],
          usage: { prompt_tokens, completion_tokens, total_tokens },
        };
      };

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
                  return;
                }

                const { content, reasoning } = tagFilter.process(text);
                if (reasoning)
                  sendSSE(makeChunk({ reasoning_content: reasoning }));
                if (content) {
                  assistantText += content;
                  sendSSE(makeChunk({ content }));
                }
              },
              (exec) => {
                state.pendingExecs.push(exec);
                mcpExecReceived = true;

                const flushed = tagFilter.flush();
                if (flushed.reasoning)
                  sendSSE(makeChunk({ reasoning_content: flushed.reasoning }));
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
                ]
                  .filter(Boolean)
                  .join("\n\n");

                sendSSE(
                  makeChunk({
                    tool_calls: [
                      {
                        index: state.toolCallIndex++,
                        id: exec.toolCallId,
                        type: "function",
                        function: {
                          name: exec.toolName,
                          arguments: exec.decodedArgs,
                        },
                      },
                    ],
                  }),
                );

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
              (checkpointBytes) =>
                updateConversationCheckpoint(convKey, checkpointBytes),
              () => scheduleBridgeEnd(bridge),
              (info) => {
                endStreamError = new Error(
                  `Cursor returned unsupported ${info.category}: ${info.caseName}${info.detail ? ` (${info.detail})` : ""}`,
                );
                logPluginError("Closing Cursor bridge after unsupported message", {
                  modelId,
                  bridgeKey,
                  convKey,
                  category: info.category,
                  caseName: info.caseName,
                  detail: info.detail,
                });
                scheduleBridgeEnd(bridge);
              },
              (info) => {
                endStreamError = new Error(
                  `Cursor requested unsupported exec type: ${info.execCase}`,
                );
                logPluginError("Closing Cursor bridge after unsupported exec", {
                  modelId,
                  bridgeKey,
                  convKey,
                  execCase: info.execCase,
                  execId: info.execId,
                  execMsgId: info.execMsgId,
                });
                scheduleBridgeEnd(bridge);
              },
            );
          } catch {
            // Skip unparseable messages.
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

      keepaliveTimer = setInterval(() => {
        try {
          sendKeepalive();
        } catch (error) {
          logPluginWarn("Failed to write SSE keepalive", {
            modelId,
            bridgeKey,
            convKey,
            ...errorDetails(error),
          });
          stopKeepalive();
        }
      }, SSE_KEEPALIVE_INTERVAL_MS);

      bridge.onData(processChunk);
      bridge.onClose((code) => {
        clearInterval(heartbeatTimer);
        stopKeepalive();
        syncStoredBlobStore(convKey, blobStore);

        if (endStreamError) {
          activeBridges.delete(bridgeKey);
          failStream(endStreamError.message, "cursor_bridge_closed");
          return;
        }

        if (!mcpExecReceived) {
          const flushed = tagFilter.flush();
          if (flushed.reasoning)
            sendSSE(makeChunk({ reasoning_content: flushed.reasoning }));
          if (flushed.content) {
            assistantText += flushed.content;
            sendSSE(makeChunk({ content: flushed.content }));
          }

          updateStoredConversationAfterCompletion(
            convKey,
            metadata,
            assistantText,
          );
          sendSSE(makeChunk({}, "stop"));
          sendSSE(makeUsageChunk());
          sendDone();
          closeController();
          return;
        }

        activeBridges.delete(bridgeKey);
        if (code !== 0 && !closed) {
          failStream("Cursor bridge connection lost", "cursor_bridge_closed");
        }
      });
    },
    cancel(reason) {
      stopKeepalive();
      clearInterval(heartbeatTimer);
      syncStoredBlobStore(convKey, blobStore);
      const active = activeBridges.get(bridgeKey);
      if (active?.bridge === bridge) {
        activeBridges.delete(bridgeKey);
      }
      logPluginWarn("OpenCode client disconnected from Cursor SSE stream", {
        modelId,
        bridgeKey,
        convKey,
        reason: reason instanceof Error ? reason.message : String(reason ?? ""),
      });
      bridge.end();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

export async function handleStreamingResponse(
  payload: CursorRequestPayload,
  accessToken: string,
  modelId: string,
  bridgeKey: string,
  convKey: string,
  metadata: ConversationRequestMetadata,
): Promise<Response> {
  const { bridge, heartbeatTimer } = await startBridge(
    accessToken,
    payload.requestBytes,
  );
  return createBridgeStreamResponse(
    bridge,
    heartbeatTimer,
    payload.blobStore,
    payload.mcpTools,
    modelId,
    bridgeKey,
    convKey,
    metadata,
  );
}

export function handleToolResultResume(
  active: ActiveBridge,
  toolResults: ToolResultInfo[],
  bridgeKey: string,
  convKey: string,
): Response {
  const {
    bridge,
    heartbeatTimer,
    blobStore,
    mcpTools,
    pendingExecs,
    modelId,
    metadata,
  } = active;
  const resumeMetadata: ConversationRequestMetadata = {
    ...metadata,
    assistantSeedText: [
      metadata.assistantSeedText?.trim() ?? "",
      toolResults.map(formatToolResultSummary).join("\n\n"),
    ]
      .filter(Boolean)
      .join("\n\n"),
  };

  for (const exec of pendingExecs) {
    const result = toolResults.find(
      (toolResult) => toolResult.toolCallId === exec.toolCallId,
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
                    value: create(McpTextContentSchema, {
                      text: result.content,
                    }),
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
            value: create(McpErrorSchema, {
              error: "Tool result not provided",
            }),
          },
        });

    const execClientMessage = create(ExecClientMessageSchema, {
      id: exec.execMsgId,
      execId: exec.execId,
      message: {
        case: "mcpResult" as const,
        value: mcpResult,
      },
    });
    const clientMessage = create(AgentClientMessageSchema, {
      message: { case: "execClientMessage", value: execClientMessage },
    });

    bridge.write(toBinary(AgentClientMessageSchema, clientMessage));
  }

  return createBridgeStreamResponse(
    bridge,
    heartbeatTimer,
    blobStore,
    mcpTools,
    modelId,
    bridgeKey,
    convKey,
    resumeMetadata,
  );
}
