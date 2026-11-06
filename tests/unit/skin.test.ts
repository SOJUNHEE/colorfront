/**
 * Phase 6 Gate 5 — the Neon Terminal visual skin is purely visual: it never enters player space,
 * keeps the spawns and signs clear, never changes the collision map, and has the 3 landmarks.
 */
import { NEON_TERMINAL, buildCollisionWorld, buildNeonTerminalDecor, buildNeonTerminalSkin, decorBounds, decorViolations } from '@colorfront/shared';
import { describe, expect, it } from 'vitest';

import { world } from './helpers.ts';

const signs = buildNeonTerminalDecor(1)
    .filter((d) => d.kind === 'sign')
    .map(decorBounds);

describe('Neon Terminal visual skin (Gate 5)', () => {
    for (const density of [1, 0.75, 0.35]) {
        it(`never enters player space at density ${density}`, () => {
            const items = buildNeonTerminalSkin(NEON_TERMINAL, density, signs);
            expect(items.length).toBeGreaterThan(150);
            expect(decorViolations(world, items)).toEqual([]);
        });
    }

    it('lower presets carry fewer details', () => {
        expect(buildNeonTerminalSkin(NEON_TERMINAL, 0.35, signs).length).toBeLessThan(buildNeonTerminalSkin(NEON_TERMINAL, 1, signs).length);
    });

    it('keeps every spawn point clear (only flat floor markings nearby)', () => {
        const items = buildNeonTerminalSkin(NEON_TERMINAL, 1, signs).map(decorBounds);
        for (const zone of NEON_TERMINAL.spawnZones)
            for (const p of zone.points)
                for (const b of items) {
                    const near = p.x > b.min.x - 1 && p.x < b.max.x + 1 && p.z > b.min.z - 1 && p.z < b.max.z + 1 && b.min.y < 3;
                    if (near) expect(b.max.y - b.min.y, JSON.stringify(b)).toBeLessThanOrEqual(0.012);
                }
    });

    it('does not cover the signs', () => {
        const items = buildNeonTerminalSkin(NEON_TERMINAL, 1, signs).map(decorBounds);
        for (const s of signs)
            for (const b of items) {
                const hit = b.min.x < s.max.x && b.max.x > s.min.x && b.min.y < s.max.y && b.max.y > s.min.y && b.min.z < s.max.z && b.max.z > s.min.z;
                expect(hit).toBe(false);
            }
    });

    it('leaves the collision map untouched (skin is derived, not merged into solids)', () => {
        const before = JSON.stringify(buildCollisionWorld(NEON_TERMINAL).solids.map((s) => [s.minX, s.minY, s.minZ, s.maxX, s.maxY, s.maxZ]));
        buildNeonTerminalSkin(NEON_TERMINAL, 1, signs);
        expect(JSON.stringify(buildCollisionWorld(NEON_TERMINAL).solids.map((s) => [s.minX, s.minY, s.minZ, s.maxX, s.maxY, s.maxZ]))).toBe(before);
    });

    it('has the three landmarks (refinery, lighthouse, ship) out of reach', () => {
        const items = buildNeonTerminalSkin(NEON_TERMINAL, 1, signs);
        const tall = (pred: (b: ReturnType<typeof decorBounds>) => boolean) => items.map(decorBounds).filter(pred);
        expect(tall((b) => b.min.z > 26 && b.max.z < 33 && b.min.y >= 5 && b.max.y > 20).length).toBeGreaterThan(0); // refinery mast
        expect(tall((b) => b.max.z < -61 && b.max.y > 30).length).toBeGreaterThan(0); // lighthouse
        expect(items.filter((d) => d.kind === 'box' && d.material === 'container' && d.min.z >= 100).length).toBeGreaterThan(20); // ship cargo
    });
});
