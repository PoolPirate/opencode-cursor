import type { CursorSession } from "../cursor/bidi-session";
import { scheduleBridgeEnd } from "./stream-dispatch";

const TURN_END_GRACE_MS = 750;

export function createBridgeCloseController(bridge: CursorSession): {
  noteTurnEnded: () => void;
  noteCheckpoint: () => void;
  dispose: () => void;
} {
  let turnEnded = false;
  let checkpointSeen = false;
  let closeTimer: NodeJS.Timeout | undefined;

  const clearCloseTimer = () => {
    if (!closeTimer) return;
    clearTimeout(closeTimer);
    closeTimer = undefined;
  };

  const closeBridge = () => {
    clearCloseTimer();
    scheduleBridgeEnd(bridge);
  };

  return {
    noteTurnEnded() {
      turnEnded = true;
      if (checkpointSeen) {
        closeBridge();
        return;
      }

      clearCloseTimer();
      closeTimer = setTimeout(closeBridge, TURN_END_GRACE_MS);
    },
    noteCheckpoint() {
      checkpointSeen = true;
      if (turnEnded) {
        closeBridge();
      }
    },
    dispose() {
      clearCloseTimer();
    },
  };
}
