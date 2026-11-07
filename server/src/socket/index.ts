import { Server } from 'socket.io';
import { beginMaintenanceWindow, setRecoveryWindow } from '../services/roomStore';
import { activateRoomAdapter, startRoomKernel } from '../rooms/kernel';
import { resolveSocketIp } from './connection';
import { handleSocketConnection } from './handlers/session';
import { classicRoomAdapter } from './kernelAdapter';
import { socketLifecycle } from './lifecycle';
import { registerSocketMiddleware } from './middleware';
import { createSocketWorkers } from './workers';

export function setupSocket(io: Server) {
  const stopKernel = startRoomKernel(io);
  const unregisterClassic = activateRoomAdapter(classicRoomAdapter);
  const workers = createSocketWorkers(io);
  registerSocketMiddleware(io);
  io.on('connection', (socket) => handleSocketConnection({
    io,
    presenceSubscribers: workers.presenceSubscribers,
    heartbeatEntries: workers.heartbeatEntries,
    lifecycle: socketLifecycle,
    trackBackground: workers.trackBackground,
  }, socket));
  return async () => {
    await workers.stop();
    unregisterClassic();
    await stopKernel();
  };
}

export { beginMaintenanceWindow, resolveSocketIp, setRecoveryWindow };
