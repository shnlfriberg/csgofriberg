import { Server } from 'socket.io';
import { beginMaintenanceWindow, setRecoveryWindow } from '../services/roomStore';
import { resolveSocketIp } from './connection';
import { handleSocketConnection } from './handlers/session';
import { socketLifecycle } from './lifecycle';
import { registerSocketMiddleware } from './middleware';
import { createSocketWorkers } from './workers';

export function setupSocket(io: Server) {
  const workers = createSocketWorkers(io);
  registerSocketMiddleware(io);
  io.on('connection', (socket) => handleSocketConnection({
    io,
    presenceSubscribers: workers.presenceSubscribers,
    heartbeatEntries: workers.heartbeatEntries,
    lifecycle: socketLifecycle,
    trackBackground: workers.trackBackground,
  }, socket));
  return workers.stop;
}

export { beginMaintenanceWindow, resolveSocketIp, setRecoveryWindow };
