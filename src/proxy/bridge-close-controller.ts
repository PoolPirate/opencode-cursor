import type { CursorSession } from "../cursor/bidi-session";
import { scheduleBridgeEnd } from "./stream-dispatch";

const CHECKPOINT_WAIT_AFTER_TURN_END_MS = 2_000;

export function createBridgeCloseController(
  bridge: CursorSession,
  options?: {
    onCheckpointTimeout?: () => void;
  },
): {
  noteTurnEnded: () => void;
  noteCheckpoint: () => void;
  hasTurnEnded: () => boolean;
  hasCheckpoint: () => boolean;
  dispose: () => void;
} {
  let turnEnded = false;
  let checkpointSeen = false;
  let closeTimer: NodeJS.Timeout | undefined;
  let checkpointTimeoutNotified = false;

  const clearCloseTimer = () => {
    if (!closeTimer) return;
    clearTimeout(closeTimer);
    closeTimer = undefined;
  };

  const closeBridge = () => {
    clearCloseTimer();
    scheduleBridgeEnd(bridge);
  };

  const notifyCheckpointTimeout = () => {
    if (checkpointTimeoutNotified) return;
    checkpointTimeoutNotified = true;
    options?.onCheckpointTimeout?.();
  };

  return {
    noteTurnEnded() {
      turnEnded = true;
      if (checkpointSeen) {
        closeBridge();
        return;
      }

      clearCloseTimer();
      closeTimer = setTimeout(() => {
        if (!checkpointSeen) {
          notifyCheckpointTimeout();
        }
        closeBridge();
      }, CHECKPOINT_WAIT_AFTER_TURN_END_MS);
    },
    noteCheckpoint() {
      checkpointSeen = true;
      if (turnEnded) {
        closeBridge();
      }
    },
    hasTurnEnded() {
      return turnEnded;
    },
    hasCheckpoint() {
      return checkpointSeen;
    },
    dispose() {
      clearCloseTimer();
    },
  };
}
