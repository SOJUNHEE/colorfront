import type { Vec3 } from '../types/math.ts';
import type { Bounds, DecorBox, DecorCylinder, DecorItem, DecorMaterial, RGB } from './decor.ts';
import { decorBounds } from './decor.ts';
import type { BoxSolid, MapDefinition } from './types.ts';

/**
 * Phase 6 Gate 5 — "ArenaVisualSkin" for Neon Terminal: visual-only detail DERIVED from the
 * collision solids (the collision world itself is untouched). Every item is a DecorItem, so it
 * goes through the same `decorViolations` check as the hand-placed decor (unit-tested):
 *
 *  - module kit, flush (<= 5 cm) on solid faces: wall pilasters/bands/conduits on the boundary,
 *    floor bands and down-pipes on buildings, cliff ribs on the high ground, container rails and
 *    door locking bars, hazard skirts on tall pillars;
 *  - floor variation: worn concrete patches, drain grates and expansion joints as <= 1 cm
 *    markings (they sit under the 3 cm paint overlay, so paint always draws on top);
 *  - three landmarks out of reach: the paint refinery on the south block roof, the harbour
 *    lighthouse beyond the north wall and a container ship south of the quay.
 *
 * Everything maps onto the existing decor materials, so the level keeps its draw-call count.
 * `density` (0..1) drops the finest details on lower graphics presets.
 */

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

type Face = 'x-' | 'x+' | 'z-' | 'z+';
/** Flush relief thickness (decorViolations accepts <= 6 cm). */
const T = 0.05;

/**
 * A panel lying flat on a face of `s`: `a0..a1` along the face (x for z-faces, z for x-faces),
 * `y0..y1` vertical, `t` thick, outside the solid.
 */
function onFace(s: BoxSolid, face: Face, material: DecorMaterial, a0: number, a1: number, y0: number, y1: number, t = T, color?: RGB): DecorBox {
    const { min, max } = s;
    y0 = Math.max(y0, min.y);
    y1 = Math.min(y1, max.y);
    switch (face) {
        case 'x-':
            return box(material, min.x - t, min.x, y0, y1, Math.max(a0, min.z), Math.min(a1, max.z), color);
        case 'x+':
            return box(material, max.x, max.x + t, y0, y1, Math.max(a0, min.z), Math.min(a1, max.z), color);
        case 'z-':
            return box(material, Math.max(a0, min.x), Math.min(a1, max.x), y0, y1, min.z - t, min.z, color);
        case 'z+':
            return box(material, Math.max(a0, min.x), Math.min(a1, max.x), y0, y1, max.z, max.z + t, color);
    }
}

const faceSpan = (s: BoxSolid, face: Face): [number, number] => (face[0] === 'x' ? [s.min.z, s.max.z] : [s.min.x, s.max.x]);

const overlap = (a: Bounds, b: Bounds, m = 0) =>
    a.min.x < b.max.x + m && a.max.x > b.min.x - m && a.min.y < b.max.y + m && a.max.y > b.min.y - m && a.min.z < b.max.z + m && a.max.z > b.min.z - m;

/** Is this face of `s` the one facing into the arena (boundary walls)? */
function innerFace(s: BoxSolid, map: MapDefinition): Face | null {
    const b = map.bounds;
    if (s.max.z <= b.minZ + 1e-6) return 'z+';
    if (s.min.z >= b.maxZ - 1e-6) return 'z-';
    if (s.max.x <= b.minX + 1e-6) return 'x+';
    if (s.min.x >= b.maxX - 1e-6) return 'x-';
    return null;
}

