import { NEON_TERMINAL, PAINT_CELL_SIZE, PaintGrid, PaintOwner, paintPercent } from '@colorfront/shared';
import { describe, expect, it } from 'vitest';

import { rng, world } from './helpers.ts';

const UP = { x: 0, y: 1, z: 0 };
const surfaceOf = (paint: PaintGrid, id: string) => paint.surfaces.find((s) => s.solid.source.id === id)!;
const countOwner = (paint: PaintGrid, id: string, owner: number) => {
    const s = surfaceOf(paint, id);
    return paint.owners[s.index].reduce((n, o) => n + (o === owner ? 1 : 0), 0);
};

describe('PaintGrid surfaces and mask', () => {
    const paint = new PaintGrid(world, NEON_TERMINAL);

    it('creates one independent 0.5 m grid per paintable top surface', () => {
        const ids = paint.surfaces.map((s) => s.solid.source.id).sort();
        expect(ids).toEqual(['bridge', 'floor', 'high-e', 'high-w', 'ramp-plaza-e', 'ramp-plaza-w', 'ramp-spawn-e', 'ramp-spawn-w'].sort());
        expect(PAINT_CELL_SIZE).toBe(0.5);
        const floor = surfaceOf(paint, 'floor');
        expect([floor.cols, floor.rows]).toEqual([320, 240]);
        expect([surfaceOf(paint, 'high-w').cols, surfaceOf(paint, 'high-w').rows]).toEqual([100, 56]);
        expect([surfaceOf(paint, 'bridge').cols, surfaceOf(paint, 'bridge').rows]).toEqual([48, 24]);
        expect([surfaceOf(paint, 'ramp-spawn-w').cols, surfaceOf(paint, 'ramp-spawn-w').rows]).toEqual([16, 24]);
    });

    it('recomputes the paintable area from the real map data', () => {
        const masked = (id: string) => paint.masks[surfaceOf(paint, id).index].reduce((n, m) => n + m, 0);
        expect(masked('floor')).toBe(41_472);
        expect(masked('high-w')).toBe(100 * 56 - 36 - 48); // minus the two crates on top
        expect(masked('bridge')).toBe(48 * 24);
        expect(masked('ramp-plaza-w')).toBe(16 * 24);
        expect(paint.paintableCount).toBe(55_192);
        // 55,192 cells x 0.25 m² = 13,798 m², 71.9 % of the 160 x 120 footprint.
        expect(paintPercent(paint.paintableCount, 320 * 240)).toBeCloseTo(71.86, 2);
        expect(paint.recount().paintable).toBe(paint.paintableCount);
    });

    it('excludes spawn zones, building and cover footprints but keeps the floor under the bridge', () => {
        expect(paint.ownerAt(-70, 0, 0)).toBeNull(); // blue spawn
        expect(paint.ownerAt(70, 0, 0)).toBeNull(); // orange spawn
        expect(paint.ownerAt(-42, 0, 28)).toBeNull(); // under warehouse
        expect(paint.ownerAt(0, 0, 0)).toBeNull(); // under plaza cover
        expect(paint.ownerAt(-38.5, 7, -38.5)).toBeNull(); // crate on the high ground
        expect(paint.ownerAt(0, 0, -46)).toBe(PaintOwner.None); // floor under the bridge
        expect(paint.ownerAt(0, 7, -46)).toBe(PaintOwner.None); // bridge deck
        expect(paint.ownerAt(-30, 7, -45)).toBe(PaintOwner.None); // high ground
    });
});

