import {
    AIM,
    ClientMessage,
    DEFAULT_APPEARANCE,
    DEFAULT_LOOK,
    InputButton,
    LOOK_MIN_INTERVAL_MS,
    MOVEMENT,
    NEON_TERMINAL,
    PaintOwner,
    aimPivot,
    buildCollisionWorld,
    encodeAppearance,
    lookAt,
    paintPercent,
    stepPlayer
} from '@colorfront/shared';
import type { ChatMessage, PaintGrid } from '@colorfront/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { MatchRoom } from '../../apps/server/src/rooms/MatchRoom.ts';
import { NetProbe, hold, roomInstance, sleep, startServer, waitFor } from './netHarness.ts';

/**
 * Real Colyseus server on a random port + real SDK clients over WebSocket. The room, not the
 * test, decides movement, hits and paint; the test only moves players into position (server-side
 * test setup, the same as walking there) and checks what each client independently received.
 */

const world = buildCollisionWorld(NEON_TERMINAL);
const DOWN = -1.3; // pitch aiming steeply at the ground in front of the shooter
const FIRE = InputButton.Fire;

let server: Awaited<ReturnType<typeof startServer>>;
const open: NetProbe[] = [];

beforeAll(async () => {
    server = await startServer();
});
afterAll(async () => {
    await server.stop();
});
afterEach(async () => {
    while (open.length) {
        const p = open.pop()!;
        try {
            await p.room.leave(true);
        } catch {
            /* already closed */
        }
    }
});

async function pair(options: Record<string, unknown> = {}) {
    const a = await NetProbe.join(server.url, 'Alice', options);
    const b = await NetProbe.join(server.url, 'Bob', {}, a.probe.room.roomId);
    open.push(a.probe, b.probe);
    await waitFor(() => a.probe.state?.players?.size === 2 && b.probe.state?.players?.size === 2, 3000, 'both players in state');
    await waitFor(() => a.probe.receiver.seq >= 0 && b.probe.receiver.seq >= 0, 3000, 'initial paint snapshots');
    return { A: a.probe, B: b.probe, room: roomInstance(a.probe.room.roomId) };
}

/** Server-side test setup: put a player somewhere (like walking there) with spawn protection off. */
function place(room: MatchRoom, id: string, x: number, y: number, z: number) {
    const p = room.sim.get(id)!;
    p.position.x = x;
    p.position.y = y;
    p.position.z = z;
    p.velocity.x = p.velocity.y = p.velocity.z = 0;
    p.invulnerableTicks = 0;
}

function aimAt(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }) {
    let { yaw } = lookAt(from, to);
    let pitch = 0;
    for (let i = 0; i < 3; i++) {
        const pivot = aimPivot(world, from, yaw);
        ({ yaw, pitch } = lookAt(pivot, to));
    }
    return { yaw, pitch };
}

const surface = (paint: PaintGrid, id: string) => paint.surfaces.find((s) => s.solid.source.id === id)!;
function countIn(paint: PaintGrid, id: string, owner: number, box?: { x0: number; x1: number; z0: number; z1: number }) {
    const s = surface(paint, id);
    const owners = paint.owners[s.index];
    let n = 0;
    for (let row = 0; row < s.rows; row++) {
        for (let col = 0; col < s.cols; col++) {
            if (owners[row * s.cols + col] !== owner) continue;
            if (box) {
                const x = s.minX + (col + 0.5) * s.cellSize;
                const z = s.minZ + (row + 0.5) * s.cellSize;
                if (x < box.x0 || x > box.x1 || z < box.z0 || z > box.z1) continue;
            }
            n++;
        }
    }
    return n;
}

/** Wait until every client copy of the paint grid equals the server grid. */
async function settledPaint(room: MatchRoom, probes: NetProbe[]) {
    await waitFor(() => probes.every((p) => p.paint.hash() === room.sim.paint.hash()), 3000, 'paint hashes to converge');
}

