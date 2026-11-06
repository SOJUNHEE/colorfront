import type { IncomingMessage } from 'node:http';

import { ROOM_NAME } from '@colorfront/shared';
import { defineRoom, defineServer, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import express from 'express';

import { metricsAllowed, originAllowed, readDeployConfig } from './deploy.ts';
import type { DeployConfig } from './deploy.ts';
import { MatchRoom } from './rooms/MatchRoom.ts';

/**
 * Build (but do not start) the game server. `index.ts` listens on a port; tests create their
 * own instance on a random port. In production the same process also serves the built client
 * (STATIC_DIR), so the page and the WebSocket share one origin (wss via the platform's TLS).
 */
export function createGameServer(cfg: DeployConfig = readDeployConfig()) {
    // Matchmaking HTTP routes are handled by Colyseus before express: restrict them through its
    // CORS hook (a page on another origin cannot read the seat reservation). The game socket
    // itself is refused by `verifyClient` below, which is the actual gate.
    matchMaker.controller.getCorsHeaders = (headers: Headers): Record<string, string> => {
        const origin = headers.get('origin');
        if (!origin) return {};
        return originAllowed(origin, cfg.allowedOrigins, headers.get('host') ?? undefined)
            ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
            : { 'Access-Control-Allow-Origin': 'null', Vary: 'Origin' };
    };
    return defineServer({
        transport: new WebSocketTransport({
            verifyClient: (info: { origin?: string; req: IncomingMessage }) =>
                originAllowed(info.origin, cfg.allowedOrigins, info.req.headers.host)
        }),
        greet: false,
        rooms: {
            [ROOM_NAME]: defineRoom(MatchRoom)
        },
        express: (app) => {
            app.disable('x-powered-by');
            app.use((_req, res, next) => {
                res.setHeader('X-Content-Type-Options', 'nosniff');
                res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
                res.setHeader('X-Frame-Options', 'DENY');
                next();
            });
            app.get('/health', (_req, res) => {
                res.json({ ok: true, uptimeSec: Math.round(process.uptime()) });
            });
            // Read-only diagnostics for load tests (no player data beyond counts). Token-protected
            // in production (METRICS_TOKEN); closed there if no token is configured.
            app.get('/metrics', async (req, res) => {
                if (!metricsAllowed(cfg, req.headers.authorization, req.query.token)) {
                    res.status(404).end();
                    return;
                }
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
            if (cfg.staticDir) {
                // Hashed build output can be cached for long; models/textures for a day; the page never.
                app.use(
                    express.static(cfg.staticDir, {
                        index: false,
                        setHeaders: (res, file) => {
                            const hashed = /[\\/]assets[\\/][^\\/]+-[A-Za-z0-9_-]{8,}\.(js|css)$/.test(file);
                            res.setHeader('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=86400');
                        }
                    })
                );
                const index = `${cfg.staticDir}/index.html`;
                app.get(['/', '/index.html'], (_req, res) => {
                    res.setHeader('Cache-Control', 'no-cache');
                    res.sendFile(index);
                });
            }
        }
    });
}
