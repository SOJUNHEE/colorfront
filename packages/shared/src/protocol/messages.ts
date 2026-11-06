/**
 * Network contract between the client and the Colyseus 0.18 MatchRoom (GDD 7.2).
 * Player positions, HP, ammo, phase, timer and scores travel in the room's Schema state
 * (delta-encoded patches). Paint and one-off events travel as messages below.
 */
import type { TeamId } from '../types/player.ts';
import type { Vec3 } from '../types/math.ts';

export const ROOM_NAME = 'match';
export const DEFAULT_SERVER_PORT = 2567;

export const ClientMessage = {
    /** Tuple [seq, moveX, moveZ, yaw, pitch, buttons] — one per client tick (30/s). */
    Input: 'in',
    /** boolean */
    Ready: 'ready',
    /** Ask for a fresh paint snapshot (sequence gap or hash mismatch). */
    PaintResync: 'paint:resync',
    /** Cosmetic outfit change: look string (see avatar/appearance.ts). Rate limited, validated. */
    Look: 'look',
    /** Weapon choice (WeaponId). Equipped now inside the own spawn zone, else at next respawn. */
    Weapon: 'weapon',
    /** Chat line (string, validated and rate limited by the server). */
    Chat: 'chat'
} as const;

/** Minimum time between accepted weapon choices from one player. */
export const WEAPON_MIN_INTERVAL_MS = 250;

/** Minimum time between accepted outfit changes from one player. */
export const LOOK_MIN_INTERVAL_MS = 1000;
export type ClientMessage = (typeof ClientMessage)[keyof typeof ClientMessage];

export const ServerMessage = {
    /** Sent once after join: static session info. */
    Hello: 'hello',
    /** Binary, see paint/PaintSync.ts. */
    PaintSnapshot: 'paint:snapshot',
    PaintDelta: 'paint:delta',
    /** Periodic { seq, hash } so clients can verify their paint copy. */
    PaintHash: 'paint:hash',
    /** Batched gameplay events of one server tick. */
    Events: 'ev',
    RoundResult: 'round:result'
} as const;
export type ServerMessage = (typeof ServerMessage)[keyof typeof ServerMessage];

export type InputTuple = [seq: number, moveX: number, moveZ: number, yaw: number, pitch: number, buttons: number];

export type HelloMessage = {
    sessionId: string;
    mapId: string;
    tickRate: number;
    patchRateMs: number;
    serverTime: number;
};

/** A position in whole centimetres (msgpack sends small ints in 1–3 bytes instead of 9). */
export type PackedVec = [number, number, number];

/**
 * A shot as other clients need it. The muzzle origin is not sent (each client draws from the
 * shooter's visible rifle) and neither is the team (known from the shooter). Measured at 15 v 15,
 * shot events were ~46 % of the downstream; this layout is about a quarter of the old one.
 */
export type NetShot = {
    t: 's';
    /** shooter session id */
    p: string;
    /** where the flight ended (cm) */
    e: PackedVec;
    /** impact (cm), only when it differs from `e` (paint dropped short of the range end) */
    i?: PackedVec;
    /** 1 = nothing below the flight end: no impact at all */
    x?: 1;
    /** surface normal at the impact ×100 */
    n?: PackedVec;
    /** 1 = the paint dropped (nothing hit within range) */
    d?: 1;
    /** hit player session id */
    h?: string;
};

/** Compact event union (short keys keep the per-tick broadcast small). */
export type NetEvent =
    | NetShot
    | { t: 'h'; a: string; v: string; dmg: number; at: PackedVec }
    | { t: 'k'; a: string; v: string; team: TeamId; at: PackedVec }
    | { t: 'r'; p: string };

export const packVec = (v: Vec3, scale = 100): PackedVec => [Math.round(v.x * scale), Math.round(v.y * scale), Math.round(v.z * scale)];
export const unpackVec = (p: PackedVec, scale = 100): Vec3 => ({ x: p[0] / scale, y: p[1] / scale, z: p[2] / scale });

export type ShotLike = { flightEnd: Vec3; impact: Vec3 | null; normal: Vec3 | null; dropped: boolean; hitPlayerId: string | null };

export function packShot(playerId: string, shot: ShotLike): NetShot {
    const e = packVec(shot.flightEnd);
    const ev: NetShot = { t: 's', p: playerId, e };
    if (!shot.impact) ev.x = 1;
    else {
        const i = packVec(shot.impact);
        if (i[0] !== e[0] || i[1] !== e[1] || i[2] !== e[2]) ev.i = i;
    }
    if (shot.normal) ev.n = packVec(shot.normal);
    if (shot.dropped) ev.d = 1;
    if (shot.hitPlayerId) ev.h = shot.hitPlayerId;
    return ev;
}

/** Visual shot data for effects; `origin` is a placeholder the client replaces with the muzzle. */
export function unpackShot(ev: NetShot) {
    const flightEnd = unpackVec(ev.e);
    return {
        origin: flightEnd,
        aimPoint: flightEnd,
        flightEnd,
        impact: ev.x ? null : ev.i ? unpackVec(ev.i) : flightEnd,
        normal: ev.n ? unpackVec(ev.n) : null,
        solidId: null,
        hitPlayerId: ev.h ?? null,
        dropped: ev.d === 1
    };
}

export type EventsMessage = { tick: number; ev: NetEvent[] };

export type PaintHashMessage = { seq: number; hash: number; blue: number; orange: number; paintable: number };

export type RoundResultMessage = {
    round: number;
    paintable: number;
    blue: number;
    orange: number;
    winner: TeamId | 'draw';
    /** Final paint hash, so every client can confirm it showed the same result. */
    hash: number;
    players: { id: string; name: string; team: TeamId; painted: number; kills: number; deaths: number }[];
};