describe('network: room, identity and teams', () => {
    it('puts two browsers in the same room on opposite teams and replicates both players', async () => {
        const { A, B, room } = await pair();
        expect(A.room.roomId).toBe(B.room.roomId);
        const aSeesB = A.state.players.get(B.sessionId);
        const bSeesA = B.state.players.get(A.sessionId);
        expect(aSeesB).toBeTruthy();
        expect(bSeesA).toBeTruthy();
        expect(A.me().team).toBe('blue');
        expect(B.me().team).toBe('orange');
        expect(bSeesA.team).toBe('blue');
        expect(A.hello?.sessionId).toBe(A.sessionId);
        expect(A.hello?.tickRate).toBe(30);
        expect(room.clients.length).toBe(2);
        expect(A.state.phase).toBe('WAITING');
    });

    it('sends prediction-only fields to their owner and nobody else', async () => {
        const { A, B, room } = await pair();
        place(room, A.sessionId, 0, 0, 10);
        await hold(A, 300, 0, 1, 0, 0, FIRE);
        await waitFor(() => (A.me().seq ?? 0) > 0, 2000, 'owner seq');
        const ownView = A.me();
        const otherView = B.state.players.get(A.sessionId);
        expect(ownView.seq).toBeGreaterThan(0);
        expect(ownView.vz).toBeDefined();
        // B still gets everything it draws A with…
        expect(otherView.x).toBeCloseTo(ownView.x, 3);
        expect(otherView.ammo).toBe(ownView.ammo);
        // …but none of A's prediction bookkeeping.
        for (const k of ['seq', 'vx', 'vy', 'vz', 'fireCd', 'dashCd', 'dashX', 'dashZ', 'invuln', 'respawn']) {
            expect(otherView[k], k).toBeUndefined();
        }
    });

    it('balances a third player onto the smaller team and sanitizes nicknames', async () => {
        const { A } = await pair();
        const c = await NetProbe.join(server.url, '<b>Mallory</b>\u0000', {}, A.room.roomId);
        open.push(c.probe);
        await waitFor(() => A.state.players.size === 3, 3000, 'third player');
        const me = c.probe.me();
        expect(me.team).toBe('blue'); // 1 v 1 → tie goes to blue
        expect(me.name).not.toMatch(/[<>/\u0000]/);
        expect(me.name.length).toBeLessThanOrEqual(12);
    });
});

