import { create, toBinary } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  AskQuestionInteractionResponseSchema,
  AskQuestionRejectedSchema,
  AskQuestionResultSchema,
  ClientHeartbeatSchema,
  ConversationStateStructureSchema,
  BackgroundShellSpawnResultSchema,
  CreatePlanErrorSchema,
  CreatePlanRequestResponseSchema,
  CreatePlanResultSchema,
  DeleteResultSchema,
  DeleteRejectedSchema,
  DiagnosticsResultSchema,
  ExecClientMessageSchema,
  ExaFetchRequestResponseSchema,
  ExaFetchRequestResponse_RejectedSchema,
  ExaSearchRequestResponseSchema,
  ExaSearchRequestResponse_RejectedSchema,
  FetchErrorSchema,
  FetchResultSchema,
  GetBlobResultSchema,
  GrepErrorSchema,
  GrepResultSchema,
  type InteractionQuery,
  InteractionResponseSchema,
  KvClientMessageSchema,
  LsRejectedSchema,
  LsResultSchema,
  McpResultSchema,
  ReadRejectedSchema,
  ReadResultSchema,
  RequestContextResultSchema,
  RequestContextSchema,
  RequestContextSuccessSchema,
  SetBlobResultSchema,
  ShellRejectedSchema,
  ShellResultSchema,
  SwitchModeRequestResponseSchema,
  SwitchModeRequestResponse_RejectedSchema,
  WebSearchRequestResponseSchema,
  WebSearchRequestResponse_RejectedSchema,
  WriteRejectedSchema,
  WriteResultSchema,
  WriteShellStdinErrorSchema,
  WriteShellStdinResultSchema,
  type AgentServerMessage,
  type ConversationStateStructure,
  type ExecServerMessage,
  type KvServerMessage,
  type McpToolDefinition,
} from "../proto/agent_pb";
import { CONNECT_END_STREAM_FLAG } from "../cursor/config";
import { logPluginError, logPluginWarn } from "../logger";
import { decodeMcpArgsMap } from "../openai/tools";
import type { CursorSession } from "../cursor/bidi-session";
import type { StreamState } from "./stream-state";
import type { PendingExec } from "./types";

export interface UnhandledExecInfo {
  execCase: string;
  execId: string;
  execMsgId: number;
}

export interface UnsupportedServerMessageInfo {
  category:
    | "agentMessage"
    | "interactionUpdate"
    | "interactionQuery"
    | "execServerControl"
    | "toolCall";
  caseName: string;
  detail?: string;
}

