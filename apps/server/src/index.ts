import { DEFAULT_SERVER_PORT } from '@colorfront/shared';

import { createGameServer } from './app.ts';

const port = Number(process.env.PORT ?? DEFAULT_SERVER_PORT);
// Bind to localhost unless told otherwise; exposing the server is a deployment decision.
const host = process.env.HOST ?? '127.0.0.1';

// Colyseus shuts the process down on an uncaught exception; make sure the cause is always logged.
process.on('uncaughtException', (err) => console.error('[colorfront] uncaught exception:', err));
process.on('unhandledRejection', (reason) => console.error('[colorfront] unhandled rejection:', reason));
process.on('exit', (code) => console.error(`[colorfront] process exit ${code}`));

const server = createGameServer();
const latency = Number(process.env.SIMULATE_LATENCY_MS ?? 0);
if (latency > 0) server.simulateLatency(latency);

await server.listen(port, host);
console.log(`[colorfront] game server on ws://${host}:${port} (rooms: match)${latency ? `, simulated latency ${latency} ms` : ''}`);
