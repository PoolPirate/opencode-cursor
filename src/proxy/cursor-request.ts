import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  AgentRunRequestSchema,
  AgentConversationTurnStructureSchema,
  AssistantMessageSchema,
  ConversationActionSchema,
  ConversationStateStructureSchema,
  ConversationTurnStructureSchema,
  ConversationStepSchema,
  ModelDetailsSchema,
  ResumeActionSchema,
  UserMessageActionSchema,
  UserMessageSchema,
} from "../proto/agent_pb";
import type { CursorRequestPayload } from "./types";

export function buildCursorRequest(
  modelId: string,
  systemPrompt: string,
  userText: string,
  turns: Array<{ userText: string; assistantText: string }>,
  conversationId: string,
  checkpoint: Uint8Array | null,
  existingBlobStore?: Map<string, Uint8Array>,
): CursorRequestPayload {
  const blobStore = new Map<string, Uint8Array>(existingBlobStore ?? []);
  const cloudRule = buildCloudRule(systemPrompt);

  let conversationState;
  if (checkpoint) {
    conversationState = fromBinary(
      ConversationStateStructureSchema,
      checkpoint,
    );
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
      rootPromptMessagesJson: [],
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

  return buildRunRequest(
    modelId,
    conversationId,
    conversationState,
    action,
    blobStore,
    cloudRule,
  );
}

export function buildCursorResumeRequest(
  modelId: string,
  systemPrompt: string,
  conversationId: string,
  checkpoint: Uint8Array,
  existingBlobStore?: Map<string, Uint8Array>,
): CursorRequestPayload {
  const blobStore = new Map<string, Uint8Array>(existingBlobStore ?? []);
  const cloudRule = buildCloudRule(systemPrompt);

  const conversationState = fromBinary(
    ConversationStateStructureSchema,
    checkpoint,
  );
  const action = create(ConversationActionSchema, {
    action: {
      case: "resumeAction",
      value: create(ResumeActionSchema, {}),
    },
  });

  return buildRunRequest(
    modelId,
    conversationId,
    conversationState,
    action,
    blobStore,
    cloudRule,
  );
}

function buildRunRequest(
  modelId: string,
  conversationId: string,
  conversationState: ReturnType<typeof create<typeof ConversationStateStructureSchema>>,
  action: ReturnType<typeof create<typeof ConversationActionSchema>>,
  blobStore: Map<string, Uint8Array>,
  cloudRule: CursorRequestPayload["cloudRule"],
): CursorRequestPayload {

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
    cloudRule,
    mcpTools: [],
  };
}

function buildCloudRule(systemPrompt: string): CursorRequestPayload["cloudRule"] {
  const content = systemPrompt.trim();
  return content || undefined;
}
