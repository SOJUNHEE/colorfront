import { type MapDefinition, buildCollisionWorld, findGround, raycast, surfaceTopAt } from '@colorfront/shared';
import { describe, expect, it } from 'vitest';

const testMap: MapDefinition = {
    id: 'test',
    name: 'test',
    bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
    solids: [
        { kind: 'box', id: 'floor', tag: 'floor', min: { x: -50, y: -1, z: -50 }, max: { x: 50, y: 0, z: 50 } },
        { kind: 'box', id: 'wall', tag: 'building', min: { x: 10, y: 0, z: -5 }, max: { x: 12, y: 4, z: 5 } },
        // Rises from y=0 at x=-20 to y=5 at x=-10.
        { kind: 'ramp', id: 'ramp', tag: 'ramp', min: { x: -20, y: 0, z: -2 }, max: { x: -10, y: 5, z: 2 }, axis: 'x', ascending: 1 }
    ],
    spawnZones: [],
    regions: []
};
const world = buildCollisionWorld(testMap);
const ramp = world.solids.find((s) => s.source.id === 'ramp')!;

describe('collision', () => {
    it('evaluates ramp surface height and clamps outside the footprint', () => {
        expect(surfaceTopAt(ramp, -20, 0)).toBeCloseTo(0);
        expect(surfaceTopAt(ramp, -15, 0)).toBeCloseTo(2.5);
        expect(surfaceTopAt(ramp, -10, 0)).toBeCloseTo(5);
        expect(surfaceTopAt(ramp, -30, 0)).toBeCloseTo(0);
        expect(surfaceTopAt(ramp, 0, 0)).toBeCloseTo(5);
    });

    it('finds the highest ground at or below maxTop', () => {
        expect(findGround(world, -15, 0, 0.2, 10)).toBeCloseTo(2.5);
        expect(findGround(world, -15, 0, 0.2, 1)).toBe(0);
        expect(findGround(world, 60, 0, 0.2, 10)).toBe(-Infinity);
    });

    it('raycasts against boxes', () => {
        const hit = raycast(world, { x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 100);
        expect(hit?.solid.source.id).toBe('wall');
        expect(hit?.distance).toBeCloseTo(10);
        expect(raycast(world, { x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 5)).toBeNull();
    });

    it('raycasts against the sloped face of a ramp, not its bounding box', () => {
        // Straight down at x=-15: slope surface is 2.5 m, the bounding box top would be 5 m.
        const hit = raycast(world, { x: -15, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }, 100);
        expect(hit?.solid.source.id).toBe('ramp');
        expect(hit?.distance).toBeCloseTo(7.5);
        // Horizontal ray at y=4 passes over the low part and enters at x=-12.
        const side = raycast(world, { x: -30, y: 4, z: 0 }, { x: 1, y: 0, z: 0 }, 100);
        expect(side?.distance).toBeCloseTo(18);
    });
});
