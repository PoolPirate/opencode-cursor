import { logPluginWarn } from "../logger";
import {
  buildInitialHandoffPrompt,
  buildTitleSourceText,
  buildToolResumePrompt,
  detectTitleRequest,
  parseMessages,
} from "../openai/messages";
import { buildMcpToolDefinitions, selectToolsForChoice } from "../openai/tools";
import type {
  ChatCompletionRequest,
  ChatRequestContext,
} from "../openai/types";
import {
  activeBridges,
  conversationStates,
  createStoredConversation,
  deriveBridgeKey,
  deriveConversationKey,
  evictStaleConversations,
  hashString,
  normalizeAgentKey,
  resetStoredConversation,
} from "./conversation-state";
import { buildCursorRequest } from "./cursor-request";
import {
  handleNonStreamingResponse,
  handleStreamingResponse,
  handleToolResultResume,
} from "./bridge";
import { handleTitleGenerationRequest } from "./title";

export function handleChatCompletion(
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
    assistantContinuation,
  } = parsed;
  const modelId = body.model;
  const normalizedAgentKey = normalizeAgentKey(context.agentKey);
  const titleDetection = detectTitleRequest(body);
  const isTitleAgent = titleDetection.matched;
  if (isTitleAgent) {
    const titleSourceText = buildTitleSourceText(
      userText,
      turns,
      pendingAssistantSummary,
      toolResults,
    );
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
    return handleTitleGenerationRequest(
      titleSourceText,
      accessToken,
      modelId,
      body.stream !== false,
    );
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
  const bridgeKey = deriveBridgeKey(
    modelId,
    body.messages,
    context.sessionId,
    context.agentKey,
  );
  const convKey = deriveConversationKey(
    body.messages,
    context.sessionId,
    context.agentKey,
  );
  const activeBridge = activeBridges.get(bridgeKey);

  if (activeBridge && toolResults.length > 0) {
    activeBridges.delete(bridgeKey);

    if (activeBridge.bridge.alive) {
      if (activeBridge.modelId !== modelId) {
        logPluginWarn(
          "Resuming pending Cursor tool call on original model after model switch",
          {
            requestedModelId: modelId,
            resumedModelId: activeBridge.modelId,
            convKey,
            bridgeKey,
          },
        );
      }
      // Resume the live bridge with tool results
      return handleToolResultResume(
        activeBridge,
        toolResults,
        bridgeKey,
        convKey,
      );
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
    stored.checkpoint &&
    (stored.systemPromptHash !== systemPromptHash ||
      (turns.length > 0 &&
        stored.completedTurnsFingerprint !== completedTurnsFingerprint))
  ) {
    resetStoredConversation(stored);
  }

  stored.systemPromptHash = systemPromptHash;
  stored.completedTurnsFingerprint = completedTurnsFingerprint;
  stored.lastAccessMs = Date.now();
  evictStaleConversations();

  if (assistantContinuation) {
    return new Response(
      JSON.stringify({
        error: {
          message:
            "Assistant-last continuation is not supported by the Cursor provider",
          type: "invalid_request_error",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Build the request. When tool results are present but the bridge died,
  // we must still include the last user text so Cursor has context.
  const mcpTools = buildMcpToolDefinitions(tools);
  const needsInitialHandoff =
    !stored.checkpoint &&
    (turns.length > 0 || pendingAssistantSummary || toolResults.length > 0);
  const replayTurns = needsInitialHandoff ? [] : turns;
  let effectiveUserText = needsInitialHandoff
    ? buildInitialHandoffPrompt(
        userText,
        turns,
        pendingAssistantSummary,
        toolResults,
      )
    : toolResults.length > 0
      ? buildToolResumePrompt(userText, pendingAssistantSummary, toolResults)
      : userText;
  const payload = buildCursorRequest(
    modelId,
    systemPrompt,
    effectiveUserText,
    replayTurns,
    stored.conversationId,
    stored.checkpoint,
    stored.blobStore,
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
  return handleStreamingResponse(
    payload,
    accessToken,
    modelId,
    bridgeKey,
    convKey,
    {
      systemPrompt,
      systemPromptHash,
      completedTurnsFingerprint,
      turns,
      userText,
      agentKey: normalizedAgentKey,
    },
  );
}