export function parseConnectEndStream(data: Uint8Array): Error | null {
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

export function makeHeartbeatBytes(): Uint8Array {
  const heartbeat = create(AgentClientMessageSchema, {
    message: {
      case: "clientHeartbeat",
      value: create(ClientHeartbeatSchema, {}),
    },
  });
  return toBinary(AgentClientMessageSchema, heartbeat);
}

export function scheduleBridgeEnd(bridge: CursorSession): void {
  queueMicrotask(() => {
    if (bridge.alive) bridge.end();
  });
}

/**
 * Create a stateful parser for Connect protocol frames.
 * Handles buffering partial data across chunks.
 */
export function createConnectFrameParser(
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

const THINKING_TAG_NAMES = [
  "think",
  "thinking",
  "reasoning",
  "thought",
  "think_intent",
];
const MAX_THINKING_TAG_LEN = 16; // </think_intent> is 15 chars

/**
 * Strip thinking tags from streamed text, routing tagged content to reasoning.
 * Buffers partial tags across chunk boundaries.
 */
export function createThinkingTagFilter(): {
  process(text: string): { content: string; reasoning: string };
  flush(): { content: string; reasoning: string };
} {
  let buffer = "";
  let inThinking = false;

  return {
    process(text: string) {
      const input = buffer + text;
      buffer = "";
      let content = "";
      let reasoning = "";
      let lastIdx = 0;

      const re = new RegExp(
        `<(/?)(?:${THINKING_TAG_NAMES.join("|")})\\s*>`,
        "gi",
      );
      let match: RegExpExecArray | null;
      while ((match = re.exec(input)) !== null) {
        const before = input.slice(lastIdx, match.index);
        if (inThinking) reasoning += before;
        else content += before;
        inThinking = match[1] !== "/";
        lastIdx = re.lastIndex;
      }

      const rest = input.slice(lastIdx);
      // Buffer a trailing '<' that could be the start of a thinking tag.
      const ltPos = rest.lastIndexOf("<");
      if (
        ltPos >= 0 &&
        rest.length - ltPos < MAX_THINKING_TAG_LEN &&
        /^<\/?[a-z_]*$/i.test(rest.slice(ltPos))
      ) {
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
      buffer = "";
      if (!b) return { content: "", reasoning: "" };
      return inThinking
        ? { content: "", reasoning: b }
        : { content: b, reasoning: "" };
    },
  };
}

export function computeUsage(state: StreamState) {
  const completion_tokens = state.outputTokens;
  const total_tokens = state.totalTokens || completion_tokens;
  const prompt_tokens = Math.max(0, total_tokens - completion_tokens);
  return { prompt_tokens, completion_tokens, total_tokens };
}

export function processServerMessage(
  msg: AgentServerMessage,
  blobStore: Map<string, Uint8Array>,
  mcpTools: McpToolDefinition[],
  sendFrame: (data: Uint8Array) => void,
  state: StreamState,
  onText: (text: string, isThinking?: boolean) => void,
  onMcpExec: (exec: PendingExec) => void,
  onCheckpoint?: (checkpointBytes: Uint8Array) => void,
  onTurnEnded?: () => void,
  onUnsupportedMessage?: (info: UnsupportedServerMessageInfo) => void,
  onUnhandledExec?: (info: UnhandledExecInfo) => void,
): void {
  const msgCase = msg.message.case;

  if (msgCase === "interactionUpdate") {
    handleInteractionUpdate(
      msg.message.value,
      state,
      onText,
      onMcpExec,
      onTurnEnded,
      onUnsupportedMessage,
    );
  } else if (msgCase === "kvServerMessage") {
    handleKvMessage(msg.message.value as KvServerMessage, blobStore, sendFrame);
  } else if (msgCase === "execServerMessage") {
    handleExecMessage(
      msg.message.value as ExecServerMessage,
      mcpTools,
      sendFrame,
      state,
      onMcpExec,
      onUnhandledExec,
    );
  } else if (msgCase === "execServerControlMessage") {
    onUnsupportedMessage?.({
      category: "execServerControl",
      caseName: msg.message.value.message.case ?? "undefined",
    });
  } else if (msgCase === "interactionQuery") {
    handleInteractionQuery(
      msg.message.value as InteractionQuery,
      sendFrame,
      onUnsupportedMessage,
    );
  } else if (msgCase === "conversationCheckpointUpdate") {
    const stateStructure = msg.message.value as ConversationStateStructure;
    if (stateStructure.tokenDetails) {
      state.totalTokens = stateStructure.tokenDetails.usedTokens;
    }
    if (onCheckpoint) {
      onCheckpoint(toBinary(ConversationStateStructureSchema, stateStructure));
    }
  } else {
    onUnsupportedMessage?.({
      category: "agentMessage",
      caseName: msgCase ?? "undefined",
    });
  }
}

function handleInteractionUpdate(
  update: any,
  state: StreamState,
  onText: (text: string, isThinking?: boolean) => void,
  onMcpExec: (exec: PendingExec) => void,
  onTurnEnded?: () => void,
  onUnsupportedMessage?: (info: UnsupportedServerMessageInfo) => void,
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
  } else if (updateCase === "partialToolCall") {
    const partial = update.message.value;
    if (partial.callId && partial.argsTextDelta) {
      const existing = state.interactionToolArgsText.get(partial.callId) ?? "";
      state.interactionToolArgsText.set(
        partial.callId,
        `${existing}${partial.argsTextDelta}`,
      );
    }
  } else if (updateCase === "toolCallCompleted") {
    const callId = update.message.value?.callId;
    if (callId) state.interactionToolArgsText.delete(callId);
  } else if (updateCase === "turnEnded") {
    onTurnEnded?.();
  } else if (
    updateCase === "toolCallStarted" ||
    updateCase === "toolCallDelta" ||
    updateCase === "thinkingCompleted" ||
    updateCase === "userMessageAppended" ||
    updateCase === "summary" ||
    updateCase === "summaryStarted" ||
    updateCase === "summaryCompleted" ||
    updateCase === "heartbeat" ||
    updateCase === "stepStarted" ||
    updateCase === "stepCompleted"
  ) {
    return;
  } else {
    onUnsupportedMessage?.({
      category: "interactionUpdate",
      caseName: updateCase ?? "undefined",
    });
  }
  // toolCallStarted, partialToolCall, toolCallDelta, and toolCallCompleted are
  // informational only. Actionable MCP tool execution must come from
  // execServerMessage.mcpArgs so tool results can be resumed with the correct
  // exec envelope.
}

function handleInteractionQuery(
  query: InteractionQuery,
  sendFrame: (data: Uint8Array) => void,
  onUnsupportedMessage?: (info: UnsupportedServerMessageInfo) => void,
): void {
  const queryCase = query.query.case;

  if (queryCase === "webSearchRequestQuery") {
    const response = create(WebSearchRequestResponseSchema, {
      result: {
        case: "rejected",
        value: create(WebSearchRequestResponse_RejectedSchema, {
          reason:
            "Native Cursor web search is not available in this environment. Use the provided MCP tool `websearch` instead.",
        }),
      },
    });
    sendInteractionResponse(
      query.id,
      "webSearchRequestResponse",
      response,
      sendFrame,
    );
    return;
  }

  if (queryCase === "askQuestionInteractionQuery") {
    const response = create(AskQuestionInteractionResponseSchema, {
      result: create(AskQuestionResultSchema, {
        result: {
          case: "rejected",
          value: create(AskQuestionRejectedSchema, {
            reason:
              "Native Cursor question prompts are not available in this environment. Use the provided MCP tool `question` instead.",
          }),
        },
      }),
    });
    sendInteractionResponse(
      query.id,
      "askQuestionInteractionResponse",
      response,
      sendFrame,
    );
    return;
  }

  if (queryCase === "switchModeRequestQuery") {
    const response = create(SwitchModeRequestResponseSchema, {
      result: {
        case: "rejected",
        value: create(SwitchModeRequestResponse_RejectedSchema, {
          reason:
            "Cursor mode switching is not available in this environment. Continue using the current agent and the provided MCP tools.",
        }),
      },
    });
    sendInteractionResponse(
      query.id,
      "switchModeRequestResponse",
      response,
      sendFrame,
    );
    return;
  }

  if (queryCase === "exaSearchRequestQuery") {
    const response = create(ExaSearchRequestResponseSchema, {
      result: {
        case: "rejected",
        value: create(ExaSearchRequestResponse_RejectedSchema, {
          reason:
            "Native Cursor Exa search is not available in this environment. Use the provided MCP tool `websearch` instead.",
        }),
      },
    });
    sendInteractionResponse(
      query.id,
      "exaSearchRequestResponse",
      response,
      sendFrame,
    );
    return;
  }

  if (queryCase === "exaFetchRequestQuery") {
    const response = create(ExaFetchRequestResponseSchema, {
      result: {
        case: "rejected",
        value: create(ExaFetchRequestResponse_RejectedSchema, {
          reason:
            "Native Cursor Exa fetch is not available in this environment. Use the provided MCP tools `websearch` and `webfetch` instead.",
        }),
      },
    });
    sendInteractionResponse(
      query.id,
      "exaFetchRequestResponse",
      response,
      sendFrame,
    );
    return;
  }

  if (queryCase === "createPlanRequestQuery") {
    const response = create(CreatePlanRequestResponseSchema, {
      result: create(CreatePlanResultSchema, {
        planUri: "",
        result: {
          case: "error",
          value: create(CreatePlanErrorSchema, {
            error:
              "Native Cursor plan creation is not available in this environment. Use the provided MCP planning tools instead.",
          }),
        },
      }),
    });
    sendInteractionResponse(
      query.id,
      "createPlanRequestResponse",
      response,
      sendFrame,
    );
    return;
  }

  onUnsupportedMessage?.({
    category: "interactionQuery",
    caseName: queryCase ?? "undefined",
  });
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

function sendInteractionResponse(
  queryId: number,
  messageCase: string,
  value: unknown,
  sendFrame: (data: Uint8Array) => void,
): void {
  const response = create(InteractionResponseSchema, {
    id: queryId,
    result: { case: messageCase as any, value: value as any },
  });
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "interactionResponse", value: response },
  });
  sendFrame(toBinary(AgentClientMessageSchema, clientMessage));
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
      kvMsg,
      "getBlobResult",
      create(GetBlobResultSchema, blobData ? { blobData } : {}),
      sendFrame,
    );
  } else if (kvCase === "setBlobArgs") {
    const { blobId, blobData } = kvMsg.message.value;
    blobStore.set(Buffer.from(blobId).toString("hex"), blobData);
    sendKvResponse(
      kvMsg,
      "setBlobResult",
      create(SetBlobResultSchema, {}),
      sendFrame,
    );
  }
}

