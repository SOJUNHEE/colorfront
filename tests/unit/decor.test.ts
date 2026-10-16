import { NEON_TERMINAL, PLAYER_REACH, buildNeonTerminalDecor, decorBounds, decorViolations } from '@colorfront/shared';
import { describe, expect, it } from 'vitest';

import { world } from './helpers.ts';

describe('Neon Terminal decor (visual only)', () => {
    for (const density of [1, 0.75, 0.35]) {
        it(`never enters player space at density ${density}`, () => {
            const items = buildNeonTerminalDecor(density);
            expect(items.length).toBeGreaterThan(50);
            expect(decorViolations(world, items)).toEqual([]);
        });
    }

    it('keeps every spawn point and its surroundings clear', () => {
        const items = buildNeonTerminalDecor(1).map(decorBounds);
        for (const zone of NEON_TERMINAL.spawnZones) {
            for (const p of zone.points) {
                for (const b of items) {
                    const inside = p.x > b.min.x - 1 && p.x < b.max.x + 1 && p.z > b.min.z - 1 && p.z < b.max.z + 1;
                    // Only flat floor markings may lie near a spawn point.
                    if (inside) expect(b.max.y - b.min.y).toBeLessThanOrEqual(0.012);
                }
            }
        }
    });

    it('rejects decor a player could touch', () => {
        const bad = [
            { kind: 'box' as const, material: 'machine' as const, min: { x: 0, y: 0, z: 10 }, max: { x: 1, y: 1, z: 11 } },
            { kind: 'box' as const, material: 'girder' as const, min: { x: -20, y: PLAYER_REACH - 0.5, z: 5 }, max: { x: -19, y: 5, z: 6 } },
            // Too thick to count as flush on the warehouse wall.
            { kind: 'box' as const, material: 'trim' as const, min: { x: -45, y: 1, z: 23.8 }, max: { x: -44, y: 2, z: 24 } }
        ];
        expect(decorViolations(world, bad)).toHaveLength(3);
    });
});
