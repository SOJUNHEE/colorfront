import {
    MatchFlow,
    NEON_TERMINAL,
    PAINT_DELTA,
    PAINT_SNAPSHOT,
    PaintGrid,
    PaintOwner,
    PaintReceiver,
    applyPaintMessage,
    encodePaintDelta,
    encodePaintSnapshot,
    flowTiming,
    packShot,
    packVec,
    peekPaintMessage,
    unpackShot,
    unpackVec
} from '@colorfront/shared';
import { describe, expect, it } from 'vitest';

import { parseInput, sanitizeName } from '../../apps/server/src/security.ts';
import { rng, world } from './helpers.ts';

const UP = { x: 0, y: 1, z: 0 };
const grid = () => new PaintGrid(world, NEON_TERMINAL);

function splatter(paint: PaintGrid, n: number, seed: number) {
    const r = rng(seed);
    for (let i = 0; i < n; i++) {
        const x = -50 + r() * 100;
        const z = -55 + r() * 110;
        const y = z < -32 && Math.abs(x) > 12 ? 7 : 0;
        paint.paintSphere({ x, y, z }, 1 + r() * 2, r() < 0.5 ? 'blue' : 'orange', UP);
    }
}

describe('paint sync codec', () => {
    it('a snapshot reproduces the grid exactly and is compact', () => {
        const server = grid();
        splatter(server, 300, 7);
        const bytes = encodePaintSnapshot(server, 42);
        expect(peekPaintMessage(bytes)).toEqual({ kind: PAINT_SNAPSHOT, seq: 42 });
        const client = grid();
        applyPaintMessage(client, bytes);
        expect(client.hash()).toBe(server.hash());
        expect(client.blueCount).toBe(server.blueCount);
        expect(client.orangeCount).toBe(server.orangeCount);
        // RLE: far smaller than one byte per cell.
        const cells = server.owners.reduce((n, o) => n + o.length, 0);
        expect(bytes.length).toBeLessThan(cells / 4);
        // An empty grid is a few bytes per surface.
        expect(encodePaintSnapshot(grid(), 0).length).toBeLessThan(200);
    });

    it('deltas carry only dirty rectangles and keep a client copy identical over many ticks', () => {
        const server = grid();
        const client = grid();
        applyPaintMessage(client, encodePaintSnapshot(server, 0));
        server.discardDirty();
        const r = rng(3);
        let seq = 0;
        for (let tick = 1; tick <= 200; tick++) {
            if (r() < 0.6) splatter(server, 1 + Math.floor(r() * 3), tick);
            const delta = encodePaintDelta(server, seq + 1, tick);
            if (!delta) continue;
            seq++;
            expect(peekPaintMessage(delta)).toEqual({ kind: PAINT_DELTA, seq });
            expect(delta.length).toBeLessThan(600); // a few splats: tiles + RLE, not a bounding box
            applyPaintMessage(client, delta);
            expect(client.blueCount).toBe(server.blueCount);
            expect(client.orangeCount).toBe(server.orangeCount);
        }
        expect(client.hash()).toBe(server.hash());
        expect(encodePaintDelta(server, seq + 1, 999)).toBeNull(); // nothing changed
    });

    it('dirty tiles split far-apart splats into separate small rects', () => {
        const paint = grid();
        paint.discardDirty();
        paint.paintSphere({ x: -20, y: 0, z: 18 }, 1.5, 'blue', UP);
        paint.paintSphere({ x: 20, y: 0, z: -18 }, 1.5, 'orange', UP);
        const floor = paint.surfaces.find((x) => x.solid.source.id === 'floor')!;
        const rects = paint.takeDirtyRects(floor.index);
        expect(rects.length).toBe(2);
        const area = rects.reduce((n, r) => n + r[2] * r[3], 0);
        expect(area).toBeLessThanOrEqual(2 * 16 * 16); // at most 2×2 tiles each
        expect(paint.takeDirtyRects(floor.index)).toEqual([]);
        expect(paint.takeDirty(floor.index)).toBeNull();
        // A full clear collapses to one rect per surface.
        paint.clear();
        expect(paint.takeDirtyRects(floor.index)).toEqual([[0, 0, floor.cols, floor.rows]]);
    });

    it('applyRect never paints masked cells and rejects out-of-range rects', () => {
        const paint = grid();
        const s = paint.surfaces.find((x) => x.solid.source.id === 'floor')!;
        const all = new Uint8Array(s.cols * s.rows).fill(PaintOwner.Blue);
        paint.applyRect(s.index, 0, 0, s.cols, s.rows, all);
        const mask = paint.masks[s.index];
        const owners = paint.owners[s.index];
        let painted = 0;
        for (let i = 0; i < mask.length; i++) {
            if (!mask[i]) expect(owners[i]).toBe(PaintOwner.None);
            else painted++;
        }
        expect(paint.blueCount).toBe(painted);
        expect(() => paint.applyRect(s.index, s.cols - 1, 0, 2, 1, all)).toThrow(RangeError);
        expect(() => paint.applyRect(999, 0, 0, 1, 1, all)).toThrow(RangeError);
    });

    it('rejects a snapshot built for a different map layout', () => {
        const bytes = encodePaintSnapshot(grid(), 0);
        bytes[6] ^= 0xff; // corrupt the first surface size
        expect(() => applyPaintMessage(grid(), bytes)).toThrow(RangeError);
    });

    it('hash changes with any single cell and matches for equal grids', () => {
        const a = grid();
        const b = grid();
        expect(a.hash()).toBe(b.hash());
        a.paintSphere({ x: 10.25, y: 0, z: 10.25 }, 0.2, 'orange', UP);
        expect(a.orangeCount).toBe(1);
        expect(a.hash()).not.toBe(b.hash());
    });
});