function moduleKit(map: MapDefinition, density: number, avoid: Bounds[]): DecorItem[] {
    const out: DecorItem[] = [];
    const solids = map.solids.filter((s): s is BoxSolid => s.kind === 'box');
    // Faces hidden by touching neighbours do not need detail; signs must stay readable.
    const push = (item: DecorBox) => {
        const b = decorBounds(item);
        if (b.max.x - b.min.x < 0.02 || b.max.y - b.min.y < 0.02 || b.max.z - b.min.z < 0.02) return;
        if (avoid.some((a) => overlap(a, b, 0.25))) return;
        out.push(item);
    };

    for (const s of solids) {
        const h = s.max.y - s.min.y;
        switch (s.tag) {
            case 'boundary': {
                const face = innerFace(s, map);
                if (!face) break;
                const [a0, a1] = faceSpan(s, face);
                // Pilasters every 8 m with a cap and a base plinth; a band at 3 m; coping at the top.
                for (let a = a0 + 4; a < a1 - 2; a += 8) {
                    push(onFace(s, face, 'machine', a - 0.35, a + 0.35, 0, s.max.y));
                    push(onFace(s, face, 'hazard', a - 0.35, a + 0.35, 0, 0.45, T + 0.005));
                    if (density > 0.5) push(onFace(s, face, 'pole', a + 1.6, a + 1.75, 0.3, s.max.y - 0.6, T));
                }
                push(onFace(s, face, 'machine', a0, a1, 2.9, 3.15, 0.04));
                push(onFace(s, face, 'trim', a0, a1, s.max.y - 0.35, s.max.y, T));
                // Neon accent line under the coping (glows at dusk/night presets alike).
                push(onFace(s, face, 'neon-white', a0, a1, s.max.y - 0.52, s.max.y - 0.46, 0.03));
                break;
            }
            case 'building': {
                for (const face of ['x-', 'x+', 'z-', 'z+'] as Face[]) {
                    const [a0, a1] = faceSpan(s, face);
                    // Floor bands every 3.2 m, down-pipes near both ends, a parapet lip at the top.
                    for (let y = 3.2; y < h - 0.8; y += 3.2) push(onFace(s, face, 'machine', a0, a1, y, y + 0.2, 0.04));
                    push(onFace(s, face, 'pole', a0 + 0.35, a0 + 0.55, 0, s.max.y - 0.2));
                    push(onFace(s, face, 'pole', a1 - 0.55, a1 - 0.35, 0, s.max.y - 0.2));
                    push(onFace(s, face, 'trim', a0, a1, s.max.y - 0.25, s.max.y, T));
                    // Wall-mounted service boxes and vents at head height on long faces.
                    if (density > 0.5 && a1 - a0 > 10)
                        for (let a = a0 + 3.5; a < a1 - 3; a += 7.5) push(onFace(s, face, 'machine', a, a + 1.4, 2.2, 3.0, T));
                }
                break;
            }
            case 'platform': {
                // High-ground cliff faces: structural ribs every 5 m, a mid band and a drain line.
                for (const face of ['x-', 'x+', 'z-', 'z+'] as Face[]) {
                    const [a0, a1] = faceSpan(s, face);
                    for (let a = a0 + 2.5; a < a1 - 1; a += 5) push(onFace(s, face, 'machine', a - 0.25, a + 0.25, 0, s.max.y - 0.5));
                    push(onFace(s, face, 'machine', a0, a1, s.max.y * 0.5 - 0.1, s.max.y * 0.5 + 0.1, 0.04));
                    if (density > 0.5) push(onFace(s, face, 'neon-white', a0, a1, 0.6, 0.66, 0.03));
                }
                break;
            }
            case 'cover': {
                if (h >= 2.4 && h < 3) {
                    // Shipping container: top/bottom rails on every face, locking bars on the doors.
                    const long: Face[] = s.max.x - s.min.x >= s.max.z - s.min.z ? ['z-', 'z+'] : ['x-', 'x+'];
                    const ends: Face[] = long[0][0] === 'z' ? ['x-', 'x+'] : ['z-', 'z+'];
                    for (const face of [...long, ...ends]) {
                        const [a0, a1] = faceSpan(s, face);
                        push(onFace(s, face, 'trim', a0 + 0.14, a1 - 0.14, s.max.y - 0.16, s.max.y - 0.02, 0.04));
                        push(onFace(s, face, 'trim', a0 + 0.14, a1 - 0.14, 0.02, 0.16, 0.04));
                    }
                    if (density > 0.35)
                        for (const face of ends) {
                            const [a0, a1] = faceSpan(s, face);
                            const w = a1 - a0;
                            for (const f of [0.2, 0.4, 0.6, 0.8]) push(onFace(s, face, 'pole', a0 + w * f - 0.03, a0 + w * f + 0.03, 0.2, s.max.y - 0.2, 0.04));
                            // Door seam.
                            push(onFace(s, face, 'trim', a0 + w / 2 - 0.02, a0 + w / 2 + 0.02, 0.16, s.max.y - 0.16, 0.02));
                        }
                } else if (h > 3) {
                    // Tall pillars: hazard skirt and a neon edge line on each face.
                    for (const face of ['x-', 'x+', 'z-', 'z+'] as Face[]) {
                        const [a0, a1] = faceSpan(s, face);
                        push(onFace(s, face, 'hazard', a0, a1, 0, 0.6, 0.03));
                        push(onFace(s, face, 'neon-white', a0 + 0.12, a0 + 0.2, 0.8, s.max.y - 0.3, 0.03));
                    }
                }
                break;
            }
            default:
                break;
        }
    }
    return out;
}

