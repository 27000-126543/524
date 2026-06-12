import { Server as SocketIOServer } from 'socket.io';
import { Server as HTTPServer } from 'http';
import logger from './logger';

class WebSocketManager {
  private io: SocketIOServer | null = null;
  private userSockets: Map<string, string[]> = new Map();

  init(httpServer: HTTPServer) {
    this.io = new SocketIOServer(httpServer, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
    });

    this.io.on('connection', (socket) => {
      logger.info(`WebSocket connected: ${socket.id}`);

      socket.on('register', (userId: string) => {
        const existing = this.userSockets.get(userId) || [];
        existing.push(socket.id);
        this.userSockets.set(userId, existing);
        logger.info(`User ${userId} registered with socket ${socket.id}`);
      });

      socket.on('disconnect', () => {
        for (const [userId, socketIds] of this.userSockets.entries()) {
          const filtered = socketIds.filter((id) => id !== socket.id);
          if (filtered.length === 0) {
            this.userSockets.delete(userId);
          } else {
            this.userSockets.set(userId, filtered);
          }
        }
        logger.info(`WebSocket disconnected: ${socket.id}`);
      });
    });
  }

  sendToUser(userId: string, event: string, data: any) {
    if (!this.io) return;
    const socketIds = this.userSockets.get(userId) || [];
    socketIds.forEach((id) => {
      this.io!.to(id).emit(event, data);
    });
  }

  sendToUsers(userIds: string[], event: string, data: any) {
    userIds.forEach((userId) => this.sendToUser(userId, event, data));
  }

  broadcastToDepartment(departmentId: string, event: string, data: any) {
    if (!this.io) return;
    this.io.to(`dept_${departmentId}`).emit(event, data);
  }

  broadcast(event: string, data: any) {
    if (!this.io) return;
    this.io.emit(event, data);
  }
}

export const wsManager = new WebSocketManager();
