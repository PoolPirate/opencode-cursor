import type { CursorSession } from "../cursor/bidi-session";
import type { ConversationRequestMetadata } from "./conversation-meta";
import type { McpToolDefinition } from "../proto/agent_pb";

export interface CursorRequestPayload {
  requestBytes: Uint8Array;
  blobStore: Map<string, Uint8Array>;
  mcpTools: McpToolDefinition[];
}

/** A pending tool execution waiting for results from the caller. */
export interface PendingExec {
  execId: string;
  execMsgId: number;
  toolCallId: string;
  toolName: string;
  /** Decoded arguments JSON string for SSE tool_calls emission. */
  decodedArgs: string;
  source?: "interaction" | "exec";
  cursorCallId?: string;
  modelCallId?: string;
}

/** A live Cursor session kept alive across requests for tool result continuation. */
export interface ActiveBridge {
  bridge: CursorSession;
  heartbeatTimer: NodeJS.Timeout;
  blobStore: Map<string, Uint8Array>;
  mcpTools: McpToolDefinition[];
  pendingExecs: PendingExec[];
  modelId: string;
  metadata: ConversationRequestMetadata;
}