describe('network: authoritative movement', () => {
    it('moves players only from inputs and ignores malformed or spoofed messages', async () => {
        const { A, B, room } = await pair();
        place(room, A.sessionId, 0, 0, 10);
        await sleep(100);
        const start = { ...room.sim.get(A.sessionId)!.position };
        // Spoofs: positions, damage, paint claims and wrong shapes are all rejected.
        A.room.send(ClientMessage.Input, { x: 999, y: 999, z: 999 });
        A.room.send(ClientMessage.Input, [1, 2, 3]);
        A.room.send(ClientMessage.Input, [5, 'x', 0, 0, 0, 0]);
        A.room.send(ClientMessage.Input, [6, NaN, 0, 0, 0, 0]);
        A.room.send('damage', { target: B.sessionId, amount: 100 });
        A.room.send('paint', { x: 0, z: 0, owner: 1 });
        await sleep(150);
        const after = room.sim.get(A.sessionId)!.position;
        expect(Math.hypot(after.x - start.x, after.z - start.z)).toBeLessThan(0.05);
        expect(room.sim.get(B.sessionId)!.hp).toBe(100);
        expect(room.sim.paint.blueCount).toBe(0);
        expect(room.metrics.rejected).toBe(6);

        // Forward for 1 s: the server moves the player at walking speed, and B sees it.
        await hold(A, 1000, 0, -1, 0, 0, 0);
        await sleep(150);
        const moved = room.sim.get(A.sessionId)!.position;
        const dist = Math.hypot(moved.x - start.x, moved.z - start.z);
        expect(dist).toBeGreaterThan(MOVEMENT.walkSpeed * 0.6);
        expect(dist).toBeLessThan(MOVEMENT.walkSpeed * 1.6);
        await waitFor(() => Math.abs(B.state.players.get(A.sessionId).z - moved.z) < 0.05, 2000, 'B sees A move');
    });

    it('cannot be sped up by flooding inputs (one input per tick, bounded queue)', async () => {
        const { A, room } = await pair();
        place(room, A.sessionId, 0, 0, 10);
        await sleep(100);
        const start = { ...room.sim.get(A.sessionId)!.position };
        for (let i = 0; i < 60; i++) A.input(0, -1, 0, 0, 0); // a 2-second burst sent at once
        const t0 = Date.now();
        await sleep(500);
        const elapsed = (Date.now() - t0) / 1000;
        const p = room.sim.get(A.sessionId)!.position;
        const dist = Math.hypot(p.x - start.x, p.z - start.z);
        // Never faster than walking, whatever was sent.
        expect(dist).toBeLessThan(MOVEMENT.walkSpeed * (elapsed + 0.15) * 1.1);
    });

    it('stops a player whose inputs stop arriving (stalled tab) instead of repeating them forever', async () => {
        const { A, room } = await pair();
        place(room, A.sessionId, 0, 0, 10);
        await sleep(100);
        // Run forward while firing, then go silent (no key-up ever arrives).
        await hold(A, 400, 0, -1, 0, 0, FIRE);
        await sleep(300); // jitter cover expires after a few ticks
        const p1 = { ...room.sim.get(A.sessionId)!.position };
        const ammo1 = room.sim.get(A.sessionId)!.ammo;
        await sleep(800);
        const p2 = room.sim.get(A.sessionId)!.position;
        expect(Math.hypot(p2.x - p1.x, p2.z - p1.z)).toBeLessThan(0.05);
        expect(room.sim.get(A.sessionId)!.ammo).toBe(ammo1);
    });

    it('simulates every input of a late burst exactly once (server ends where the client predicted)', async () => {
        const { A, room } = await pair();
        place(room, A.sessionId, 0, 0, 10);
        await sleep(600); // standing still, credits saved up
        const reference = structuredClone(room.sim.get(A.sessionId)!);
        const yaw = 0.4;
        // A frame hitch: 15 ticks of "forward" reach the server at once.
        for (let i = 0; i < 15; i++) A.input(0, 1, yaw, 0, 0);
        await sleep(1500);
        // Same inputs through the shared simulation, then idle until it stops.
        let seq = A.seq - 15;
        for (let i = 0; i < 15; i++) stepPlayer(reference, { seq: ++seq, moveX: 0, moveZ: 1, yaw, pitch: 0, buttons: 0 }, world);
        for (let i = 0; i < 40; i++) stepPlayer(reference, { seq, moveX: 0, moveZ: 0, yaw, pitch: 0, buttons: 0 }, world);
        const server = room.sim.get(A.sessionId)!.position;
        expect(Math.hypot(server.x - reference.position.x, server.z - reference.position.z)).toBeLessThan(1e-6);
        expect(Math.hypot(server.x, server.z - 10)).toBeGreaterThan(2); // it really moved
    });

    it('replicates jump and dash from inputs', async () => {
        const { A, B, room } = await pair();
        place(room, A.sessionId, 0, 0, 10);
        await sleep(100);
        A.input(0, 0, 0, 0, InputButton.Jump);
        await waitFor(() => B.state.players.get(A.sessionId).y > 0.3, 2000, 'B sees A airborne');
        await sleep(1200);
        const before = { ...room.sim.get(A.sessionId)!.position };
        A.input(0, -1, 0, 0, InputButton.Dash);
        await waitFor(() => B.state.players.get(A.sessionId).dash > 0 || Math.abs(room.sim.get(A.sessionId)!.position.z - before.z) > 3, 2000, 'dash');
        await hold(A, 400, 0, 0, 0, 0, 0);
        const after = room.sim.get(A.sessionId)!.position;
        expect(Math.abs(after.z - before.z)).toBeGreaterThan(3); // 4 m dash (+ a step of walking)
    });
});