describe('PaintGrid painting', () => {
    it('paints a 1.2 m disc (21 cells) on open floor and is idempotent for the same team', () => {
        const paint = new PaintGrid(world, NEON_TERMINAL);
        expect(paint.paintSphere({ x: -19.75, y: 0, z: 5.25 }, 1.2, 'blue', UP)).toBe(21);
        expect(paint.score()).toMatchObject({ blue: 21, orange: 0 });
        expect(paint.paintSphere({ x: -19.75, y: 0, z: 5.25 }, 1.2, 'blue', UP)).toBe(0);
        expect(paint.blueCount).toBe(21);
        expect(paint.ownerAt(-19.75, 0, 5.25)).toBe(PaintOwner.Blue);
    });

    it('lets the enemy overwrite: blue -n, orange +n', () => {
        const paint = new PaintGrid(world, NEON_TERMINAL);
        paint.paintSphere({ x: -19.75, y: 0, z: 5.25 }, 1.2, 'blue', UP);
        const revision = paint.revision;
        expect(paint.paintSphere({ x: -19.75, y: 0, z: 5.25 }, 1.2, 'orange', UP)).toBe(21);
        expect(paint.score()).toMatchObject({ blue: 0, orange: 21 });
        expect(paint.revision).toBe(revision + 1);
        // Partial overlap: only the overlapping cells flip.
        paint.paintSphere({ x: -18.75, y: 0, z: 5.25 }, 1.2, 'blue', UP);
        expect(paint.blueCount + paint.orangeCount).toBe(paint.recount().blue + paint.recount().orange);
        expect(paint.blueCount).toBe(21);
        expect(paint.orangeCount).toBeGreaterThan(0);
        expect(paint.orangeCount).toBeLessThan(21);
    });

    it('paints the floor under the bridge and the bridge deck independently (different colours)', () => {
        const paint = new PaintGrid(world, NEON_TERMINAL);
        const under = paint.paintSphere({ x: 0, y: 0, z: -46 }, 1.2, 'blue', UP);
        expect(under).toBeGreaterThan(0);
        expect(countOwner(paint, 'bridge', PaintOwner.Blue)).toBe(0);

        const deck = paint.paintSphere({ x: 0, y: 7, z: -46 }, 1.2, 'orange', UP);
        expect(deck).toBeGreaterThan(0);
        expect(countOwner(paint, 'floor', PaintOwner.Orange)).toBe(0);
        expect(countOwner(paint, 'floor', PaintOwner.Blue)).toBe(under);
        expect(paint.ownerAt(0, 0, -46)).toBe(PaintOwner.Blue);
        expect(paint.ownerAt(0, 7, -46)).toBe(PaintOwner.Orange);

        // Shooting the underside of the 0.6 m deck must not paint its top through the slab.
        expect(paint.paintSphere({ x: 3, y: 6.4, z: -46 }, 1.2, 'blue', { x: 0, y: -1, z: 0 })).toBe(0);
        expect(paint.score()).toMatchObject({ blue: under, orange: deck });
    });

    it('keeps the high ground and the floor below its cliff independent', () => {
        const paint = new PaintGrid(world, NEON_TERMINAL);
        expect(paint.paintSphere({ x: -30, y: 7, z: -32.5 }, 1.2, 'orange', UP)).toBeGreaterThan(0);
        expect(countOwner(paint, 'floor', PaintOwner.Orange)).toBe(0);
        // A low hit on the cliff face paints the floor at its base, never the top 7 m above.
        expect(paint.paintSphere({ x: -30, y: 0.4, z: -32 }, 1.2, 'blue', { x: 0, y: 0, z: 1 })).toBeGreaterThan(0);
        expect(countOwner(paint, 'high-w', PaintOwner.Blue)).toBe(0);
        expect(paint.ownerAt(-30, 0, -31.75)).toBe(PaintOwner.Blue);
    });

    it('paints ramps along their slope', () => {
        const paint = new PaintGrid(world, NEON_TERMINAL);
        // ramp-spawn-w rises from y=0 at z=-20 to y=7 at z=-32: at z=-26 the surface is 3.5 m high.
        expect(paint.paintSphere({ x: -56, y: 3.5, z: -26 }, 1.2, 'blue', UP)).toBeGreaterThan(10);
        expect(paint.ownerAt(-56, 3.5, -26)).toBe(PaintOwner.Blue);
        expect(countOwner(paint, 'floor', PaintOwner.Blue)).toBe(0);
    });

    it('handles grid edges and points outside the map without errors', () => {
        const paint = new PaintGrid(world, NEON_TERMINAL);
        expect(paint.paintSphere({ x: 0, y: 0, z: 59.9 }, 1.2, 'blue', UP)).toBeGreaterThan(0);
        expect(paint.paintSphere({ x: -79.9, y: 0, z: -59.9 }, 1.2, 'blue', UP)).toBeGreaterThanOrEqual(0);
        expect(paint.paintSphere({ x: 500, y: 0, z: 0 }, 1.2, 'blue', UP)).toBe(0);
        expect(paint.paintSphere({ x: -70, y: 0, z: 0 }, 1.2, 'orange', UP)).toBe(0); // spawn is masked
        expect(paint.recount()).toEqual(paint.score());
    });

    it('stays exact after 1000 random paints (incremental counts = full scan, owners valid)', () => {
        const paint = new PaintGrid(world, NEON_TERMINAL);
        const random = rng(42);
        for (let i = 0; i < 1000; i++) {
            const surface = paint.surfaces[Math.floor(random() * paint.surfaces.length)];
            const s = surface.solid;
            const x = s.minX + random() * (s.maxX - s.minX);
            const z = s.minZ + random() * (s.maxZ - s.minZ);
            const y = s.source.kind === 'ramp' ? s.minY + random() * (s.maxY - s.minY) : s.maxY;
            paint.paintSphere({ x, y, z }, 0.5 + random() * 1.5, random() < 0.5 ? 'blue' : 'orange', UP);
        }
        const full = paint.recount();
        expect(paint.score()).toEqual(full);
        expect(full.blue + full.orange + full.unpainted).toBe(full.paintable);
        expect(full.blue).toBeGreaterThan(0);
        expect(full.orange).toBeGreaterThan(0);
        for (let i = 0; i < paint.surfaces.length; i++) {
            const owners = paint.owners[i];
            const mask = paint.masks[i];
            for (let c = 0; c < owners.length; c++) {
                expect(owners[c] <= PaintOwner.Orange).toBe(true);
                if (!mask[c]) expect(owners[c]).toBe(PaintOwner.None);
            }
        }
    });

    it('reports the changed cell rectangle per surface exactly once', () => {
        const paint = new PaintGrid(world, NEON_TERMINAL);
        const floor = surfaceOf(paint, 'floor');
        paint.paintSphere({ x: -19.75, y: 0, z: 5.25 }, 1.2, 'blue', UP);
        const rect = paint.takeDirty(floor.index)!;
        expect(rect).not.toBeNull();
        // Every changed cell lies inside the rectangle.
        const owners = paint.owners[floor.index];
        for (let i = 0; i < owners.length; i++) {
            if (owners[i] === PaintOwner.None) continue;
            const col = i % floor.cols;
            const row = Math.floor(i / floor.cols);
            expect(col >= rect[0] && col <= rect[2] && row >= rect[1] && row <= rect[3]).toBe(true);
        }
        expect(paint.takeDirty(floor.index)).toBeNull();
        expect(paint.takeDirty(surfaceOf(paint, 'bridge').index)).toBeNull();
    });

    it('clear() resets everything', () => {
        const paint = new PaintGrid(world, NEON_TERMINAL);
        paint.paintSphere({ x: -19.75, y: 0, z: 5.25 }, 1.2, 'blue', UP);
        paint.clear();
        expect(paint.score()).toMatchObject({ blue: 0, orange: 0, unpainted: paint.paintableCount });
        expect(paint.recount()).toEqual(paint.score());
    });
});
