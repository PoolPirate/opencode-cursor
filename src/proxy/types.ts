import type { CursorSession } from "../cursor/bidi-session";
import type { McpToolDefinition } from "../proto/agent_pb";
import type { ConversationRequestMetadata } from "./conversation-meta";

export interface CursorRequestPayload {
  requestBytes: Uint8Array;
  blobStore: Map<string, Uint8Array>;
  cloudRule?: string;
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
  cloudRule?: string;
  mcpTools: McpToolDefinition[];
  pendingExecs: PendingExec[];
  modelId: string;
  metadata: ConversationRequestMetadata;
}