describe('network: server-decided paint sync', () => {
    it('A paints blue, B overwrites orange; both clients converge on the server grid and percentages', async () => {
        const { A, B, room } = await pair();
        place(room, A.sessionId, 0, 0, 14);
        place(room, B.sessionId, 20, 0, 14);
        await hold(A, 600, 0, 0, 0, DOWN, FIRE);
        await hold(A, 150, 0, 0, 0, DOWN, 0);
        await settledPaint(room, [A, B]);
        const blueAfterA = room.sim.paint.blueCount;
        expect(blueAfterA).toBeGreaterThan(0);
        expect(A.paint.blueCount).toBe(blueAfterA);
        expect(B.paint.blueCount).toBe(blueAfterA);

        // B walks onto the same spot and overwrites with orange.
        place(room, B.sessionId, 0, 0, 14);
        await hold(B, 900, 0, 0, 0, DOWN, FIRE);
        await hold(B, 150, 0, 0, 0, DOWN, 0);
        await settledPaint(room, [A, B]);
        const score = room.sim.paint.score();
        expect(score.orange).toBeGreaterThan(0);
        expect(score.blue).toBeLessThan(blueAfterA);
        for (const p of [A, B]) {
            expect(p.paint.blueCount).toBe(score.blue);
            expect(p.paint.orangeCount).toBe(score.orange);
            expect(p.paint.hash()).toBe(room.sim.paint.hash());
        }
        // The replicated score (what the HUD shows) agrees with each client's own grid.
        await waitFor(() => A.state.orange === score.orange && B.state.orange === score.orange, 2000, 'state score');
        const pctA = paintPercent(A.paint.orangeCount, A.paint.paintableCount);
        const pctB = paintPercent(B.state.orange, B.state.paintable);
        expect(pctA).toBeCloseTo(pctB, 10);
        expect(A.receiver.gaps + B.receiver.gaps).toBe(0);
    });

    it('keeps the bridge deck and the floor under it independent over the network', async () => {
        const { A, B, room } = await pair();
        const under = { x0: -12, x1: 12, z0: -52, z1: -40 };
        place(room, A.sessionId, 0, 7, -46); // on the bridge deck (y = 7)
        place(room, B.sessionId, 0, 0, -46); // directly below it
        await sleep(100);
        await Promise.all([hold(A, 700, 0, 0, 0, DOWN, FIRE), hold(B, 700, 0, 0, 0, DOWN, FIRE)]);
        await Promise.all([hold(A, 150, 0, 0, 0, DOWN, 0), hold(B, 150, 0, 0, 0, DOWN, 0)]);
        await settledPaint(room, [A, B]);
        for (const g of [room.sim.paint, A.paint, B.paint]) {
            expect(countIn(g, 'bridge', PaintOwner.Blue)).toBeGreaterThan(0);
            expect(countIn(g, 'bridge', PaintOwner.Orange)).toBe(0);
            expect(countIn(g, 'floor', PaintOwner.Orange, under)).toBeGreaterThan(0);
            expect(countIn(g, 'floor', PaintOwner.Blue, under)).toBe(0);
        }
    });

    it('gives a late joiner a full snapshot of the current paint, then deltas', async () => {
        const { A, room } = await pair();
        place(room, A.sessionId, -10, 0, 5);
        await hold(A, 500, 0, 0, 0, DOWN, FIRE);
        await hold(A, 100, 0, 0, 0, DOWN, 0);
        const c = await NetProbe.join(server.url, 'Late', {}, A.room.roomId);
        open.push(c.probe);
        await waitFor(() => c.probe.receiver.seq >= 0, 3000, 'snapshot');
        expect(c.probe.receiver.snapshots).toBe(1);
        await settledPaint(room, [A, c.probe]);
        expect(c.probe.paint.blueCount).toBe(room.sim.paint.blueCount);
        place(room, A.sessionId, 10, 0, 5);
        await hold(A, 400, 0, 0, 0, DOWN, FIRE);
        await hold(A, 100, 0, 0, 0, DOWN, 0);
        await settledPaint(room, [A, c.probe]);
        expect(c.probe.receiver.deltas).toBeGreaterThan(0);
        expect(c.probe.receiver.snapshots).toBe(1);
    });

    it('periodic hash messages let clients verify their grid', async () => {
        const { A, B, room } = await pair();
        place(room, A.sessionId, 0, 0, 14);
        await hold(A, 400, 0, 0, 0, DOWN, FIRE);
        await hold(A, 100, 0, 0, 0, DOWN, 0);
        const n = A.hashes.length;
        await waitFor(() => A.hashes.length > n && B.hashes.length > n, 4000, 'hash broadcast');
        const last = A.hashes[A.hashes.length - 1];
        expect(last.hash).toBe(room.sim.paint.hash());
        // When the hash arrives, the client has already applied every delta up to its seq.
        expect(A.receiver.seq).toBeGreaterThanOrEqual(last.seq);
        expect(A.paint.hash()).toBe(last.hash);
        expect(B.paint.hash()).toBe(last.hash);
    });
});

