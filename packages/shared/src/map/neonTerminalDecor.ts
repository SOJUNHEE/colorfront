import type { Vec3 } from '../types/math.ts';
import type { DecorBox, DecorCylinder, DecorItem, DecorMaterial, DecorSign, RGB, SignFacing, SignStyle } from './decor.ts';

/**
 * Decoration layout for Neon Terminal (visual only, never collides). Authored for the west
 * (Blue) half and mirrored for the east (Orange) half, like the collision map. Every item is
 * checked by `decorViolations` in the unit tests.
 *
 * `density` (0..1) thins out props and the skyline for lower graphics presets.
 */

function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const box = (material: DecorMaterial, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color?: RGB): DecorBox => ({
    kind: 'box',
    material,
    min: v(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)),
    max: v(Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)),
    color
});
const cyl = (material: DecorMaterial, x: number, y: number, z: number, radius: number, height: number, color?: RGB): DecorCylinder => ({
    kind: 'cylinder',
    material,
    base: v(x, y, z),
    radius,
    height,
    color
});
const sign = (text: string, style: SignStyle, x: number, y: number, z: number, width: number, height: number, facing: SignFacing, sub?: string): DecorSign => ({
    kind: 'sign',
    text,
    sub,
    style,
    center: v(x, y, z),
    width,
    height,
    facing
});

/** Offset so a sign's back touches the face it hangs on. */
const FACE = 0.011;

const CONTAINER_COLORS: RGB[] = [
    [0.55, 0.16, 0.12],
    [0.13, 0.32, 0.4],
    [0.62, 0.45, 0.12],
    [0.3, 0.33, 0.36],
    [0.18, 0.38, 0.22],
    [0.6, 0.6, 0.58]
];

type Building = { x0: number; x1: number; z0: number; z1: number; top: number };

/** West-half buildings (collision footprints from neonTerminal.ts). */
const BUILDINGS: Building[] = [
    { x0: -80, x1: -62, z0: -60, z1: -15, top: 10 },
    { x0: -80, x1: -62, z0: 15, z1: 60, top: 10 },
    { x0: -54, x1: -30, z0: 24, z1: 34, top: 9 }
];
const ROOF_INSET = 0.7;

function mirrorItem(item: DecorItem): DecorItem {
    const swapMat = (m: DecorMaterial): DecorMaterial => (m === 'neon-blue' ? 'neon-orange' : m);
    // Team-blue floor markings become team orange on the east side.
    const swapColor = (c?: RGB): RGB | undefined => (c && c[2] > c[0] + 0.3 ? [1, 0.5, 0.1] : c);
    if (item.kind === 'box') {
        return {
            ...item,
            material: swapMat(item.material),
            color: swapColor(item.color),
            min: v(-item.max.x, item.min.y, item.min.z),
            max: v(-item.min.x, item.max.y, item.max.z)
        };
    }
    if (item.kind === 'cylinder') return { ...item, material: swapMat(item.material), base: v(-item.base.x, item.base.y, item.base.z) };
    const facing: SignFacing = item.facing === 'x+' ? 'x-' : item.facing === 'x-' ? 'x+' : item.facing;
    const style: SignStyle = item.style === 'blue' ? 'orange' : item.style;
    const text = item.text
        .replace('BLUE', 'ORANGE')
        .replace('GATE A', 'GATE B')
        .replace('DOCK 1', 'DOCK 2')
        .replace('WEST', 'EAST');
    const sub = item.style === 'blue' ? item.sub?.replace('▲', '■') : item.sub;
    return { ...item, text, sub, style, facing, center: v(-item.center.x, item.center.y, item.center.z) };
}