/** Floor variation under the paint: worn patches, drain grates, expansion joints. */
function floorDetail(map: MapDefinition, density: number, avoid: Bounds[]): DecorItem[] {
    const out: DecorItem[] = [];
    const r = rng(0x5eed5);
    const b = map.bounds;
    const blockers: Bounds[] = map.solids.filter((s) => s.tag !== 'floor').map((s) => ({ min: s.min, max: s.max }));
    const free = (x0: number, x1: number, z0: number, z1: number) => {
        const fb: Bounds = { min: v(x0, -0.1, z0), max: v(x1, 0.1, z1) };
        return !blockers.some((s) => overlap(s, fb, 0.3)) && !avoid.some((a) => overlap(a, fb, 0.2));
    };
    // Markings at the same height must not overlap (z-fighting): each layer keeps its own list.
    const layers = new Map<number, Bounds[]>();
    const mark = (x0: number, x1: number, z0: number, z1: number, color: RGB, y = 0.004, t = 0.005) => {
        if (x0 < b.minX + 0.3 || x1 > b.maxX - 0.3 || z0 < b.minZ + 0.3 || z1 > b.maxZ - 0.3) return;
        if (!free(x0, x1, z0, z1)) return;
        const fb: Bounds = { min: v(x0, y, z0), max: v(x1, y + t, z1) };
        const layer = layers.get(y) ?? [];
        if (layer.some((o) => overlap(o, fb))) return;
        layer.push(fb);
        layers.set(y, layer);
        out.push(box('marking', x0, x1, y, y + t, z0, z1, color));
    };
    // Worn concrete patches (mirrored pairs keep the halves fair-looking).
    // Saw-cut repair seams: dark outlines of resurfaced slabs (outline only - a flat untextured
    // fill reads as a pasted rectangle). Mirrored so both halves look alike.
    const patches = Math.round(30 * density);
    const seam: RGB = [0.13, 0.135, 0.145];
    const outline = (x0: number, x1: number, z0: number, z1: number) => {
        const w = 0.05;
        if (!free(x0, x1, z0, z1)) return;
        mark(x0, x1, z0, z0 + w, seam, 0.003, 0.003);
        mark(x0, x1, z1 - w, z1, seam, 0.003, 0.003);
        mark(x0, x0 + w, z0 + w, z1 - w, seam, 0.003, 0.003);
        mark(x1 - w, x1, z0 + w, z1 - w, seam, 0.003, 0.003);
    };
    for (let i = 0; i < patches; i++) {
        const w = 2.5 + r() * 5;
        const d = 2 + r() * 4.5;
        const x = b.minX + 4 + r() * (-b.minX - 8);
        const z = b.minZ + 3 + r() * (b.maxZ - b.minZ - 6);
        outline(x, x + w, z, z + d);
        outline(-x - w, -x, z, z + d);
    }
    // Drain grates along both sides of the centre lane and around the plaza.
    const grate: RGB = [0.1, 0.11, 0.12];
    for (let x = -52; x <= -27; x += 6.25) {
        for (const z of [-15.5, 15]) {
            mark(x, x + 1.1, z, z + 0.45, grate, 0.006, 0.005);
            mark(-x - 1.1, -x, z, z + 0.45, grate, 0.006, 0.005);
        }
    }
    for (const [x, z] of [
        [-20, -19],
        [-20, 19],
        [19, -19],
        [19, 19],
        [0, 22],
        [0, -36]
    ])
        mark(x, x + 0.9, z, z + 0.9, grate, 0.006, 0.005);
    // Expansion joints across the flank route.
    if (density > 0.5) for (let x = -72; x <= 72; x += 12) mark(x - 0.05, x + 0.05, 40, 59.5, [0.22, 0.23, 0.25], 0.004, 0.004);
    return out;
}