describe('network: server-decided combat', () => {
    it('A shoots B: hits and the splat are decided by the server and seen identically by both', async () => {
        const { A, B, room } = await pair();
        place(room, A.sessionId, 0, 0, 14);
        place(room, B.sessionId, 0, 0, 6);
        await sleep(100);
        const target = { x: 0, y: AIM.pivotHeight - 0.4, z: 6 };
        const { yaw, pitch } = aimAt({ x: 0, y: 0, z: 14 }, target);
        const deadline = Date.now() + 4000;
        while (!A.events.some((e) => e.t === 'k') && Date.now() < deadline) {
            await hold(A, 100, 0, 0, yaw, pitch, FIRE);
        }
        await hold(A, 100, 0, 0, yaw, pitch, 0);
        await waitFor(() => B.events.some((e) => e.t === 'k'), 2000, 'B sees the splat');
        const hitsA = A.events.filter((e) => e.t === 'h' && e.a === A.sessionId && e.v === B.sessionId);
        const hitsB = B.events.filter((e) => e.t === 'h' && e.a === A.sessionId && e.v === B.sessionId);
        expect(hitsA.length).toBeGreaterThanOrEqual(7); // 100 HP / 14 per hit
        expect(hitsB.length).toBe(hitsA.length);
        const kill = A.events.find((e) => e.t === 'k')!;
        expect(kill).toMatchObject({ t: 'k', a: A.sessionId, v: B.sessionId });
        expect(room.sim.get(B.sessionId)!.alive).toBe(false);
        await waitFor(() => B.me().alive === false && A.state.players.get(B.sessionId).alive === false, 2000, 'dead in state');
        await waitFor(() => A.me().kills === 1 && B.me().deaths === 1, 2000, 'kill/death stats');
        // Remote players see A's shots (for the firing animation and tracers).
        expect(B.events.filter((e) => e.t === 's' && e.p === A.sessionId).length).toBeGreaterThanOrEqual(hitsA.length);
        // Respawn after the server's 5 s timer.
        await waitFor(() => B.me().alive === true, 7000, 'respawn');
        expect(B.events.some((e) => e.t === 'r' && e.p === B.sessionId)).toBe(true);
    }, 20000);

    it('reloads on the server: ammo drains while firing and refills after a reload', async () => {
        const { A, room } = await pair();
        place(room, A.sessionId, 0, 0, 14);
        await hold(A, 600, 0, 0, 0, DOWN, FIRE);
        const drained = room.sim.get(A.sessionId)!.ammo;
        expect(drained).toBeLessThan(36);
        A.input(0, 0, 0, DOWN, InputButton.Reload);
        await hold(A, 2500, 0, 0, 0, DOWN, 0);
        await waitFor(() => A.me().ammo === 36, 2000, 'magazine refilled');
    });
});

