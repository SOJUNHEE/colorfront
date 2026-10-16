import { ARENA } from '../constants/simulation.ts';
import type { Vec3 } from '../types/math.ts';
import type { BoxSolid, MapDefinition, RampSolid, Solid, SolidTag, SpawnZone } from './types.ts';

/**
 * "Neon Terminal" Phase 1 blockout (GDD 3.1). Placeholder geometry only — layout values are
 * first guesses that must be validated by play-testing (sight lines, travel times).
 *
 * Axes: +X east, -Z north. Blue (A) spawns west, Orange (B) east. The west half is authored
 * and mirrored across x = 0 so both sides are exactly symmetric.
 *
 *   z=-60 ┌──────────── north high ground (y=7) ── bridge ── high ground ────────────┐
 *         │ bldg │   ramp   ramp            (under bridge)            ramp   ramp │ bldg │
 *   z=-15 │──────┤                                                                ├──────│
 *         │ BLUE │  centre lane      ┌──── plaza 50 x 45 ────┐     centre lane   │ORANGE│
 *   z=15  │──────┤                   └───────────────────────┘                   ├──────│
 *         │ bldg │ corridor │ warehouse │   │ south block │   │ warehouse │ corr. │ bldg │
 *   z=60  └─────────────────────── south flank route ─────────────────────────────┘
 */

const box = (id: string, tag: SolidTag, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): BoxSolid => ({
    kind: 'box',
    id,
    tag,
    min: { x: x0, y: y0, z: z0 },
    max: { x: x1, y: y1, z: z1 }
});

const ramp = (
    id: string,
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    z0: number,
    z1: number,
    axis: 'x' | 'z',
    ascending: 1 | -1
): RampSolid => ({
    kind: 'ramp',
    id,
    tag: 'ramp',
    min: { x: x0, y: y0, z: z0 },
    max: { x: x1, y: y1, z: z1 },
    axis,
    ascending
});

function mirrorX(s: Solid): Solid {
    const min = { x: -s.max.x, y: s.min.y, z: s.min.z };
    const max = { x: -s.min.x, y: s.max.y, z: s.max.z };
    const id = s.id.replace(/-w$/, '-e');
    if (s.kind === 'box') return { ...s, id, min, max };
    return { ...s, id, min, max, ascending: s.axis === 'x' ? (-s.ascending as 1 | -1) : s.ascending };
}

const HIGH_GROUND = 7;

/** Shared, self-symmetric geometry. */
const centre: Solid[] = [
    box('floor', 'floor', ARENA.minX, ARENA.maxX, -1, 0, ARENA.minZ, ARENA.maxZ),
    box('boundary-n', 'boundary', ARENA.minX - 1, ARENA.maxX + 1, 0, 10, ARENA.minZ - 1, ARENA.minZ),
    box('boundary-s', 'boundary', ARENA.minX - 1, ARENA.maxX + 1, 0, 10, ARENA.maxZ, ARENA.maxZ + 1),
    box('boundary-w', 'boundary', ARENA.minX - 1, ARENA.minX, 0, 10, ARENA.minZ, ARENA.maxZ),
    box('boundary-e', 'boundary', ARENA.maxX, ARENA.maxX + 1, 0, 10, ARENA.minZ, ARENA.maxZ),
    // Cross bridge linking both high grounds; players can walk underneath.
    box('bridge', 'bridge', -12, 12, HIGH_GROUND - 0.6, HIGH_GROUND, -52, -40),
    box('plaza-cover', 'cover', -2, 2, 0, 1.2, -2, 2),
    box('south-block', 'building', -12, 12, 0, 5, 26, 33),
    box('flank-cover', 'cover', -3, 3, 0, 1.6, 45, 47)
];

/** West (Blue) half. */
const west: Solid[] = [
    // Spawn flanks
    box('bldg-nw-w', 'building', -80, -62, 0, 10, -60, -15),
    box('bldg-sw-w', 'building', -80, -62, 0, 10, 15, 60),
    // North high ground + access ramps (from spawn side and from the plaza)
    box('high-w', 'platform', -62, -12, 0, HIGH_GROUND, -60, -32),
    ramp('ramp-spawn-w', -60, -52, 0, HIGH_GROUND, -32, -20, 'z', -1),
    ramp('ramp-plaza-w', -24, -16, 0, HIGH_GROUND, -32, -20, 'z', -1),
    box('high-crate-a-w', 'cover', -40, -37, HIGH_GROUND, HIGH_GROUND + 1.4, -40, -37),
    box('high-crate-b-w', 'cover', -28, -26, HIGH_GROUND, HIGH_GROUND + 1.2, -52, -46),
    // Centre lane cover
    box('lane-barricade-w', 'cover', -46, -44, 0, 1.4, -6, 6),
    box('lane-container-a-w', 'cover', -36, -30, 0, 2.6, 8, 10.5),
    box('lane-container-b-w', 'cover', -36, -33.5, 0, 2.6, -12, -6),
    // Plaza
    box('plaza-container-w', 'cover', -16, -10, 0, 2.6, 6, 8.5),
    box('plaza-pillar-w', 'cover', -14, -12, 0, 6, -12, -10),
    // South: warehouse between centre lane and flank, corridor x[-62,-54] from spawn
    box('warehouse-w', 'building', -54, -30, 0, 9, 24, 34),
    box('flank-container-a-w', 'cover', -46, -38, 0, 2.6, 44, 46.5),
    box('flank-container-b-w', 'cover', -26, -23.5, 0, 2.6, 50, 56),
    box('flank-low-w', 'cover', -56, -52, 0, 1.4, 52, 54)
];

function spawnPoints(xs: number[]): Vec3[] {
    const points: Vec3[] = [];
    for (const z of [-10, -5, 0, 5, 10]) for (const x of xs) points.push({ x, y: 0, z });
    return points;
}

const spawnZones: SpawnZone[] = [
    {
        team: 'blue',
        min: { x: -80, z: -15 },
        max: { x: -55, z: 15 },
        yaw: -Math.PI / 2,
        points: spawnPoints([-74, -70, -66])
    },
    {
        team: 'orange',
        min: { x: 55, z: -15 },
        max: { x: 80, z: 15 },
        yaw: Math.PI / 2,
        points: spawnPoints([74, 70, 66])
    }
];

export const NEON_TERMINAL: MapDefinition = {
    id: 'neon-terminal',
    name: 'Neon Terminal (blockout)',
    bounds: { minX: ARENA.minX, maxX: ARENA.maxX, minZ: ARENA.minZ, maxZ: ARENA.maxZ },
    solids: [...centre, ...west, ...west.map(mirrorX)],
    spawnZones,
    regions: [
        { id: 'plaza', label: 'Central plaza 50 x 45', min: { x: -25, z: -22.5 }, max: { x: 25, z: 22.5 } },
        { id: 'north-high', label: 'North high ground', min: { x: -62, z: -60 }, max: { x: 62, z: -32 } },
        { id: 'south-flank', label: 'South flank route', min: { x: -62, z: 34 }, max: { x: 62, z: 60 } },
        { id: 'spawn-blue', label: 'Blue spawn 25 x 30', min: { x: -80, z: -15 }, max: { x: -55, z: 15 } },
        { id: 'spawn-orange', label: 'Orange spawn 25 x 30', min: { x: 55, z: -15 }, max: { x: 80, z: 15 } }
    ]
};