/** Three landmarks, all far above or outside player space. */
function landmarks(density: number): DecorItem[] {
    const out: DecorItem[] = [];
    // 1) Paint refinery on the south block roof (roof y = 5, never walkable; plaza floor below).
    const roof = 5;
    out.push(box('machine', -10.5, 10.5, roof, roof + 0.6, 27, 32)); // plinth
    for (const [x, team] of [
        [-6.5, 'blue'],
        [6.5, 'orange']
    ] as const) {
        const tint: RGB = team === 'blue' ? [0.16, 0.3, 0.6] : [0.7, 0.36, 0.12];
        out.push(cyl('tank', x, roof + 0.6, 29.5, 2.1, 6.4, tint));
        out.push(cyl('tank', x, roof + 7, 29.5, 1.5, 0.8, [0.42, 0.44, 0.47]));
        for (const y of [2.2, 4.4]) out.push(cyl(team === 'blue' ? 'neon-blue' : 'neon-orange', x, roof + 0.6 + y, 29.5, 2.16, 0.18));
        out.push(cyl('pole', x + (x < 0 ? 2.4 : -2.4), roof + 0.6, 28.1, 0.12, 6));
    }
    // Pipe bridge between the tanks and a central mast with beacon rings.
    out.push(box('trim', -4.4, 4.4, roof + 5.6, roof + 6.1, 29.25, 29.75));
    out.push(cyl('pole', 0, roof + 0.6, 29.5, 0.32, 16));
    for (const y of [6.5, 10.5, 14.5]) out.push(cyl('neon-white', 0, roof + 0.6 + y, 29.5, 0.55, 0.16));
    out.push(box('beacon', -0.35, 0.35, roof + 16.6, roof + 17.3, 29.15, 29.85));

    // 2) Harbour lighthouse beyond the north wall (x = 0, z = -82): striped tower + lamp house.
    const lx = 0;
    const lz = -82;
    const red: RGB = [0.7, 0.16, 0.12];
    const white: RGB = [0.88, 0.88, 0.86];
    let y = 0;
    for (let i = 0; i < 6; i++) {
        const radius = 3.4 - i * 0.28;
        out.push(cyl('tank', lx, y, lz, radius, 5.5, i % 2 ? white : red));
        y += 5.5;
    }
    out.push(cyl('trim', lx, y, lz, 2.6, 0.4));
    out.push(cyl('lamp', lx, y + 0.4, lz, 1.5, 2.4));
    out.push(cyl('trim', lx, y + 2.8, lz, 1.9, 0.5));
    out.push(cyl('pole', lx, y + 3.3, lz, 0.1, 3));
    out.push(box('beacon', lx - 0.3, lx + 0.3, y + 6.3, y + 6.9, lz - 0.3, lz + 0.3));

    // 3) Container ship moored south of the quay (water from z = 100).
    const hull: RGB = [0.32, 0.08, 0.07];
    const sx0 = -64;
    const sx1 = 70;
    const sz0 = 108;
    const sz1 = 126;
    out.push(box('crane', sx0, sx1, -1.5, 5.2, sz0, sz1, hull));
    out.push(box('crane', sx0 - 8, sx0, -1.5, 5.2, sz0 + 3, sz1 - 3, hull)); // bow
    out.push(box('crane', sx0, sx1, 5.2, 5.6, sz0, sz1, [0.75, 0.75, 0.72])); // deck edge
    out.push(box('marking', sx0, sx1, 0.4, 0.9, sz0 - 0.02, sz0, [0.85, 0.85, 0.82])); // waterline stripe
    const r = rng(0xc0ffee);
    const colors: RGB[] = [
        [0.55, 0.16, 0.12],
        [0.13, 0.32, 0.4],
        [0.62, 0.45, 0.12],
        [0.18, 0.38, 0.22],
        [0.6, 0.6, 0.58]
    ];
    const bays = density > 0.5 ? 9 : 5;
    for (let i = 0; i < bays; i++) {
        const x = sx0 + 4 + i * 12.5;
        const tiers = 2 + Math.floor(r() * 3);
        for (let row = 0; row < 6; row++) {
            for (let tier = 0; tier < tiers; tier++) {
                const c = colors[Math.floor(r() * colors.length)];
                out.push(box('container', x, x + 12, 5.6 + tier * 2.6, 5.6 + tier * 2.6 + 2.55, sz0 + 1 + row * 2.6, sz0 + 1 + row * 2.6 + 2.5, c));
            }
        }
    }
    // Bridge house at the stern with lit windows and a funnel.
    out.push(box('crane', sx1 - 12, sx1 - 2, 5.6, 21, sz0 + 2, sz1 - 2, [0.86, 0.86, 0.84]));
    for (const wy of [10, 14, 18]) out.push(box('neon-white', sx1 - 12.06, sx1 - 12, wy, wy + 0.8, sz0 + 3, sz1 - 3));
    out.push(cyl('tank', sx1 - 6, 21, sz0 + 9, 1.6, 6, [0.2, 0.2, 0.22]));
    out.push(box('beacon', sx1 - 6.3, sx1 - 5.7, 27, 27.6, sz0 + 8.7, sz0 + 9.3));
    return out;
}

/**
 * The visual skin for a map built from its solids. `avoid` = bounds that must stay visible
 * (signs): flush details keep clear of them.
 */
export function buildNeonTerminalSkin(map: MapDefinition, density = 1, avoid: Bounds[] = []): DecorItem[] {
    return [...moduleKit(map, density, avoid), ...floorDetail(map, density, avoid), ...landmarks(density)];
}
