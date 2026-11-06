import { createServer } from 'node:net';

import {
    ClientMessage,
    NEON_TERMINAL,
    PaintGrid,
    PaintReceiver,
    ROOM_NAME,
    ServerMessage,
    buildCollisionWorld
} from '@colorfront/shared';
import type { EventsMessage, HelloMessage, NetEvent, PaintHashMessage, RoundResultMessage } from '@colorfront/shared';
import { matchMaker } from '@colyseus/core';
import { Client, type Room } from '@colyseus/sdk';

import { createGameServer } from '../../apps/server/src/app.ts';
import type { MatchRoom, MatchRoomOptions } from '../../apps/server/src/rooms/MatchRoom.ts';

const world = buildCollisionWorld(NEON_TERMINAL);

export async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const port = (srv.address() as { port: number }).port;
            srv.close(() => resolve(port));
        });
    });
}

export async function startServer() {
    const port = await freePort();
    const server = createGameServer();
    await server.listen(port, '127.0.0.1');
    return {
        port,
        url: `ws://127.0.0.1:${port}`,
        stop: () => server.gracefullyShutdown(false)
    };
}

export const roomInstance = (roomId: string) => matchMaker.getLocalRoomById(roomId) as unknown as MatchRoom;

/**
 * A headless network player: a real SDK connection that keeps its own copy of the paint grid,
 * built only from server messages, exactly like the browser client does.
 */
export class NetProbe {
    readonly room: Room;
    readonly paint = new PaintGrid(world, NEON_TERMINAL);
    readonly receiver = new PaintReceiver(this.paint);
    hello: HelloMessage | null = null;
    readonly hashes: PaintHashMessage[] = [];
    readonly events: NetEvent[] = [];
    readonly results: RoundResultMessage[] = [];
    seq = 0;

    private constructor(room: Room) {
        this.room = room;
        room.onMessage(ServerMessage.Hello, (m: HelloMessage) => (this.hello = m));
        room.onMessage(ServerMessage.PaintSnapshot, (b: Uint8Array) => this.onPaint(b));
        room.onMessage(ServerMessage.PaintDelta, (b: Uint8Array) => this.onPaint(b));
        room.onMessage(ServerMessage.PaintHash, (m: PaintHashMessage) => this.hashes.push(m));
        room.onMessage(ServerMessage.Events, (m: EventsMessage) => this.events.push(...m.ev));
        room.onMessage(ServerMessage.RoundResult, (m: RoundResultMessage) => this.results.push(m));
        room.onMessage('metrics', () => {});
    }

    static async join(url: string, name: string, options: MatchRoomOptions & { look?: unknown } = {}, roomId?: string) {
        const client = new Client(url);
        const room = roomId ? await client.joinById(roomId, { name, ...options }) : await client.create(ROOM_NAME, { name, ...options });
        const probe = new NetProbe(room);
        return { client, probe };
    }

    private onPaint(bytes: Uint8Array) {
        if (this.receiver.receive(bytes, Date.now()) === 'gap') this.room.send(ClientMessage.PaintResync);
        // Keep the dirty rects drained like the renderer would.
        for (let i = 0; i < this.paint.surfaces.length; i++) this.paint.takeDirty(i);
    }

    get sessionId() {
        return this.room.sessionId;
    }

    get state(): any {
        return this.room.state;
    }

    me(): any {
        return this.state.players.get(this.sessionId);
    }

    input(moveX: number, moveZ: number, yaw: number, pitch: number, buttons: number) {
        this.room.send(ClientMessage.Input, [++this.seq, moveX, moveZ, yaw, pitch, buttons]);
    }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean, timeoutMs = 5000, label = 'condition') {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label}`);
        await sleep(10);
    }
}

/** Send the same input at 30 Hz for `ms` milliseconds (what a held key does in the browser). */
export async function hold(probe: NetProbe, ms: number, moveX: number, moveZ: number, yaw: number, pitch: number, buttons: number) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        probe.input(moveX, moveZ, yaw, pitch, buttons);
        await sleep(1000 / 30);
    }
}