describe('paint receiver ordering', () => {
    function stream() {
        const server = grid();
        const msgs: Uint8Array[] = [encodePaintSnapshot(server, 0)];
        server.discardDirty();
        for (let i = 1; i <= 5; i++) {
            server.paintSphere({ x: i * 4, y: 0, z: 12 }, 1.5, 'blue', UP);
            msgs.push(encodePaintDelta(server, i, i)!);
        }
        return { server, msgs };
    }

    it('ignores deltas before the first snapshot and duplicates after it', () => {
        const { server, msgs } = stream();
        const rx = new PaintReceiver(grid());
        expect(rx.receive(msgs[1])).toBe('waiting');
        expect(rx.receive(msgs[0])).toBe('applied');
        for (let i = 1; i <= 5; i++) expect(rx.receive(msgs[i])).toBe('applied');
        expect(rx.receive(msgs[3])).toBe('stale');
        expect(rx.paint.hash()).toBe(server.hash());
    });

    it('detects a gap, waits for a snapshot and then resumes', () => {
        const { server, msgs } = stream();
        const rx = new PaintReceiver(grid());
        rx.receive(msgs[0]);
        rx.receive(msgs[1]);
        expect(rx.receive(msgs[3])).toBe('gap');
        expect(rx.receive(msgs[4])).toBe('waiting'); // no repeated resync requests
        expect(rx.receive(encodePaintSnapshot(server, 5))).toBe('applied');
        expect(rx.resyncing).toBe(false);
        expect(rx.paint.hash()).toBe(server.hash());
        expect(rx.gaps).toBe(1);
    });
});

describe('match flow (server phase machine)', () => {
    const timing = flowTiming({ countdownSeconds: 1, playingSeconds: 2, resultsRevealSeconds: 0.5, resultsSummarySeconds: 1 });

    it('waits for enough ready players, counts down, plays, shows results and loops', () => {
        const flow = new MatchFlow(timing, 2);
        expect(flow.step(1, 1)).toBeNull();
        expect(flow.step(2, 1)).toBeNull();
        expect(flow.acceptsInput).toBe(true); // warm-up
        expect(flow.step(2, 2)).toMatchObject({ from: 'WAITING', to: 'COUNTDOWN' });
        expect(flow.acceptsInput).toBe(false);
        let change = null;
        let ticks = 0;
        while (!(change = flow.step(2, 2))) ticks++;
        expect(change).toMatchObject({ to: 'PLAYING' });
        expect(ticks + 1).toBe(timing.countdownTicks);
        ticks = 0;
        while (!(change = flow.step(2, 0))) ticks++;
        expect(change).toMatchObject({ to: 'RESULTS', round: 1 });
        expect(ticks + 1).toBe(timing.playingTicks);
        expect(flow.resultsStage).toBe('reveal');
        for (let i = 0; i < timing.revealTicks; i++) flow.step(2, 0);
        expect(flow.resultsStage).toBe('summary');
        while (!(change = flow.step(2, 0)));
        expect(change).toMatchObject({ from: 'RESULTS', to: 'WAITING' });
        expect(flow.round).toBe(2);
    });

    it('aborts the countdown when players leave', () => {
        const flow = new MatchFlow(timing, 2);
        flow.step(2, 2);
        expect(flow.step(1, 1)).toMatchObject({ from: 'COUNTDOWN', to: 'WAITING' });
    });

    it('PLAYING ends on time even if everyone disconnects', () => {
        const flow = new MatchFlow(timing, 2);
        flow.step(2, 2);
        while (flow.phase === 'COUNTDOWN') flow.step(2, 2);
        for (let i = 0; i < timing.playingTicks; i++) flow.step(0, 0);
        expect(flow.phase).toBe('RESULTS');
    });
});