describe('network: match flow and results', () => {
    it('ready → countdown → playing → results: both clients get the same frozen result', async () => {
        const timing = { countdownSeconds: 0.5, playingSeconds: 2.5, resultsRevealSeconds: 0.3, resultsSummarySeconds: 0.7 };
        const { A, B, room } = await pair({ timing });
        // Warm-up paint during WAITING is wiped by the round reset.
        place(room, A.sessionId, 0, 0, 14);
        await hold(A, 300, 0, 0, 0, DOWN, FIRE);
        A.room.send(ClientMessage.Ready, true);
        B.room.send(ClientMessage.Ready, true);
        await waitFor(() => A.state.phase === 'COUNTDOWN', 2000, 'countdown');
        await waitFor(() => A.paint.blueCount === 0 && B.paint.blueCount === 0, 2000, 'round reset paint');
        await waitFor(() => A.state.phase === 'PLAYING' && B.state.phase === 'PLAYING', 2000, 'playing');
        place(room, A.sessionId, 0, 0, 14);
        await hold(A, 900, 0, 0, 0, DOWN, FIRE);
        await waitFor(() => A.results.length === 1 && B.results.length === 1, 4000, 'round result');
        const [ra] = A.results;
        const [rb] = B.results;
        expect(ra).toEqual(rb);
        expect(ra.winner).toBe('blue');
        expect(ra.blue).toBeGreaterThan(0);
        expect(ra.orange).toBe(0);
        expect(ra.hash).toBe(A.paint.hash());
        expect(ra.hash).toBe(B.paint.hash());
        expect(ra.players.find((p) => p.id === A.sessionId)!.painted).toBeGreaterThan(0);
        await waitFor(() => A.state.phase === 'RESULTS' && B.state.phase === 'RESULTS', 1000, 'results phase');
        // Input during RESULTS does nothing.
        const frozen = room.sim.paint.hash();
        await hold(A, 300, 0, 0, 0, DOWN, FIRE);
        expect(room.sim.paint.hash()).toBe(frozen);
        await waitFor(() => A.state.phase === 'WAITING' && A.state.round === 2, 3000, 'next round');
        expect(A.me().ready).toBe(false);
        expect(room.metrics.errors).toBe(0);
    }, 20000);
});

describe('network: disconnect and reconnect', () => {
    it('keeps the seat for a dropped player, then resyncs paint after reconnecting', async () => {
        const { A, B, room } = await pair();
        const sid = A.sessionId;
        A.room.reconnection.minUptime = 0;
        const dropped = new Promise<void>((r) => A.room.onDrop.once(() => r()));
        const back = new Promise<void>((r) => A.room.onReconnect.once(() => r()));
        A.room.connection.close(4010, 'test drop');
        await dropped;
        await waitFor(() => B.state.players.get(sid)?.connected === false, 3000, 'B sees A disconnected');
        // Meanwhile B paints; A must catch up from a snapshot.
        place(room, B.sessionId, 5, 0, 5);
        await hold(B, 500, 0, 0, 0, DOWN, FIRE);
        await hold(B, 100, 0, 0, 0, DOWN, 0);
        await back;
        expect(A.sessionId).toBe(sid);
        await waitFor(() => B.state.players.get(sid)?.connected === true, 3000, 'B sees A reconnected');
        expect(A.me().team).toBe('blue');
        await settledPaint(room, [A, B]);
        expect(A.paint.orangeCount).toBe(room.sim.paint.orangeCount);
        expect(A.receiver.snapshots).toBeGreaterThanOrEqual(2);
    }, 15000);

    it('removes a player who leaves on purpose', async () => {
        const { A, B } = await pair();
        const sid = B.sessionId;
        await B.room.leave(true);
        open.splice(open.indexOf(B), 1);
        await waitFor(() => !A.state.players.has(sid), 3000, 'player removed');
    });
});

