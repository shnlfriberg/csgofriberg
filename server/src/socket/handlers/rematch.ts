import { z } from 'zod';
import {
  StoredMatchReport,
  acknowledgeSchedule,
  getRoomForIdentity,
  withRoomLock,
} from '../../services/roomStore';
import { socketAllowed, socketAllowedWithIp } from '../connection';
import { registerSocketEvent, SocketAck } from '../event';
import {
  matchReportPayloadSchema,
  rematchResponsePayloadSchema,
  rematchWantPayloadSchema,
} from '../schemas';
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

export async function handleRematchWant(
  context: RematchEventContext,
  payload: z.infer<typeof rematchWantPayloadSchema>,
  ack?: SocketAck
): Promise<void> {
  const { io, socket, me, restorePromise, lifecycle } = context;
  await restorePromise;
  if (!(await socketAllowedWithIp(socket, 'rematch-want', me.key, 8, 80, 60))) {
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
    lifecycle.syncRematchPreferences(locked);
    const alreadyWanted = locked.rematchAcceptedKeys.includes(me.key);
    if (payload.wanted && !alreadyWanted) locked.rematchAcceptedKeys.push(me.key);
    if (!payload.wanted && alreadyWanted) {
      locked.rematchAcceptedKeys = locked.rematchAcceptedKeys.filter((key) => key !== me.key);
    }
    locked.rematchInviterKey = locked.rematchAcceptedKeys[0] ?? null;
    const startNow = payload.wanted
      && locked.rematchRequiredKeys.length >= 2
      && locked.rematchRequiredKeys.every((key) => locked.rematchAcceptedKeys.includes(key));
    if (!startNow) {
      return { room: locked, outcome: payload.wanted ? 'wanted' as const : 'withdrawn' as const };
    }
    await lifecycle.persistMatch(locked, locked.matchResult!.winnerKey);
    const waitForPlayers = locked.gameMode === 'relay2v2' && locked.rematchRequiredKeys.length < 4;
    lifecycle.resetForRematch(locked, !waitForPlayers);
    return { room: locked, outcome: waitForPlayers ? 'waiting' as const : 'started' as const };
  }, (value) => 'room' in value);
  if (!result || 'code' in result) {
    ack?.({ code: result?.code ?? 'REMATCH_NOT_AVAILABLE' });
    return;
  }
  if (result.outcome === 'started' || result.outcome === 'waiting') {
    cancelLocalTimer(`cleanup:${result.room.id}`);
    await acknowledgeSchedule(`cleanup|${result.room.id}|0`);
  }
  lifecycle.emitRematchUpdate(io, result.room, result.outcome, me.key);
  ack?.({ ok: true, stateVersion: result.room.revision });
  if (result.outcome === 'started') await lifecycle.startRound(io, result.room.id);
}

export async function handleRematchCancel(
  context: RematchEventContext,
  _payload: unknown,
  ack?: SocketAck
): Promise<void> {
  return handleRematchWant(context, { wanted: false }, ack);
}

export async function handleRematchRespond(
  context: RematchEventContext,
  payload: z.infer<typeof rematchResponsePayloadSchema>,
  ack?: SocketAck
): Promise<void> {
  return handleRematchWant(context, { wanted: payload.accept }, ack);
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
    'match:rematch-want',
    (payload, ack) => handleRematchWant(context, payload, ack),
    rematchWantPayloadSchema
  );
  registerSocketEvent(
    context.socket,
    'match:rematch-invite',
    (_payload, ack) => handleRematchWant(context, { wanted: true }, ack)
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
