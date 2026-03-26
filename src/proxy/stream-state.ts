import type { PendingExec } from "./types";

export interface StreamState {
  toolCallIndex: number;
  pendingExecs: PendingExec[];
  outputTokens: number;
  totalTokens: number;
  interactionToolArgsText: Map<string, string>;
  emittedToolCallIds: Set<string>;
}