function handleExecMessage(
  execMsg: ExecServerMessage,
  mcpTools: McpToolDefinition[],
  sendFrame: (data: Uint8Array) => void,
  state: StreamState,
  onMcpExec: (exec: PendingExec) => void,
  onUnhandledExec?: (info: UnhandledExecInfo) => void,
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
    const toolCallId = mcpArgs.toolCallId || crypto.randomUUID();
    if (state.emittedToolCallIds.has(toolCallId)) {
      return;
    }
    state.emittedToolCallIds.add(toolCallId);
    onMcpExec({
      execId: execMsg.execId,
      execMsgId: execMsg.id,
      toolCallId,
      toolName: mcpArgs.toolName || mcpArgs.name,
      decodedArgs: JSON.stringify(decoded),
    });
    return;
  }

  // --- Reject native Cursor tools ---
  // The model tries these first. We must respond with rejection/error
  // so it falls back to our MCP tools (registered via RequestContext).
  const REJECT_REASON =
    "Tool not available in this environment. Use the MCP tools provided instead.";

  if (execCase === "readArgs") {
    const args = execMsg.message.value;
    const result = create(ReadResultSchema, {
      result: {
        case: "rejected",
        value: create(ReadRejectedSchema, {
          path: args.path,
          reason: REJECT_REASON,
        }),
      },
    });
    sendExecResult(execMsg, "readResult", result, sendFrame);
    return;
  }
  if (execCase === "lsArgs") {
    const args = execMsg.message.value;
    const result = create(LsResultSchema, {
      result: {
        case: "rejected",
        value: create(LsRejectedSchema, {
          path: args.path,
          reason: REJECT_REASON,
        }),
      },
    });
    sendExecResult(execMsg, "lsResult", result, sendFrame);
    return;
  }
  if (execCase === "grepArgs") {
    const result = create(GrepResultSchema, {
      result: {
        case: "error",
        value: create(GrepErrorSchema, { error: REJECT_REASON }),
      },
    });
    sendExecResult(execMsg, "grepResult", result, sendFrame);
    return;
  }
  if (execCase === "writeArgs") {
    const args = execMsg.message.value;
    const result = create(WriteResultSchema, {
      result: {
        case: "rejected",
        value: create(WriteRejectedSchema, {
          path: args.path,
          reason: REJECT_REASON,
        }),
      },
    });
    sendExecResult(execMsg, "writeResult", result, sendFrame);
    return;
  }
  if (execCase === "deleteArgs") {
    const args = execMsg.message.value;
    const result = create(DeleteResultSchema, {
      result: {
        case: "rejected",
        value: create(DeleteRejectedSchema, {
          path: args.path,
          reason: REJECT_REASON,
        }),
      },
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
      result: {
        case: "error",
        value: create(WriteShellStdinErrorSchema, { error: REJECT_REASON }),
      },
    });
    sendExecResult(execMsg, "writeShellStdinResult", result, sendFrame);
    return;
  }
  if (execCase === "fetchArgs") {
    const args = execMsg.message.value;
    const result = create(FetchResultSchema, {
      result: {
        case: "error",
        value: create(FetchErrorSchema, {
          url: args.url ?? "",
          error: REJECT_REASON,
        }),
      },
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

  logPluginError("Unhandled Cursor exec type", {
    execCase: execCase ?? "undefined",
    execId: execMsg.execId,
    execMsgId: execMsg.id,
  });
  onUnhandledExec?.({
    execCase: execCase ?? "undefined",
    execId: execMsg.execId,
    execMsgId: execMsg.id,
  });
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
