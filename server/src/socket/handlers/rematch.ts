import { z } from 'zod';
import {
  StoredMatchReport,
  acknowledgeSchedule,
  getRoomForIdentity,
  withRoomLock,
} from '../../services/roomStore';
import { socketAllowed, socketAllowedWithIp } from '../connection';
import { registerSocketEvent, SocketAck } from '../event';
import { matchReportPayloadSchema, rematchResponsePayloadSchema } from '../schemas';
import { cancelLocalTimer } from '../timers';
import { SocketEventContext, SocketLifecycle } from './context';

type RematchEventContext = SocketEventContext & {
  lifecycle: SocketLifecycle;
};

export async function handleMatchReport(
  context: RematchEventContext,
  payload: z.infer<typeof matchReportPayloadSchema>,
  ack?: SocketAck
): Promise<void> {
  const { socket, me, restorePromise, lifecycle } = context;
  await restorePromise;
  if (!(await socketAllowedWithIp(socket, 'match-report', me.key, 6, 60, 30))) {
    ack?.({ code: 'RATE_LIMITED' });
    return;
  }
  const room = await getRoomForIdentity(me.key, true);
  if (!room || !room.matchmaking || room.status !== 'finished' || room.players.length !== 2) {
    ack?.({ code: 'REPORT_NOT_AVAILABLE' });
    return;
  }
  const result = await withRoomLock(room.id, (locked) => {
    if (!locked.matchmaking || locked.status !== 'finished' || locked.players.length !== 2) {
      return { code: 'REPORT_NOT_AVAILABLE' };
    }
    const reporter = locked.players.find((player) => player.key === me.key);
    const reported = locked.players.find((player) => player.key !== me.key);
    if (!reporter || !reported || reporter.socketId !== socket.id) {
      return { code: 'REPORT_NOT_AVAILABLE' };
    }
    if (locked.reports.some((report) => report.reporterKey === me.key)) {
      return { code: 'REPORT_ALREADY_SUBMITTED' };
    }
    const report: StoredMatchReport = {
      reporterKey: me.key,
      reportedKey: reported.key,
      description: payload.description,
      createdAt: Date.now(),
    };
    locked.reports.push(report);
    return { room: locked };
  }, (value) => 'room' in value);
  if (!result || 'code' in result) {
    ack?.({ code: result?.code ?? 'REPORT_NOT_AVAILABLE' });
    return;
  }
  void lifecycle.persistMatch(result.room, result.room.matchResult?.winnerKey ?? null)
    .catch((error) => console.error('[match:report-persist]', error));
  ack?.({ ok: true, reportSubmitted: true });
}

export async function handleRematchInvite(
  context: RematchEventContext,
  _payload: unknown,
  ack?: SocketAck
): Promise<void> {
  const { io, socket, me, restorePromise, lifecycle } = context;
  await restorePromise;
  if (!(await socketAllowedWithIp(socket, 'rematch-invite', me.key, 6, 80, 60))) {
    ack?.({ code: 'RATE_LIMITED' });
    return;
  }
  const room = await getRoomForIdentity(me.key, true);
  if (!room) {
    ack?.({ code: 'REMATCH_NOT_AVAILABLE' });
    return;
  }
  const result = await withRoomLock(room.id, (locked) => {
    const code = lifecycle.rematchError(locked, me.key, socket.id);
    if (code) return { code };
    if (locked.rematchInviterKey && locked.rematchInviterKey !== me.key) {
      return { code: 'REMATCH_INVITE_PENDING' };
    }
    locked.rematchInviterKey = me.key;
    locked.rematchRequiredKeys = locked.players
      .filter((player) => player.connected && !player.eliminated)
      .map((player) => player.key);
    locked.rematchAcceptedKeys = [me.key];
    return { room: locked, outcome: 'invited' as const };
  }, (value) => 'room' in value);
  if (!result || 'code' in result) {
    ack?.({ code: result?.code ?? 'REMATCH_NOT_AVAILABLE' });
    return;
  }
  lifecycle.emitRematchUpdate(io, result.room, result.outcome, me.key);
  ack?.({ ok: true, stateVersion: result.room.revision });
}

