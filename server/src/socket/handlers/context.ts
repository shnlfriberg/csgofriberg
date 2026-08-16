import { Server, Socket } from 'socket.io';
import { StoredIdentity, StoredRoom } from '../../services/roomStore';

export interface SocketEventContext {
  io: Server;
  socket: Socket;
  me: StoredIdentity;
  restorePromise: Promise<void>;
}

export interface SocketLifecycle {
  recordReplayRound(roomId: string, expectedRound: number): Promise<StoredRoom | null>;
  persistMatch(
    room: StoredRoom,
    winnerKey: string | null,
    forfeitedKey?: string | null
  ): Promise<void>;
  rematchError(room: StoredRoom, identity: string, socketId: string): string | null;
  emitRematchUpdate(
    io: Server,
    room: StoredRoom,
    outcome: 'wanted' | 'withdrawn' | 'updated' | 'waiting' | 'started',
    actorKey: string,
    playerUpdate?: { key: string; connected: boolean }
  ): void;
  syncRematchPreferences(room: StoredRoom): string[];
  resetForRematch(room: StoredRoom, autoStart?: boolean): void;
  finishMatch(
    io: Server,
    roomId: string,
    winnerKey: string | null,
    reason: string,
    actor?: { key: string; socketId: string }
  ): Promise<'finished' | 'stale' | 'ignored'>;
  eliminatePlayer(
    io: Server,
    roomId: string,
    playerKey: string,
    reason: 'player_left' | 'disconnect_timeout',
    socketId?: string
  ): Promise<'eliminated' | 'finished' | 'stale' | 'ignored'>;
  startRound(io: Server, roomId: string): Promise<boolean>;
  finishRound(
    io: Server,
    roomId: string,
    winnerKey: string | null,
    reason: 'guessed' | 'exhausted' | 'timeout',
    expectedRound: number
  ): Promise<void>;
  skipRound(
    io: Server,
    roomId: string,
    playerKey: string,
    socketId: string,
    expectedRound: number
  ): Promise<{ room: StoredRoom; roundFinished: boolean; alreadySkipped: boolean } | 'stale' | null>;
  cleanupRoom(roomId: string): Promise<void>;
  processReadyCheck(io: Server, roomId: string): Promise<number | null>;
  handleScheduledItem(io: Server, item: string): Promise<void>;
}