describe('network: avatar outfit replication (Gate 3-B, cosmetic only)', () => {
    const SHELL = encodeAppearance({ ...DEFAULT_APPEARANCE, topId: 'top_hardshell', hairId: 'hair_crew', headwearId: 'headwear_cap' });
    const SHORTS = encodeAppearance({ ...DEFAULT_APPEARANCE, bottomId: 'bottom_short' });

    it('replicates the outfit chosen at join to every client, and sanitizes forged ones', async () => {
        const a = await NetProbe.join(server.url, 'Alice', { look: SHELL });
        const b = await NetProbe.join(server.url, 'Bob', { look: 'https://evil.example/hair.glb' }, a.probe.room.roomId);
        open.push(a.probe, b.probe);
        const A = a.probe;
        const B = b.probe;
        await waitFor(() => A.state?.players?.size === 2 && B.state?.players?.size === 2, 3000, 'both in state');
        expect(B.state.players.get(A.sessionId).look).toBe(SHELL);
        expect(A.state.players.get(B.sessionId).look).toBe(DEFAULT_LOOK);
        expect(A.me().look).toBe(SHELL);
    });

    it('changes on request, rate limits, rejects forged values and never touches gameplay state', async () => {
        const { A, B, room } = await pair();
        const id = A.sessionId;
        expect(B.state.players.get(id).look).toBe(DEFAULT_LOOK);
        const sim = room.sim.get(id)!;
        const before = { team: sim.team, hp: sim.hp, ammo: sim.ammo, x: sim.position.x, z: sim.position.z };
        const rejected0 = room.metrics.rejected;
        A.room.send(ClientMessage.Look, SHELL);
        await waitFor(() => B.state.players.get(id).look === SHELL, 3000, 'B sees the new outfit');
        // A second change inside the interval is dropped (and counted).
        A.room.send(ClientMessage.Look, SHORTS);
        await sleep(200);
        expect(B.state.players.get(id).look).toBe(SHELL);
        expect(room.metrics.rejected).toBe(rejected0 + 1);
        await sleep(LOOK_MIN_INTERVAL_MS);
        // Forged values after the interval: still rejected, look unchanged.
        // (Messages above the transport's max payload close the socket outright; 200 chars stays below it.)
        for (const bad of ['1:9.9.9.9.9.9.9.9', { topId: 'x' }, '1:' + '0.'.repeat(100), 42]) A.room.send(ClientMessage.Look, bad);
        await sleep(200);
        expect(B.state.players.get(id).look).toBe(SHELL);
        expect(room.metrics.rejected).toBe(rejected0 + 5);
        // A valid change after the interval goes through.
        A.room.send(ClientMessage.Look, SHORTS);
        await waitFor(() => B.state.players.get(id).look === SHORTS, 3000, 'second change replicated');
        const after = room.sim.get(id)!;
        expect({ team: after.team, hp: after.hp, ammo: after.ammo, x: after.position.x, z: after.position.z }).toEqual(before);
    });

    it('keeps the outfit for a late joiner and across a reconnect', async () => {
        const { A, B } = await pair();
        const id = A.sessionId;
        A.room.send(ClientMessage.Look, SHELL);
        await waitFor(() => B.state.players.get(id).look === SHELL, 3000, 'B sees outfit');
        const late = await NetProbe.join(server.url, 'Cara', {}, A.room.roomId);
        open.push(late.probe);
        await waitFor(() => late.probe.state?.players?.get(id)?.look === SHELL, 3000, 'late joiner sees outfit');
        A.room.reconnection.minUptime = 0;
        const back = new Promise<void>((r) => A.room.onReconnect.once(() => r()));
        A.room.connection.close(4010, 'test drop');
        await back;
        await waitFor(() => B.state.players.get(id)?.connected === true, 3000, 'reconnected');
        expect(A.sessionId).toBe(id);
        expect(B.state.players.get(id).look).toBe(SHELL);
        expect(A.me().look).toBe(SHELL);
    }, 15000);
});

describe('network: weapons (Phase 6)', () => {
    it('replicates the chosen weapon, fires every shotgun pellet and rejects forged choices', async () => {
        const { A, B, room } = await pair();
        const id = A.sessionId;
        const rejected0 = room.metrics.rejected;
        // Still in the spawn zone: the switch is immediate.
        A.room.send(ClientMessage.Weapon, 'splash-shotgun');
        await waitFor(() => B.state.players.get(id).weapon === 'splash-shotgun', 3000, 'B sees the shotgun');
        expect(A.me().ammo).toBe(8);
        await sleep(300);
        for (const bad of ['rocket', { id: 'long-sniper' }, 42]) A.room.send(ClientMessage.Weapon, bad);
        await sleep(200);
        expect(room.metrics.rejected).toBe(rejected0 + 3);
        expect(B.state.players.get(id).weapon).toBe('splash-shotgun');
        // One trigger pull = 7 pellet events for everybody.
        const before = B.events.filter((e) => e.t === 's' && e.p === id).length;
        place(room, id, 0, 0, 13);
        await hold(A, 120, 0, 0, -Math.PI / 2, -0.4, FIRE);
        await hold(A, 100, 0, 0, -Math.PI / 2, -0.4, 0);
        await sleep(200);
        const pellets = B.events.filter((e) => e.t === 's' && e.p === id).length - before;
        expect(pellets).toBe(7);
        // Outside the spawn zone a new choice waits for the respawn (owner sees it queued).
        await sleep(300);
        A.room.send(ClientMessage.Weapon, 'long-sniper');
        await waitFor(() => A.me().nextWeapon === 'long-sniper', 3000, 'queued for respawn');
        expect(B.state.players.get(id).weapon).toBe('splash-shotgun');
        expect(B.state.players.get(id).nextWeapon).toBeUndefined();
    });
});