function westHalf(density: number): DecorItem[] {
    const r = rng(7);
    const items: DecorItem[] = [];

    for (const b of BUILDINGS) {
        const x0 = b.x0 + ROOF_INSET;
        const x1 = b.x1 - ROOF_INSET;
        const z0 = b.z0 + ROOF_INSET;
        const z1 = b.z1 - ROOF_INSET;
        // Parapet caps around the roof.
        items.push(box('trim', x0, x1, b.top, b.top + 0.45, z0, z0 + 0.35));
        items.push(box('trim', x0, x1, b.top, b.top + 0.45, z1 - 0.35, z1));
        items.push(box('trim', x0, x0 + 0.35, b.top, b.top + 0.45, z0, z1));
        items.push(box('trim', x1 - 0.35, x1, b.top, b.top + 0.45, z0, z1));
        // Roof machinery: AC units and vent stacks.
        const area = (x1 - x0) * (z1 - z0);
        const units = Math.round((area / 70) * density);
        for (let i = 0; i < units; i++) {
            const w = 1.4 + r() * 1.6;
            const d = 1.0 + r() * 1.2;
            const x = x0 + 1.5 + r() * (x1 - x0 - 3 - w);
            const z = z0 + 1.5 + r() * (z1 - z0 - 3 - d);
            items.push(box('machine', x, x + w, b.top, b.top + 0.9 + r() * 0.8, z, z + d));
            if (r() < 0.5) items.push(cyl('machine', x + w / 2, b.top, z - 0.6, 0.3, 1.2 + r()));
        }
        // Neon roofline on every face, flush with the wall just below the parapet.
        const y0 = b.top - 0.75;
        const y1 = b.top - 0.6;
        items.push(box('neon-blue', b.x0 + 0.5, b.x1 - 0.5, y0, y1, b.z0 - 0.04, b.z0));
        items.push(box('neon-blue', b.x0 + 0.5, b.x1 - 0.5, y0, y1, b.z1, b.z1 + 0.04));
        items.push(box('neon-blue', b.x1, b.x1 + 0.04, y0, y1, b.z0 + 0.5, b.z1 - 0.5));
    }

    // Water tank and radio mast on the north-west warehouse block.
    items.push(cyl('tank', -71, 10, -50, 2.2, 3.4, [0.42, 0.44, 0.46]));
    items.push(cyl('pole', -71, 13.4, -50, 0.12, 2.5));
    items.push(cyl('pole', -66, 10, -22, 0.08, 9));
    items.push(box('beacon', -66.2, -65.8, 19, 19.4, -22.2, -21.8));
    items.push(cyl('tank', -71, 10, 46, 1.8, 2.8, [0.5, 0.36, 0.28]));

    // Signs (flush with faces).
    items.push(sign('BLUE DOCK', 'blue', -71, 6.2, -15 + FACE, 13, 2.6, 'z+', '▲ TEAM BASE'));
    items.push(sign('GATE A', 'blue', -71, 6.2, 15 - FACE, 9, 2.4, 'z-', 'SOUTH YARD →'));
    items.push(sign('NEON TERMINAL', 'neutral', -62 + FACE, 8.8, -42, 16, 1.7, 'x+'));
    items.push(sign('CARGO 07', 'warning', -42, 5.6, 24 - FACE, 11, 2.6, 'z-', 'HEAVY LIFT ZONE'));
    items.push(sign('DOCK 1', 'neutral', -42, 5.2, 34 + FACE, 9, 2.2, 'z+', 'FLANK ROUTE'));
    items.push(sign('HIGH DECK', 'neutral', -37, 3.6, -32 + FACE, 9, 2.0, 'z+', '▲ RAMP ACCESS'));
    items.push(sign('PORT WEST', 'neutral', -40, 6.5, 60 - FACE, 12, 2.6, 'z-'));

    // Hazard bands: high-ground cliff top edge and ramp sides (flush).
    items.push(box('hazard', -62, -12, 6.55, 6.95, -32, -31.96));
    for (const rx of [-60, -24]) {
        // Ramps x[rx, rx+8], z[-32,-20]: stripes on their low end face is floor level; mark sides.
        items.push(box('hazard', rx - 0.04, rx, 0.05, 0.35, -21.5, -20));
        items.push(box('hazard', rx + 8, rx + 8.04, 0.05, 0.35, -21.5, -20));
    }

    // Floor markings: team line at the spawn exit, plaza outline dashes, lane centre dashes.
    items.push(box('marking', -55.3, -55, 0.004, 0.012, -14.5, 14.5, [0.16, 0.48, 1]));
    for (let z = -21.5; z < 21.5; z += 3) items.push(box('marking', -25.1, -24.85, 0.004, 0.012, z, z + 1.6, [0.85, 0.72, 0.2]));
    for (let x = -24; x < -1; x += 3) {
        items.push(box('marking', x, x + 1.6, 0.004, 0.012, -22.6, -22.35, [0.85, 0.72, 0.2]));
        items.push(box('marking', x, x + 1.6, 0.004, 0.012, 22.35, 22.6, [0.85, 0.72, 0.2]));
    }
    for (let x = -53; x < -26; x += 4) items.push(box('marking', x, x + 2, 0.004, 0.012, -0.12, 0.12, [0.75, 0.75, 0.72]));

    // ---- Outside the arena (x < -81 or beyond the north/south walls) ----
    // Apron slabs west.
    items.push(box('apron', -150, -81, -0.05, 0, -130, 130));
    // Container stacks along the west apron.
    for (let row = 0; row < 3; row++) {
        for (let i = 0; i < 9; i++) {
            if (r() > 0.55 + density * 0.45) continue;
            const z = -58 + i * 13 + r() * 2;
            const x = -86 - row * 3.2;
            const levels = 1 + Math.floor(r() * (2 + density * 3));
            for (let l = 0; l < levels; l++) {
                const c = CONTAINER_COLORS[Math.floor(r() * CONTAINER_COLORS.length)];
                items.push(box('container', x - 2.5, x, l * 2.6, l * 2.6 + 2.55, z, z + 12, c));
            }
        }
    }
    // Light towers at the west corners.
    for (const z of [-66, 66]) {
        items.push(cyl('pole', -86, 0, z, 0.45, 26));
        items.push(box('lamp', -88, -84, 26, 27.2, z - 1.5, z + 1.5));
    }
    // Wall-top lamps on the outer half of the west boundary.
    for (let z = -54; z <= 54; z += 12) items.push(box('lamp', -80.95, -80.6, 10, 10.35, z - 0.6, z + 0.6));
    return items;
}

