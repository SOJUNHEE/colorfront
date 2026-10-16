import { ARENA, NEON_TERMINAL, PLAYER_SHAPE, cylinderOverlapsSolid, findGround } from '@colorfront/shared';
import { describe, expect, it } from 'vitest';

import { world } from './helpers.ts';

const size = (r: { min: { x: number; z: number }; max: { x: number; z: number } }) => ({
    w: r.max.x - r.min.x,
    d: r.max.z - r.min.z
});
const region = (id: string) => NEON_TERMINAL.regions.find((r) => r.id === id)!;

describe('Neon Terminal blockout', () => {
    it('matches the GDD footprint (160 x 120, spawns 25 x 30, plaza 50 x 45)', () => {
        const b = NEON_TERMINAL.bounds;
        expect(b.maxX - b.minX).toBe(160);
        expect(b.maxZ - b.minZ).toBe(120);
        for (const zone of NEON_TERMINAL.spawnZones) expect(size(zone)).toEqual({ w: 25, d: 30 });
        expect(size(region('plaza'))).toEqual({ w: 50, d: 45 });
    });

    it('has unique solid ids and valid extents', () => {
        const ids = new Set(NEON_TERMINAL.solids.map((s) => s.id));
        expect(ids.size).toBe(NEON_TERMINAL.solids.length);
        for (const s of NEON_TERMINAL.solids) {
            expect(s.max.x).toBeGreaterThan(s.min.x);
            expect(s.max.y).toBeGreaterThan(s.min.y);
            expect(s.max.z).toBeGreaterThan(s.min.z);
        }
    });

    it('keeps everything except the boundary walls inside the arena', () => {
        for (const s of NEON_TERMINAL.solids) {
            if (s.tag === 'boundary') continue;
            expect(s.min.x).toBeGreaterThanOrEqual(ARENA.minX);
            expect(s.max.x).toBeLessThanOrEqual(ARENA.maxX);
            expect(s.min.z).toBeGreaterThanOrEqual(ARENA.minZ);
            expect(s.max.z).toBeLessThanOrEqual(ARENA.maxZ);
        }
    });

    it('is mirror-symmetric across x = 0', () => {
        const key = (s: (typeof NEON_TERMINAL.solids)[number], mirror: boolean) => {
            const x0 = mirror ? -s.max.x : s.min.x;
            const x1 = mirror ? -s.min.x : s.max.x;
            const asc = s.kind === 'ramp' ? (mirror && s.axis === 'x' ? -s.ascending : s.ascending) : 0;
            return [s.kind, x0, x1, s.min.y, s.max.y, s.min.z, s.max.z, s.kind === 'ramp' ? s.axis : '', asc].join('|');
        };
        const all = new Set(NEON_TERMINAL.solids.map((s) => key(s, false)));
        for (const s of NEON_TERMINAL.solids) expect(all.has(key(s, true))).toBe(true);
    });

    it('has 15 free spawn points per team, standing on the floor', () => {
        for (const zone of NEON_TERMINAL.spawnZones) {
            expect(zone.points).toHaveLength(15);
            for (const p of zone.points) {
                expect(p.x).toBeGreaterThanOrEqual(zone.min.x + PLAYER_SHAPE.radius);
                expect(p.x).toBeLessThanOrEqual(zone.max.x - PLAYER_SHAPE.radius);
                expect(cylinderOverlapsSolid(world, p, PLAYER_SHAPE.radius, PLAYER_SHAPE.height)).toBeNull();
                expect(findGround(world, p.x, p.z, 0.2, p.y + 0.1)).toBe(p.y);
            }
        }
    });

    it('has north high ground between 6 and 8 m', () => {
        const high = NEON_TERMINAL.solids.filter((s) => s.tag === 'platform');
        expect(high.length).toBeGreaterThan(0);
        for (const s of high) {
            expect(s.max.y).toBeGreaterThanOrEqual(6);
            expect(s.max.y).toBeLessThanOrEqual(8);
        }
    });
});
