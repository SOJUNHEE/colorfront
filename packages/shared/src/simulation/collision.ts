import type { MapDefinition, Solid } from '../map/types.ts';
import type { Vec3 } from '../types/math.ts';

/** Plane n·p <= d bounding a convex solid. */
interface HalfSpace {
    nx: number;
    ny: number;
    nz: number;
    d: number;
}

export interface CompiledSolid {
    source: Solid;
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
    /** Ramp slope (rise per metre along the axis); 0 for boxes. */
    slope: number;
    planes: HalfSpace[];
}

export interface CollisionWorld {
    solids: CompiledSolid[];
    bounds: MapDefinition['bounds'];
}

const clamp = (v: number, min: number, max: number) => (v < min ? min : v > max ? max : v);

function compileSolid(s: Solid): CompiledSolid {
    const planes: HalfSpace[] = [
        { nx: 1, ny: 0, nz: 0, d: s.max.x },
        { nx: -1, ny: 0, nz: 0, d: -s.min.x },
        { nx: 0, ny: 1, nz: 0, d: s.max.y },
        { nx: 0, ny: -1, nz: 0, d: -s.min.y },
        { nx: 0, ny: 0, nz: 1, d: s.max.z },
        { nx: 0, ny: 0, nz: -1, d: -s.min.z }
    ];
    let slope = 0;
    if (s.kind === 'ramp') {
        const lo = s.axis === 'x' ? s.min.x : s.min.z;
        const hi = s.axis === 'x' ? s.max.x : s.max.z;
        slope = (s.max.y - s.min.y) / (hi - lo);
        // ascending +1: y <= minY + k (a - lo)  ->  -k a + y <= minY - k lo
        // ascending -1: y <= minY + k (hi - a)  ->   k a + y <= minY + k hi
        const k = s.ascending === 1 ? -slope : slope;
        const d = s.ascending === 1 ? s.min.y - slope * lo : s.min.y + slope * hi;
        planes.push(s.axis === 'x' ? { nx: k, ny: 1, nz: 0, d } : { nx: 0, ny: 1, nz: k, d });
    }
    return {
        source: s,
        minX: s.min.x,
        minY: s.min.y,
        minZ: s.min.z,
        maxX: s.max.x,
        maxY: s.max.y,
        maxZ: s.max.z,
        slope,
        planes
    };
}

export function buildCollisionWorld(map: MapDefinition): CollisionWorld {
    return { solids: map.solids.map(compileSolid), bounds: map.bounds };
}

/** Height of the walkable top surface of a solid at (x, z), clamped into its footprint. */
export function surfaceTopAt(s: CompiledSolid, x: number, z: number): number {
    const src = s.source;
    if (src.kind === 'box') return s.maxY;
    const lo = src.axis === 'x' ? s.minX : s.minZ;
    const hi = src.axis === 'x' ? s.maxX : s.maxZ;
    const a = clamp(src.axis === 'x' ? x : z, lo, hi);
    return s.minY + s.slope * (src.ascending === 1 ? a - lo : hi - a);
}

/**
 * Highest walkable surface under a vertical cylinder of radius `footRadius` at (x, z) whose top
 * is not above `maxTop`. Returns -Infinity when nothing is below.
 */
export function findGround(world: CollisionWorld, x: number, z: number, footRadius: number, maxTop: number): number {
    let best = -Infinity;
    const r2 = footRadius * footRadius;
    for (const s of world.solids) {
        const cx = clamp(x, s.minX, s.maxX);
        const cz = clamp(z, s.minZ, s.maxZ);
        const dx = x - cx;
        const dz = z - cz;
        if (dx * dx + dz * dz > r2) continue;
        const top = surfaceTopAt(s, cx, cz);
        if (top <= maxTop && top > best) best = top;
    }
    return best;
}

/**
 * Push a vertical cylinder (feet at pos.y) out of every solid it overlaps horizontally that it
 * cannot step onto. Velocity into the contact normal is removed so the player slides along walls.
 * Returns true if any contact was resolved.
 */
