import { fromBinary } from "@bufbuild/protobuf";
import { AgentServerMessageSchema } from "../proto/agent_pb";
import { errorDetails, logPluginError } from "../logger";
import type { OpenAIToolCall } from "../openai/types";
import { updateStoredConversationAfterCompletion } from "./conversation-state";
import type { ConversationRequestMetadata } from "./conversation-meta";
import { startBridge } from "./bridge-session";
import {
  updateConversationCheckpoint,
  syncStoredBlobStore,
} from "./state-sync";
import type { StreamState } from "./stream-state";
import type { CursorRequestPayload } from "./types";
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

const MCP_TOOL_BATCH_WINDOW_MS = 150;
const MCP_TOOL_METADATA_GRACE_MS = 1_500;

interface CollectedResponse {
  text: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  finishReason: "stop" | "tool_calls";
  toolCalls: OpenAIToolCall[];
}

export async function handleNonStreamingResponse(
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

  const message =
    finishReason === "tool_calls"
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

async function collectFullResponse(
  payload: CursorRequestPayload,
  accessToken: string,
  modelId: string,
  convKey: string,
  metadata: ConversationRequestMetadata,
): Promise<CollectedResponse> {
  const { promise, resolve, reject } =
    Promise.withResolvers<CollectedResponse>();
  let fullText = "";
  let endStreamError: Error | null = null;
  const pendingToolCalls: OpenAIToolCall[] = [];
  let toolCallEndTimer: NodeJS.Timeout | undefined;
  const announcedToolCallIds = new Set<string>();
  let toolCallMetadataDeadlineMs = 0;

  const { bridge, heartbeatTimer } = await startBridge(
    accessToken,
    payload.requestBytes,
  );
  const bridgeCloseController = createBridgeCloseController(bridge);
  const stopToolCallEndTimer = () => {
    if (!toolCallEndTimer) return;
    clearTimeout(toolCallEndTimer);
    toolCallEndTimer = undefined;
  };
  const getMissingAnnouncedToolCallIds = () => {
    const pendingExecIds = new Set(pendingToolCalls.map((call) => call.id));
    return [...announcedToolCallIds].filter(
      (toolCallId) => !pendingExecIds.has(toolCallId),
    );
  };
  const scheduleToolCallBridgeEnd = () => {
    stopToolCallEndTimer();
    toolCallEndTimer = setTimeout(
      () => {
        const missingAnnouncedToolCallIds = getMissingAnnouncedToolCallIds();
        if (
          missingAnnouncedToolCallIds.length > 0 &&
          Date.now() < toolCallMetadataDeadlineMs
        ) {
          scheduleToolCallBridgeEnd();
          return;
        }

        if (missingAnnouncedToolCallIds.length > 0) {
          endStreamError = new Error(
            `Cursor announced MCP tool calls without matching exec metadata: ${missingAnnouncedToolCallIds.join(", ")}`,
          );
          logPluginError(
            "Aborting non-streaming Cursor response because announced MCP tool calls never received exec metadata",
            {
              modelId,
              convKey,
              pendingExecToolCallIds: pendingToolCalls.map((call) => call.id),
              missingAnnouncedToolCallIds,
            },
          );
          scheduleBridgeEnd(bridge);
          return;
        }

        scheduleBridgeEnd(bridge);
      },
      MCP_TOOL_BATCH_WINDOW_MS,
    );
  };
  const state: StreamState = {
    toolCallIndex: 0,
    pendingExecs: [],
    outputTokens: 0,
    totalTokens: 0,
  };
  const tagFilter = createThinkingTagFilter();

  bridge.onData(
    createConnectFrameParser(
      (messageBytes) => {
        try {
          const serverMessage = fromBinary(
            AgentServerMessageSchema,
            messageBytes,
          );
          processServerMessage(
            serverMessage,
            payload.blobStore,
            payload.cloudRule,
            payload.mcpTools,
            (data) => bridge.write(data),
            state,
            (text, isThinking) => {
              if (isThinking) return;
              const { content } = tagFilter.process(text);
              fullText += content;
            },
            (exec) => {
              announcedToolCallIds.add(exec.toolCallId);
              const toolCall = {
                id: exec.toolCallId,
                type: "function" as const,
                function: {
                  name: exec.toolName,
                  arguments: exec.decodedArgs,
                },
              };
              const existingIndex = pendingToolCalls.findIndex(
                (call) => call.id === exec.toolCallId,
              );
              if (existingIndex >= 0) {
                pendingToolCalls[existingIndex] = toolCall;
              } else {
                pendingToolCalls.push(toolCall);
              }
              toolCallMetadataDeadlineMs =
                Date.now() + MCP_TOOL_METADATA_GRACE_MS;
              scheduleToolCallBridgeEnd();
            },
            (info: McpToolCallUpdateInfo) => {
              if (info.updateCase === "toolCallCompleted") {
                announcedToolCallIds.delete(info.toolCallId);
              } else {
                announcedToolCallIds.add(info.toolCallId);
              }

              if (pendingToolCalls.length > 0) {
                scheduleToolCallBridgeEnd();
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
              logPluginError(
                "Closing non-streaming Cursor bridge after unsupported message",
                {
                  modelId,
                  convKey,
                  category: info.category,
                  caseName: info.caseName,
                  detail: info.detail,
                },
              );
              scheduleBridgeEnd(bridge);
            },
            (info) => {
              endStreamError = new Error(
                `Cursor requested unsupported exec type: ${info.execCase}`,
              );
              logPluginError(
                "Closing non-streaming Cursor bridge after unsupported exec",
                {
                  modelId,
                  convKey,
                  execCase: info.execCase,
                  execId: info.execId,
                  execMsgId: info.execMsgId,
                },
              );
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
          logPluginError(
            "Cursor non-streaming response returned Connect end-stream error",
            {
              modelId,
              convKey,
              ...errorDetails(endStreamError),
            },
          );
        }
        scheduleBridgeEnd(bridge);
      },
    ),
  );

  bridge.onClose(() => {
    bridgeCloseController.dispose();
    stopToolCallEndTimer();
    clearInterval(heartbeatTimer);
    syncStoredBlobStore(convKey, payload.blobStore);

    const flushed = tagFilter.flush();
    fullText += flushed.content;

    if (endStreamError) {
      reject(endStreamError);
      return;
    }

    if (pendingToolCalls.length === 0) {
      updateStoredConversationAfterCompletion(convKey, metadata, fullText);
    }

    resolve({
      text: fullText,
      usage: computeUsage(state),
      finishReason: pendingToolCalls.length > 0 ? "tool_calls" : "stop",
      toolCalls: pendingToolCalls,
    });
  });

  return promise;
}
