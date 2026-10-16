import { PLAYER_SHAPE } from '../constants/simulation.ts';
import { type CollisionWorld, raycast } from '../simulation/collision.ts';
import type { Vec3 } from '../types/math.ts';
import type { PlayerState } from '../types/player.ts';

/**
 * Aim geometry. The third-person camera sits behind `aimPivot` looking along `aimDirection`, so
 * the screen-centre crosshair ray is exactly the ray from the pivot. Client camera and server
 * hit validation must both use these functions.
 */
export const AIM = {
    pivotHeight: 1.55,
    shoulderOffset: 0.8,
    /** Gap kept between the pivot (and camera) and a wall it is pulled in by. */
    wallMargin: 0.25,
    /** Shots leave from the chest, inside the player's own collision cylinder. */
    muzzleHeight: 1.2,
    muzzleSide: 0.3,
    /** How far the crosshair ray looks for a target point. */
    aimDistance: 200,
    /** After max range a shot falls straight down at most this far. */
    dropDistance: 60
} as const;

export function aimDirection(yaw: number, pitch: number): Vec3 {
    const cosP = Math.cos(pitch);
    return { x: -Math.sin(yaw) * cosP, y: Math.sin(pitch), z: -Math.cos(yaw) * cosP };
}

/** Over-the-shoulder pivot, pulled toward the head when a wall is in the way. */
export function aimPivot(world: CollisionWorld, feet: Vec3, yaw: number): Vec3 {
    const head = { x: feet.x, y: feet.y + AIM.pivotHeight, z: feet.z };
    const right = { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
    const hit = raycast(world, head, right, AIM.shoulderOffset + AIM.wallMargin);
    const side = hit ? Math.max(0, hit.distance - AIM.wallMargin) : AIM.shoulderOffset;
    return { x: head.x + right.x * side, y: head.y, z: head.z + right.z * side };
}

export interface ShotTrace {
    /** Muzzle point the shot left from. */
    origin: Vec3;
    /** What the crosshair was pointing at. */
    aimPoint: Vec3;
    /** Where the flight ended: the hit point, or the end of the range before the paint dropped. */
    flightEnd: Vec3;
    /** Where the paint landed; null if nothing was below the end of the range. */
    impact: Vec3 | null;
    /** Normal of the hit face at `impact`. */
    normal: Vec3 | null;
    solidId: string | null;
    /** Player hit by this shot (paint does not reach the ground then). */
    hitPlayerId: string | null;
    /** True when nothing was hit within range and the paint fell to the ground. */
    dropped: boolean;
}

/** Hit cylinder is a little wider than the movement cylinder (GDD 4.1: hit shape ≠ visual model). */
export const HIT_RADIUS = PLAYER_SHAPE.radius + 0.08;

/** Distance along a normalised ray to a player's hit cylinder, or null. */
export function rayVsPlayer(origin: Vec3, dir: Vec3, maxDistance: number, target: PlayerState): number | null {
    const p = target.position;
    const y0 = p.y;
    const y1 = p.y + PLAYER_SHAPE.height;
    const ox = origin.x - p.x;
    const oz = origin.z - p.z;
    const r2 = HIT_RADIUS * HIT_RADIUS;
    let best = Infinity;
    const a = dir.x * dir.x + dir.z * dir.z;
    if (a > 1e-9) {
        const b = 2 * (ox * dir.x + oz * dir.z);
        const c = ox * ox + oz * oz - r2;
        const disc = b * b - 4 * a * c;
        if (disc >= 0) {
            const t = (-b - Math.sqrt(disc)) / (2 * a);
            const y = origin.y + dir.y * t;
            if (t >= 0 && y >= y0 && y <= y1) best = t;
        }
    }
    // Caps (shots from above or below).
    if (Math.abs(dir.y) > 1e-9) {
        for (const yc of [y0, y1]) {
            const t = (yc - origin.y) / dir.y;
            if (t < 0 || t >= best) continue;
            const x = ox + dir.x * t;
            const z = oz + dir.z * t;
            if (x * x + z * z <= r2) best = t;
        }
    }
    return best <= maxDistance ? best : null;
}

function firstPlayer(origin: Vec3, dir: Vec3, maxDistance: number, targets: readonly PlayerState[]) {
    let best: { distance: number; id: string } | null = null;
    for (const t of targets) {
        const d = rayVsPlayer(origin, dir, maxDistance, t);
        if (d !== null && (!best || d < best.distance)) best = { distance: d, id: t.id };
    }
    return best;
}

const add = (a: Vec3, d: Vec3, t: number): Vec3 => ({ x: a.x + d.x * t, y: a.y + d.y * t, z: a.z + d.z * t });

/**
 * Hitscan for one shot from a player's current state (GDD 4.2: server raycast/hitscan).
 * 1. Crosshair ray from the aim pivot finds the aim point.
 * 2. A ray from the muzzle toward that point, limited to `range`, finds the first obstacle.
 * 3. If nothing is hit within range, the paint drops vertically from the range end.
 * `targets` are the players this shot can hit (enemies that are alive); they also stop the
 * crosshair ray so aiming at an enemy aims the muzzle at them.
 */
export function traceShot(world: CollisionWorld, state: PlayerState, range: number, targets: readonly PlayerState[] = []): ShotTrace {
    const pos = state.position;
    const dir = aimDirection(state.yaw, state.pitch);
    const pivot = aimPivot(world, pos, state.yaw);
    const aimHit = raycast(world, pivot, dir, AIM.aimDistance);
    const aimWorld = aimHit ? aimHit.distance : AIM.aimDistance;
    const aimPlayer = firstPlayer(pivot, dir, aimWorld, targets);
    const aimPoint = add(pivot, dir, aimPlayer ? aimPlayer.distance : aimWorld);

    const right = { x: Math.cos(state.yaw), y: 0, z: -Math.sin(state.yaw) };
    const origin = { x: pos.x + right.x * AIM.muzzleSide, y: pos.y + AIM.muzzleHeight, z: pos.z + right.z * AIM.muzzleSide };
    let sx = aimPoint.x - origin.x;
    let sy = aimPoint.y - origin.y;
    let sz = aimPoint.z - origin.z;
    const len = Math.sqrt(sx * sx + sy * sy + sz * sz);
    let shotDir: Vec3;
    if (len < 1e-6 || (sx * dir.x + sy * dir.y + sz * dir.z) / len < 0.2) {
        // Aim point is (almost) behind the muzzle, e.g. hugging a wall: shoot along the view.
        shotDir = dir;
    } else {
        sx /= len;
        sy /= len;
        sz /= len;
        shotDir = { x: sx, y: sy, z: sz };
    }

    const hit = raycast(world, origin, shotDir, range);
    const player = firstPlayer(origin, shotDir, hit ? hit.distance : range, targets);
    if (player) {
        const impact = add(origin, shotDir, player.distance);
        const normal = { x: -shotDir.x, y: -shotDir.y, z: -shotDir.z };
        return { origin, aimPoint, flightEnd: impact, impact, normal, solidId: null, hitPlayerId: player.id, dropped: false };
    }
    if (hit) {
        const impact = add(origin, shotDir, hit.distance);
        return { origin, aimPoint, flightEnd: impact, impact, normal: hit.normal, solidId: hit.solid.source.id, hitPlayerId: null, dropped: false };
    }
    const end = add(origin, shotDir, range);
    const drop = raycast(world, end, { x: 0, y: -1, z: 0 }, AIM.dropDistance);
    if (drop) {
        const impact = add(end, { x: 0, y: -1, z: 0 }, drop.distance);
        return { origin, aimPoint, flightEnd: end, impact, normal: drop.normal, solidId: drop.solid.source.id, hitPlayerId: null, dropped: true };
    }
    return { origin, aimPoint, flightEnd: end, impact: null, normal: null, solidId: null, hitPlayerId: null, dropped: true };
}