describe('compact shot events', () => {
    it('round-trips flight end, impact, normal and hit to within half a centimetre', () => {
        const shot = { flightEnd: { x: 12.3456, y: 1.004, z: -40.111 }, impact: { x: 12.3456, y: 1.004, z: -40.111 }, normal: { x: 0, y: 1, z: 0 }, dropped: false, hitPlayerId: 'abc' };
        const ev = packShot('p1', shot);
        expect(ev.i).toBeUndefined(); // impact == flight end is not repeated
        expect(ev).not.toHaveProperty('team');
        const back = unpackShot(ev);
        expect(back.flightEnd.x).toBeCloseTo(12.3456, 2);
        expect(back.impact).toEqual(back.flightEnd);
        expect(back.normal).toEqual({ x: 0, y: 1, z: 0 });
        expect(back.hitPlayerId).toBe('abc');
        expect(back.dropped).toBe(false);
    });

    it('keeps a dropped shot\'s separate impact and a shot with no impact at all', () => {
        const dropped = unpackShot(packShot('p', { flightEnd: { x: 0, y: 2, z: 25 }, impact: { x: 0, y: 0, z: 27.5 }, normal: { x: 0, y: 1, z: 0 }, dropped: true, hitPlayerId: null }));
        expect(dropped.dropped).toBe(true);
        expect(dropped.impact).toEqual({ x: 0, y: 0, z: 27.5 });
        const none = unpackShot(packShot('p', { flightEnd: { x: 1, y: 1, z: 1 }, impact: null, normal: null, dropped: true, hitPlayerId: null }));
        expect(none.impact).toBeNull();
        expect(none.normal).toBeNull();
    });

    it('packs vectors as small integers', () => {
        expect(packVec({ x: -79.996, y: 7, z: 0.004 })).toEqual([-8000, 700, 0]);
        expect(unpackVec([150, -25, 1])).toEqual({ x: 1.5, y: -0.25, z: 0.01 });
    });
});

describe('server input and name validation', () => {
    it('accepts exactly [seq, moveX, moveZ, yaw, pitch, buttons] and clamps values', () => {
        expect(parseInput([1, 5, 0, 0, 9, 0xff])).toMatchObject({ seq: 1, moveX: 1, moveZ: 0 });
        expect(parseInput([1, 5, 0, 0, 9, 0xff])!.pitch).toBeLessThan(1.5);
        expect(parseInput([1, 5, 0, 0, 9, 0xff])!.buttons).toBe(0x3f);
        for (const bad of [null, {}, 'x', [1, 2, 3], [1, 0, 0, 0, 0, 0, 0], [1, NaN, 0, 0, 0, 0], [1, '0', 0, 0, 0, 0], [-1, 0, 0, 0, 0, 0], [Infinity, 0, 0, 0, 0, 0]]) {
            expect(parseInput(bad)).toBeNull();
        }
    });

    it('cleans nicknames and falls back for empty or hostile ones', () => {
        expect(sanitizeName('  Neo  ', 'abcd')).toBe('Neo');
        expect(sanitizeName('<script>x</script>', 'abcd')).not.toMatch(/[<>/]/);
        expect(sanitizeName('a', 'abcd')).toBe('Runner-ABCD');
        expect(sanitizeName(42, 'abcd')).toBe('Runner-ABCD');
        expect(Array.from(sanitizeName('가나다라마바사아자차카타파하', 'x')).length).toBe(12);
        expect(sanitizeName('a\u0000\u0007b', 'abcd')).toBe('ab');
    });
});