export async function handleRematchCancel(
  context: RematchEventContext,
  _payload: unknown,
  ack?: SocketAck
): Promise<void> {
  const { io, socket, me, restorePromise, lifecycle } = context;
  await restorePromise;
  if (!(await socketAllowed('rematch-cancel', me.key, 8, 60))) {
    ack?.({ code: 'RATE_LIMITED' });
    return;
  }
  const room = await getRoomForIdentity(me.key, true);
  if (!room) {
    ack?.({ code: 'REMATCH_NOT_AVAILABLE' });
    return;
  }
  const result = await withRoomLock(room.id, (locked) => {
    const code = lifecycle.rematchError(locked, me.key, socket.id);
    if (code) return { code };
    if (locked.rematchInviterKey !== me.key) return { code: 'REMATCH_INVITE_NOT_FOUND' };
    locked.rematchInviterKey = null;
    locked.rematchAcceptedKeys = [];
    locked.rematchRequiredKeys = [];
    return { room: locked, outcome: 'cancelled' as const };
  }, (value) => 'room' in value);
  if (!result || 'code' in result) {
    ack?.({ code: result?.code ?? 'REMATCH_NOT_AVAILABLE' });
    return;
  }
  lifecycle.emitRematchUpdate(io, result.room, result.outcome, me.key);
  ack?.({ ok: true, stateVersion: result.room.revision });
}

export async function handleRematchRespond(
  context: RematchEventContext,
  payload: z.infer<typeof rematchResponsePayloadSchema>,
  ack?: SocketAck
): Promise<void> {
  const { io, socket, me, restorePromise, lifecycle } = context;
  await restorePromise;
  if (!(await socketAllowedWithIp(socket, 'rematch-respond', me.key, 8, 80, 60))) {
    ack?.({ code: 'RATE_LIMITED' });
    return;
  }
  const room = await getRoomForIdentity(me.key, true);
  if (!room) {
    ack?.({ code: 'REMATCH_NOT_AVAILABLE' });
    return;
  }
  const result = await withRoomLock(room.id, async (locked) => {
    const code = lifecycle.rematchError(locked, me.key, socket.id);
    if (code) return { code };
    if (!locked.rematchInviterKey) return { code: 'REMATCH_INVITE_NOT_FOUND' };
    if (locked.rematchInviterKey === me.key) return { code: 'REMATCH_RESPONSE_NOT_ALLOWED' };
    if (!payload.accept) {
      locked.rematchInviterKey = null;
      locked.rematchAcceptedKeys = [];
      locked.rematchRequiredKeys = [];
      return { room: locked, outcome: 'declined' as const };
    }
    if (!locked.rematchRequiredKeys.includes(me.key)) {
      return { code: 'REMATCH_RESPONSE_NOT_ALLOWED' };
    }
    if (!locked.rematchAcceptedKeys.includes(me.key)) locked.rematchAcceptedKeys.push(me.key);
    if (!locked.rematchRequiredKeys.every((key) => locked.rematchAcceptedKeys.includes(key))) {
      return { room: locked, outcome: 'invited' as const };
    }
    await lifecycle.persistMatch(locked, locked.matchResult!.winnerKey);
    lifecycle.resetForRematch(locked);
    return { room: locked, outcome: 'accepted' as const };
  }, (value) => 'room' in value);
  if (!result || 'code' in result) {
    ack?.({ code: result?.code ?? 'REMATCH_NOT_AVAILABLE' });
    return;
  }
  if (result.outcome === 'accepted') {
    cancelLocalTimer(`cleanup:${result.room.id}`);
    await acknowledgeSchedule(`cleanup|${result.room.id}|0`);
  }
  lifecycle.emitRematchUpdate(io, result.room, result.outcome, me.key);
  ack?.({ ok: true, stateVersion: result.room.revision });
}

export function registerRematchEvents(context: RematchEventContext): void {
  registerSocketEvent(
    context.socket,
    'match:report',
    (payload, ack) => handleMatchReport(context, payload, ack),
    matchReportPayloadSchema
  );
  registerSocketEvent(
    context.socket,
    'match:rematch-invite',
    (payload, ack) => handleRematchInvite(context, payload, ack)
  );
  registerSocketEvent(
    context.socket,
    'match:rematch-cancel',
    (payload, ack) => handleRematchCancel(context, payload, ack)
  );
  registerSocketEvent(
    context.socket,
    'match:rematch-respond',
    (payload, ack) => handleRematchRespond(context, payload, ack),
    rematchResponsePayloadSchema
  );
}
