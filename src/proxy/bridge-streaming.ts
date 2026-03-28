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
import {
  errorDetails,
  logPluginError,
  logPluginInfo,
  logPluginWarn,
} from "../logger";
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
  type McpToolCallUpdateInfo,
  parseConnectEndStream,
  processServerMessage,
  scheduleBridgeEnd,
} from "./stream-dispatch";
import { createBridgeCloseController } from "./bridge-close-controller";

const SSE_KEEPALIVE_INTERVAL_MS = 15_000;
const MCP_TOOL_BATCH_WINDOW_MS = 150;
const MCP_TOOL_METADATA_GRACE_MS = 1_500;

function createBridgeStreamResponse(
  bridge: CursorSession,
  heartbeatTimer: NodeJS.Timeout,
  blobStore: Map<string, Uint8Array>,
  cloudRule: string | undefined,
  mcpTools: McpToolDefinition[],
  modelId: string,
  bridgeKey: string,
  convKey: string,
  metadata: ConversationRequestMetadata,
): Response {
  const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 28)}`;
  const created = Math.floor(Date.now() / 1000);
  let keepaliveTimer: NodeJS.Timeout | undefined;
  let toolCallFlushTimer: NodeJS.Timeout | undefined;
  const bridgeCloseController = createBridgeCloseController(bridge);

  const stopKeepalive = () => {
    if (!keepaliveTimer) return;
    clearInterval(keepaliveTimer);
    keepaliveTimer = undefined;
  };
  const stopToolCallFlushTimer = () => {
    if (!toolCallFlushTimer) return;
    clearTimeout(toolCallFlushTimer);
    toolCallFlushTimer = undefined;
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
      };
      const tagFilter = createThinkingTagFilter();
      let assistantText = metadata.assistantSeedText ?? "";
      let mcpExecReceived = false;
      let endStreamError: Error | null = null;
      let toolCallsFlushed = false;
      const announcedToolCallIds = new Set<string>();
      let toolCallMetadataDeadlineMs = 0;

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
        stopToolCallFlushTimer();
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
      const getMissingAnnouncedToolCallIds = () => {
        const pendingExecIds = new Set(
          state.pendingExecs.map((exec) => exec.toolCallId),
        );
        return [...announcedToolCallIds].filter(
          (toolCallId) => !pendingExecIds.has(toolCallId),
        );
      };
      const publishPendingToolCalls = () => {
        if (closed || toolCallsFlushed || state.pendingExecs.length === 0) return;

        const missingAnnouncedToolCallIds = getMissingAnnouncedToolCallIds();
        if (
          missingAnnouncedToolCallIds.length > 0 &&
          Date.now() < toolCallMetadataDeadlineMs
        ) {
          schedulePendingToolCallPublish();
          return;
        }

        toolCallsFlushed = true;
        stopToolCallFlushTimer();

        if (missingAnnouncedToolCallIds.length > 0) {
          logPluginError(
            "Aborting Cursor stream because announced MCP tool calls never received exec metadata",
            {
              modelId,
              bridgeKey,
              convKey,
              pendingExecToolCallIds: state.pendingExecs.map(
                (exec) => exec.toolCallId,
              ),
              missingAnnouncedToolCallIds,
            },
          );
          clearInterval(heartbeatTimer);
          bridge.end();
          failStream(
            `Cursor announced MCP tool calls without matching exec metadata: ${missingAnnouncedToolCallIds.join(", ")}`,
            "cursor_mcp_tool_mismatch",
          );
          return;
        }

        const flushed = tagFilter.flush();
        if (flushed.reasoning)
          sendSSE(makeChunk({ reasoning_content: flushed.reasoning }));
        if (flushed.content) {
          assistantText += flushed.content;
          sendSSE(makeChunk({ content: flushed.content }));
        }

        const toolCalls = state.pendingExecs.map((exec) => ({
          index: state.toolCallIndex++,
          id: exec.toolCallId,
          type: "function" as const,
          function: {
            name: exec.toolName,
            arguments: exec.decodedArgs,
          },
        }));
        const assistantSeedText = [
          assistantText.trim(),
          toolCalls.map(formatToolCallSummary).join("\n\n"),
        ]
          .filter(Boolean)
          .join("\n\n");

        sendSSE(makeChunk({ tool_calls: toolCalls }));

        activeBridges.set(bridgeKey, {
          bridge,
          heartbeatTimer,
          blobStore,
          cloudRule,
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
      };
      const schedulePendingToolCallPublish = () => {
        if (toolCallsFlushed) return;
        stopToolCallFlushTimer();
        toolCallFlushTimer = setTimeout(
          publishPendingToolCalls,
          MCP_TOOL_BATCH_WINDOW_MS,
        );
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
              cloudRule,
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
                announcedToolCallIds.add(exec.toolCallId);
                const existingIndex = state.pendingExecs.findIndex(
                  (candidate) => candidate.toolCallId === exec.toolCallId,
                );
                if (existingIndex >= 0) {
                  state.pendingExecs[existingIndex] = exec;
                } else {
                  state.pendingExecs.push(exec);
                }
                mcpExecReceived = true;
                toolCallMetadataDeadlineMs =
                  Date.now() + MCP_TOOL_METADATA_GRACE_MS;

                schedulePendingToolCallPublish();
              },
              (info: McpToolCallUpdateInfo) => {
                if (info.updateCase === "toolCallCompleted") {
                  announcedToolCallIds.delete(info.toolCallId);
                } else {
                  announcedToolCallIds.add(info.toolCallId);
                }

                if (mcpExecReceived) {
                  schedulePendingToolCallPublish();
                }
              },
              (checkpointBytes) => {
                updateConversationCheckpoint(convKey, checkpointBytes);
                bridgeCloseController.noteCheckpoint();
              },
              () => bridgeCloseController.noteTurnEnded(),
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

      logPluginInfo("Opened Cursor streaming bridge", {
        modelId,
        bridgeKey,
        convKey,
        mcpToolCount: mcpTools.length,
        hasCloudRule: Boolean(cloudRule),
      });

      bridge.onData(processChunk);
      bridge.onClose((code) => {
        logPluginInfo("Cursor streaming bridge closed", {
          modelId,
          bridgeKey,
          convKey,
          code,
          mcpExecReceived,
          hadEndStreamError: Boolean(endStreamError),
        });
        bridgeCloseController.dispose();
        clearInterval(heartbeatTimer);
        stopKeepalive();
        stopToolCallFlushTimer();
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
      bridgeCloseController.dispose();
      stopKeepalive();
      stopToolCallFlushTimer();
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
  logPluginInfo("Starting Cursor streaming response", {
    modelId,
    bridgeKey,
    convKey,
    mcpToolCount: payload.mcpTools.length,
  });
  const { bridge, heartbeatTimer } = await startBridge(
    accessToken,
    payload.requestBytes,
  );
  return createBridgeStreamResponse(
    bridge,
    heartbeatTimer,
    payload.blobStore,
    payload.cloudRule,
    payload.mcpTools,
    modelId,
    bridgeKey,
    convKey,
    metadata,
  );
}

async function waitForResolvablePendingExecs(
  active: ActiveBridge,
  toolResults: ToolResultInfo[],
  timeoutMs = 2_000,
): Promise<typeof active.pendingExecs> {
  const pendingToolCallIds = new Set(toolResults.map((result) => result.toolCallId));
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const unresolved = active.pendingExecs.filter(
      (exec) => pendingToolCallIds.has(exec.toolCallId) && exec.execMsgId === 0,
    );
    if (unresolved.length === 0) {
      return unresolved;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const unresolved = active.pendingExecs.filter(
    (exec) => pendingToolCallIds.has(exec.toolCallId) && exec.execMsgId === 0,
  );
  if (unresolved.length > 0) {
    logPluginWarn("Cursor exec metadata did not arrive before tool-result resume", {
      bridgeToolCallIds: unresolved.map((exec) => exec.toolCallId),
      modelId: active.modelId,
    });
  }

  return unresolved;
}

export async function handleToolResultResume(
  active: ActiveBridge,
  toolResults: ToolResultInfo[],
  bridgeKey: string,
  convKey: string,
): Promise<Response> {
  const {
    bridge,
    heartbeatTimer,
    blobStore,
    cloudRule,
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
  const pendingToolCallIds = new Set(pendingExecs.map((exec) => exec.toolCallId));
  const toolResultIds = new Set(toolResults.map((result) => result.toolCallId));
  const missingToolResultIds = pendingExecs
    .map((exec) => exec.toolCallId)
    .filter((toolCallId) => !toolResultIds.has(toolCallId));
  const unexpectedToolResultIds = toolResults
    .map((result) => result.toolCallId)
    .filter((toolCallId) => !pendingToolCallIds.has(toolCallId));
  const matchedPendingExecs = pendingExecs.filter((exec) =>
    toolResultIds.has(exec.toolCallId),
  );

  logPluginInfo("Preparing Cursor tool-result resume", {
    bridgeKey,
    convKey,
    modelId,
    toolResults,
    pendingExecs,
  });

  const unresolved = await waitForResolvablePendingExecs(active, toolResults);

  logPluginInfo("Resolved pending exec state before Cursor tool-result resume", {
    bridgeKey,
    convKey,
    modelId,
    toolResults,
    pendingExecs,
    unresolvedPendingExecs: unresolved,
  });

  if (unresolved.length > 0) {
    clearInterval(heartbeatTimer);
    bridge.end();
    return new Response(
      JSON.stringify({
        error: {
          message:
            "Cursor requested a tool call but never provided resumable exec metadata. Aborting instead of retrying with synthetic ids.",
          type: "invalid_request_error",
          code: "cursor_missing_exec_metadata",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (missingToolResultIds.length > 0 || unexpectedToolResultIds.length > 0) {
    logPluginError("Aborting Cursor tool-result resume because tool-call ids did not match", {
      bridgeKey,
      convKey,
      modelId,
      pendingToolCallIds: [...pendingToolCallIds],
      toolResultIds: [...toolResultIds],
      missingToolResultIds,
      unexpectedToolResultIds,
    });
    clearInterval(heartbeatTimer);
    bridge.end();
    return new Response(
      JSON.stringify({
        error: {
          message:
            "Tool-result ids did not match the active Cursor MCP tool calls. Aborting instead of resuming a potentially stuck session.",
          type: "invalid_request_error",
          code: "cursor_tool_result_mismatch",
          details: {
            missingToolResultIds,
            unexpectedToolResultIds,
          },
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  for (const exec of matchedPendingExecs) {
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

    logPluginInfo("Sending Cursor tool-result resume message", {
      bridgeKey,
      convKey,
      modelId,
      toolCallId: exec.toolCallId,
      toolName: exec.toolName,
      source: exec.source,
      execId: exec.execId,
      execMsgId: exec.execMsgId,
      cursorCallId: exec.cursorCallId,
      modelCallId: exec.modelCallId,
      matchedToolResult: result,
    });

    bridge.write(toBinary(AgentClientMessageSchema, clientMessage));
  }

  return createBridgeStreamResponse(
    bridge,
    heartbeatTimer,
    blobStore,
    cloudRule,
    mcpTools,
    modelId,
    bridgeKey,
    convKey,
    resumeMetadata,
  );
}