export function resolveHorizontal(
    world: CollisionWorld,
    pos: Vec3,
    vel: Vec3,
    radius: number,
    height: number,
    stepHeight: number
): boolean {
    let hit = false;
    const r2 = radius * radius;
    // A few passes so corner contacts settle.
    for (let pass = 0; pass < 3; pass++) {
        let moved = false;
        for (const s of world.solids) {
            if (s.minY >= pos.y + height) continue;
            const cx = clamp(pos.x, s.minX, s.maxX);
            const cz = clamp(pos.z, s.minZ, s.maxZ);
            const dx = pos.x - cx;
            const dz = pos.z - cz;
            const d2 = dx * dx + dz * dz;
            if (d2 >= r2) continue;
            if (surfaceTopAt(s, cx, cz) <= pos.y + stepHeight) continue;

            let nx: number;
            let nz: number;
            let push: number;
            if (d2 > 1e-12) {
                const d = Math.sqrt(d2);
                nx = dx / d;
                nz = dz / d;
                push = radius - d;
            } else {
                // Centre inside the footprint: leave through the nearest face.
                const toMinX = pos.x - s.minX;
                const toMaxX = s.maxX - pos.x;
                const toMinZ = pos.z - s.minZ;
                const toMaxZ = s.maxZ - pos.z;
                const m = Math.min(toMinX, toMaxX, toMinZ, toMaxZ);
                nx = m === toMinX ? -1 : m === toMaxX ? 1 : 0;
                nz = nx !== 0 ? 0 : m === toMinZ ? -1 : 1;
                push = m + radius;
            }
            pos.x += nx * push;
            pos.z += nz * push;
            const vn = vel.x * nx + vel.z * nz;
            if (vn < 0) {
                vel.x -= vn * nx;
                vel.z -= vn * nz;
            }
            hit = true;
            moved = true;
        }
        if (!moved) break;
    }
    return hit;
}

/**
 * Lowest solid underside the cylinder would hit when its head moves from prevHead up to newHead.
 * Returns Infinity when the way is clear.
 */
export function findCeiling(
    world: CollisionWorld,
    x: number,
    z: number,
    radius: number,
    prevHead: number,
    newHead: number
): number {
    let best = Infinity;
    const r2 = radius * radius;
    for (const s of world.solids) {
        if (s.minY < prevHead - 1e-6 || s.minY >= newHead) continue;
        const cx = clamp(x, s.minX, s.maxX);
        const cz = clamp(z, s.minZ, s.maxZ);
        const dx = x - cx;
        const dz = z - cz;
        if (dx * dx + dz * dz >= r2) continue;
        if (s.minY < best) best = s.minY;
    }
    return best;
}

export interface RayHit {
    distance: number;
    solid: CompiledSolid;
    /** Unit outward normal of the face that was hit (-dir when the ray starts inside a solid). */
    normal: Vec3;
}

/** First intersection of a ray with any solid within maxDistance. `dir` must be normalised. */
export function raycast(world: CollisionWorld, origin: Vec3, dir: Vec3, maxDistance: number): RayHit | null {
    let best: RayHit | null = null;
    for (const s of world.solids) {
        let tEnter = -Infinity;
        let tExit = Infinity;
        let enterPlane: HalfSpace | null = null;
        let miss = false;
        for (const p of s.planes) {
            const denom = p.nx * dir.x + p.ny * dir.y + p.nz * dir.z;
            const dist = p.d - (p.nx * origin.x + p.ny * origin.y + p.nz * origin.z);
            if (denom === 0) {
                if (dist < 0) {
                    miss = true;
                    break;
                }
                continue;
            }
            const t = dist / denom;
            if (denom < 0) {
                if (t > tEnter) {
                    tEnter = t;
                    enterPlane = p;
                }
            } else if (t < tExit) {
                tExit = t;
            }
            if (tEnter > tExit) {
                miss = true;
                break;
            }
        }
        if (miss || tExit < 0) continue;
        const t = Math.max(0, tEnter);
        if (t > maxDistance) continue;
        if (best && t >= best.distance) continue;
        let normal: Vec3;
        if (tEnter >= 0 && enterPlane) {
            const len = Math.sqrt(enterPlane.nx * enterPlane.nx + enterPlane.ny * enterPlane.ny + enterPlane.nz * enterPlane.nz);
            normal = { x: enterPlane.nx / len, y: enterPlane.ny / len, z: enterPlane.nz / len };
        } else {
            normal = { x: -dir.x, y: -dir.y, z: -dir.z };
        }
        best = { distance: t, solid: s, normal };
    }
    return best;
}

/** True if a standing cylinder at `feet` overlaps any solid volume (used by tests/spawn checks). */
export function cylinderOverlapsSolid(
    world: CollisionWorld,
    feet: Vec3,
    radius: number,
    height: number,
    tolerance = 1e-3
): CompiledSolid | null {
    const r = radius - tolerance;
    const r2 = r * r;
    for (const s of world.solids) {
        if (s.minY >= feet.y + height - tolerance) continue;
        const cx = clamp(feet.x, s.minX, s.maxX);
        const cz = clamp(feet.z, s.minZ, s.maxZ);
        const dx = feet.x - cx;
        const dz = feet.z - cz;
        if (dx * dx + dz * dz >= r2) continue;
        if (surfaceTopAt(s, cx, cz) <= feet.y + tolerance) continue;
        return s;
    }
    return null;
}