describe('network: chat (Phase 6)', () => {
    const listen = (probe: NetProbe) => {
        const got: ChatMessage[] = [];
        probe.room.onMessage('chat', (m: ChatMessage | ChatMessage[]) => got.push(...(Array.isArray(m) ? m : [m])));
        return got;
    };

    it('broadcasts sanitized lines with the server-side name/team, rate limited', async () => {
        const { A, B, room } = await pair();
        const gotA = listen(A);
        const gotB = listen(B);
        const rejected0 = room.metrics.rejected;
        A.room.send(ClientMessage.Chat, { text: '  안녕‮ 하세요  <b>bold</b>  ', team: false });
        await waitFor(() => gotB.length === 1, 3000, 'B gets the line');
        const line = gotB[0];
        expect(line.text).toBe('안녕 하세요 <b>bold</b>'); // control/bidi chars stripped; markup stays inert text
        expect(line.name).toBe('Alice');
        expect(line.team).toBe('blue');
        expect(line.scope).toBe('all');
        expect(gotA).toHaveLength(1); // the sender sees its own line from the server
        // Length cap.
        await sleep(1600);
        A.room.send(ClientMessage.Chat, { text: 'x'.repeat(300) });
        await waitFor(() => gotB.length === 2, 3000, 'long line');
        expect(Array.from(gotB[1].text)).toHaveLength(80);
        // Burst of 6: the bucket (3, refilling 1 per 1.5 s) lets some through and rejects the rest.
        for (let i = 0; i < 6; i++) A.room.send(ClientMessage.Chat, { text: `spam ${i}` });
        await sleep(400);
        const spam = gotB.filter((m) => m.text.startsWith('spam')).length;
        expect(spam).toBeGreaterThanOrEqual(1);
        expect(spam).toBeLessThanOrEqual(3);
        expect(room.metrics.rejected - rejected0).toBe(6 - spam);
        // Forged payloads are rejected.
        for (const bad of [42, { text: 7 }, { text: '   ' }, null]) A.room.send(ClientMessage.Chat, bad);
        await sleep(200);
        expect(room.metrics.rejected - rejected0).toBe(6 - spam + 4);
    });

    it('team lines only reach teammates; late joiners get the public history', async () => {
        const { A, B } = await pair();
        const third = await NetProbe.join(server.url, 'Cara', {}, A.room.roomId); // balances onto blue (A's team)
        open.push(third.probe);
        const C = third.probe;
        await waitFor(() => C.state?.players?.get(C.sessionId)?.team !== undefined, 3000, 'C in state');
        expect(C.me().team).toBe('blue');
        const gotB = listen(B);
        const gotC = listen(C);
        A.room.send(ClientMessage.Chat, { text: '팀 작전', team: true });
        await waitFor(() => gotC.length === 1, 3000, 'teammate gets it');
        await sleep(300);
        expect(gotC[0].scope).toBe('team');
        expect(gotB).toHaveLength(0);
        A.room.send(ClientMessage.Chat, { text: '모두 안녕' });
        await waitFor(() => gotB.length === 1, 3000, 'public line');
        const late = await NetProbe.join(server.url, 'Dan', {}, A.room.roomId);
        open.push(late.probe);
        const gotD = listen(late.probe);
        await waitFor(() => gotD.length >= 1, 3000, 'history');
        expect(gotD.map((m) => m.text)).toContain('모두 안녕');
        expect(gotD.map((m) => m.text)).not.toContain('팀 작전');
    });
});
