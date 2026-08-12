import { SocketLifecycle } from './handlers/context';
import {
  emitRematchUpdate,
  eliminatePlayer,
  finishMatch,
  persistMatch,
  recordReplayRound,
  rematchError,
  resetForRematch,
} from './matchLifecycle';
import { cleanupRoom } from './roomMaintenance';
import { finishRound, skipRound, startRound } from './roundLifecycle';
import { handleScheduledItem, processReadyCheck } from './scheduleProcessor';

export const socketLifecycle: SocketLifecycle = {
  recordReplayRound,
  persistMatch,
  rematchError,
  emitRematchUpdate,
  resetForRematch,
  finishMatch,
  eliminatePlayer,
  startRound,
  finishRound,
  skipRound,
  cleanupRoom,
  processReadyCheck,
  handleScheduledItem,
};
