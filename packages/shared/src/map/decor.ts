import { MOVEMENT, PLAYER_SHAPE } from '../constants/simulation.ts';
import type { CollisionWorld, CompiledSolid } from '../simulation/collision.ts';
import { surfaceTopAt } from '../simulation/collision.ts';
import type { Vec3 } from '../types/math.ts';
import type { SolidTag } from './types.ts';

/**
 * Purely visual map decoration. Decor never collides, so every item must be placed where no
 * player can ever be: validated by `decorViolations` (unit-tested for the shipped layout).
 */
export type DecorMaterial =
    | 'trim'
    | 'hazard'
    | 'neon-blue'
    | 'neon-orange'
    | 'neon-white'
    | 'machine'
    | 'tank'
    | 'beacon'
    | 'crane'
    | 'skyline'
    | 'container'
    | 'pole'
    | 'lamp'
    | 'apron'
    | 'water'
    | 'marking'
    | 'girder';

export type RGB = [number, number, number];

export type DecorBox = { kind: 'box'; material: DecorMaterial; min: Vec3; max: Vec3; color?: RGB };
/** Vertical cylinder standing on `base`. */
export type DecorCylinder = { kind: 'cylinder'; material: DecorMaterial; base: Vec3; radius: number; height: number; color?: RGB };
export type SignFacing = 'x+' | 'x-' | 'z+' | 'z-' | 'y+';
export type SignStyle = 'blue' | 'orange' | 'neutral' | 'warning' | 'holo';
/** Text panel; `center` is the panel centre, `facing` its outward normal. */
export type DecorSign = { kind: 'sign'; text: string; sub?: string; style: SignStyle; center: Vec3; width: number; height: number; facing: SignFacing };

export type DecorItem = DecorBox | DecorCylinder | DecorSign;

export type Bounds = { min: Vec3; max: Vec3 };

const SIGN_THICKNESS = 0.02;

export function decorBounds(item: DecorItem): Bounds {
    if (item.kind === 'box') return { min: item.min, max: item.max };
    if (item.kind === 'cylinder') {
        const b = item.base;
        return {
            min: { x: b.x - item.radius, y: b.y, z: b.z - item.radius },
            max: { x: b.x + item.radius, y: b.y + item.height, z: b.z + item.radius }
        };
    }
    const c = item.center;
    const hw = item.width / 2;
    const hh = item.height / 2;
    const t = SIGN_THICKNESS / 2;
    switch (item.facing) {
        case 'x+':
        case 'x-':
            return { min: { x: c.x - t, y: c.y - hh, z: c.z - hw }, max: { x: c.x + t, y: c.y + hh, z: c.z + hw } };
        case 'z+':
        case 'z-':
            return { min: { x: c.x - hw, y: c.y - hh, z: c.z - t }, max: { x: c.x + hw, y: c.y + hh, z: c.z + t } };
        default:
            return { min: { x: c.x - hw, y: c.y - t, z: c.z - hh }, max: { x: c.x + hw, y: c.y + t, z: c.z + hh } };
    }
}

/** Tags whose top surface a player can stand on. Building and boundary roofs are out of reach. */
const WALKABLE: readonly SolidTag[] = ['floor', 'platform', 'ramp', 'bridge', 'cover'];

/** Highest a player's body can reach above the surface they stand on (jump apex + height + margin). */
export const PLAYER_REACH =
    (MOVEMENT.jumpSpeed * MOVEMENT.jumpSpeed) / (2 * MOVEMENT.gravity) + PLAYER_SHAPE.height + MOVEMENT.stepHeight;

const MAX_FLUSH = 0.06;
const MAX_MARKING = 0.012;
const EPS = 0.011;

const overlapsXZ = (b: Bounds, s: CompiledSolid, margin: number) =>
    b.max.x > s.minX - margin && b.min.x < s.maxX + margin && b.max.z > s.minZ - margin && b.min.z < s.maxZ + margin;

/** Highest walkable surface top under/near the box footprint that is not above the box. */
function supportBelow(world: CollisionWorld, b: Bounds, margin: number): number {
    let best = -Infinity;
    for (const s of world.solids) {
        if (!WALKABLE.includes(s.source.tag) || !overlapsXZ(b, s, margin)) continue;
        if (s.minY >= b.max.y) continue; // entirely above the item (e.g. a deck over a girder)
        const cx = Math.min(Math.max((b.min.x + b.max.x) / 2, s.minX), s.maxX);
        const cz = Math.min(Math.max((b.min.z + b.max.z) / 2, s.minZ), s.maxZ);
        const top = s.source.kind === 'ramp' ? s.maxY : surfaceTopAt(s, cx, cz);
        if (top > best) best = top;
    }
    return best;
}

/** True if the thin box lies flat against a face of some solid and within that face. */
function isFlushMounted(world: CollisionWorld, b: Bounds): boolean {
    const tx = b.max.x - b.min.x;
    const tz = b.max.z - b.min.z;
    for (const s of world.solids) {
        if (b.min.y < s.minY - EPS || b.max.y > s.maxY + EPS) continue;
        if (tx <= MAX_FLUSH && b.min.z >= s.minZ - EPS && b.max.z <= s.maxZ + EPS) {
            if (Math.abs(b.min.x - s.maxX) <= EPS || Math.abs(b.max.x - s.minX) <= EPS) return true;
        }
        if (tz <= MAX_FLUSH && b.min.x >= s.minX - EPS && b.max.x <= s.maxX + EPS) {
            if (Math.abs(b.min.z - s.maxZ) <= EPS || Math.abs(b.max.z - s.minZ) <= EPS) return true;
        }
    }
    return false;
}

/** True if the box is a flat marking lying on a walkable top surface. */
function isFloorMarking(world: CollisionWorld, b: Bounds): boolean {
    if (b.max.y - b.min.y > MAX_MARKING) return false;
    for (const s of world.solids) {
        if (s.source.kind !== 'box' || !WALKABLE.includes(s.source.tag)) continue;
        if (b.min.x < s.minX - EPS || b.max.x > s.maxX + EPS || b.min.z < s.minZ - EPS || b.max.z > s.maxZ + EPS) continue;
        if (b.min.y >= s.maxY - 0.001 && b.min.y <= s.maxY + 0.02) return true;
    }
    return false;
}

/**
 * List every decor item that a player could touch or that sits inside the play space.
 * Safe placements: outside the arena footprint; flush against a face (≤ 6 cm); a floor marking
 * (≤ 1.2 cm); or high enough above every walkable surface near its footprint that no jump can
 * reach it (this covers building roofs, which are never walkable).
 */
export function decorViolations(world: CollisionWorld, items: readonly DecorItem[]): string[] {
    const out: string[] = [];
    const bounds = world.bounds;
    const margin = PLAYER_SHAPE.radius + 0.1;
    items.forEach((item, index) => {
        const b = decorBounds(item);
        const outside = b.max.x <= bounds.minX || b.min.x >= bounds.maxX || b.max.z <= bounds.minZ || b.min.z >= bounds.maxZ;
        if (outside) return;
        if (isFlushMounted(world, b) || isFloorMarking(world, b)) return;
        // Above every walkable surface around it by more than a player can reach. Building and
        // boundary roofs are not walkable, so rooftop props pass as long as they keep clear of
        // the edges next to the high ground; bridge girders pass because the deck is above them.
        if (b.min.y >= supportBelow(world, b, margin) + PLAYER_REACH) return;
        out.push(`#${index} ${item.kind}${item.kind === 'sign' ? ` "${item.text}"` : ` ${item.material}`} at ${JSON.stringify(b)}`);
    });
    return out;
}