/** North/south quay: cranes, more containers, apron and water. Not mirrored (already symmetric). */
function quays(density: number): DecorItem[] {
    const r = rng(19);
    const items: DecorItem[] = [];
    items.push(box('apron', -81, 81, -0.05, 0, -100, -61));
    items.push(box('apron', -81, 81, -0.05, 0, 61, 100));
    // Water beyond the quays and aprons.
    items.push(box('water', -900, 900, -1.6, -1.5, -900, -130));
    items.push(box('water', -900, 900, -1.6, -1.5, 130, 900));
    items.push(box('water', -900, -150, -1.6, -1.5, -130, 130));
    items.push(box('water', 150, 900, -1.6, -1.5, -130, 130));
    items.push(box('water', -150, 150, -1.6, -1.5, -130, -100));
    items.push(box('water', -150, 150, -1.6, -1.5, 100, 130));

    // Gantry cranes on the south quay (and one north) straddling container rows.
    const cranes: [number, number, number][] = [
        [-45, 88, 42],
        [5, 92, 46],
        [55, 86, 40],
        [-10, -86, 44]
    ];
    for (const [cx, cz, h] of cranes) {
        const red: RGB = [0.62, 0.14, 0.1];
        const white: RGB = [0.8, 0.8, 0.78];
        for (const dx of [-7, 7]) for (const dz of [-6, 6]) items.push(box('crane', cx + dx - 0.6, cx + dx + 0.6, 0, h, cz + dz - 0.6, cz + dz + 0.6, red));
        items.push(box('crane', cx - 8, cx + 8, h - 2, h, cz - 6.8, cz - 5.2, red));
        items.push(box('crane', cx - 8, cx + 8, h - 2, h, cz + 5.2, cz + 6.8, red));
        // Boom out over the water, away from the arena.
        const out = cz > 0 ? 1 : -1;
        items.push(box('crane', cx - 1.2, cx + 1.2, h + 1, h + 3, cz - 8 * out, cz + 34 * out, white));
        items.push(box('crane', cx - 2, cx + 2, h - 6, h - 1, cz + 7 * out, cz + 11 * out, white));
        items.push(box('beacon', cx - 0.3, cx + 0.3, h + 3, h + 3.6, cz + 33 * out, cz + 33.6 * out));
    }
    // Container rows on both quays.
    for (const side of [-1, 1]) {
        for (let i = 0; i < 12; i++) {
            if (r() > 0.5 + density * 0.5) continue;
            const x = -70 + i * 12 + r() * 2;
            const z = side * (70 + Math.floor(r() * 3) * 6);
            const levels = 1 + Math.floor(r() * (1 + density * 4));
            for (let l = 0; l < levels; l++) {
                const c = CONTAINER_COLORS[Math.floor(r() * CONTAINER_COLORS.length)];
                items.push(box('container', x, x + 12, l * 2.6, l * 2.6 + 2.55, z, z + 2.5 * side, c));
            }
        }
    }
    // Distant skyline ring.
    const towers = Math.round(52 * density);
    for (let i = 0; i < towers; i++) {
        const a = (i / towers) * Math.PI * 2 + r() * 0.08;
        const dist = 300 + r() * 260;
        const x = Math.cos(a) * dist;
        const z = Math.sin(a) * dist;
        const w = 18 + r() * 26;
        const d = 18 + r() * 26;
        const h = 40 + r() * r() * 150;
        items.push(box('skyline', x - w / 2, x + w / 2, -1.5, h, z - d / 2, z + d / 2));
        if (r() < 0.35) items.push(box('beacon', x - 0.4, x + 0.4, h, h + 2.5, z - 0.4, z + 0.4));
    }
    return items;
}

/** Shared centre pieces: bridge girders and the plaza hologram. */
function centre(): DecorItem[] {
    const items: DecorItem[] = [];
    for (const z of [-51.4, -46.2, -40.6]) items.push(box('girder', -11.4, 11.4, 5.85, 6.4, z - 0.2, z + 0.2));
    for (const x of [-8, 0, 8]) items.push(box('girder', x - 0.15, x + 0.15, 5.95, 6.4, -51.4, -40.6));
    // Hologram above the plaza (unreachable height); the client spins it and writes live scores.
    items.push(sign('COLORFRONT', 'holo', 0, 15.5, 0, 14, 4.5, 'z+', 'TURF CONTROL'));
    items.push(sign('COLORFRONT', 'neutral', 0, 2.9, 26 - FACE, 15, 2.8, 'z-', 'NEON TERMINAL · PORT 07'));
    items.push(sign('FLANK', 'warning', 0, 2.6, 33 + FACE, 8, 1.8, 'z+'));
    return items;
}

export function buildNeonTerminalDecor(density = 1): DecorItem[] {
    const west = westHalf(density);
    return [...west, ...west.map(mirrorItem), ...quays(density), ...centre()];
}
