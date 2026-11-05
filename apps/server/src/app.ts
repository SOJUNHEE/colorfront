import { ROOM_NAME } from '@colorfront/shared';
import { defineRoom, defineServer, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';

import { MatchRoom } from './rooms/MatchRoom.ts';

/** express types are not a dependency; the handlers only need `res.json`. */
type JsonResponse = { json(body: unknown): void };

/**
 * Build (but do not start) the game server. `index.ts` listens on a port; tests create their
 * own instance on a random port.
 */
export function createGameServer() {
    return defineServer({
        transport: new WebSocketTransport(),
        greet: false,
        rooms: {
            [ROOM_NAME]: defineRoom(MatchRoom)
        },
        express: (app) => {
            app.get('/health', (_req: unknown, res: JsonResponse) => {
                res.json({ ok: true, uptimeSec: Math.round(process.uptime()) });
            });
            // Read-only diagnostics for load tests (no player data beyond counts).
            app.get('/metrics', async (_req: unknown, res: JsonResponse & { status(code: number): JsonResponse }) => {
                try {
                    const rooms = await matchMaker.query({ name: ROOM_NAME });
                    const details = rooms.map((r) => {
                        const room = matchMaker.getLocalRoomById(r.roomId) as MatchRoom | undefined;
                        return room?.sim ? room.metricsSnapshot() : { roomId: r.roomId, clients: r.clients };
                    });
                    const mem = process.memoryUsage();
                    res.json({ rooms: details, memoryMB: Math.round(mem.rss / 1048576), heapMB: Math.round(mem.heapUsed / 1048576) });
                } catch (err) {
                    // An async route error would otherwise be an unhandled rejection (fatal in Node).
                    console.error('[colorfront] /metrics failed:', err);
                    res.status(500).json({ error: 'metrics unavailable' });
                }
            });
        }
    });
}
