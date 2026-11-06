import { schema, t } from '@colyseus/schema';
import type { SchemaType } from '@colyseus/schema';

/**
 * Replicated player state. Remote clients interpolate it; the owning client reconciles its
 * prediction against it (every field the shared movement/weapon step reads is included).
 * Fields tagged `.view()` only reach the owner (each client's StateView holds its own player):
 * they exist for prediction and would otherwise be ~40 % of every patch (D-017).
 */
export const NetPlayer = schema(
    {
        name: t.string(),
        team: t.string(),
        connected: t.boolean(),
        ready: t.boolean(),
        x: t.float32(),
        y: t.float32(),
        z: t.float32(),
        vx: t.float32().view(),
        vy: t.float32().view(),
        vz: t.float32().view(),
        yaw: t.float32(),
        pitch: t.float32(),
        grounded: t.boolean(),
        alive: t.boolean(),
        hp: t.uint8(),
        ammo: t.uint8(),
        reload: t.uint8(),
        fireCd: t.uint8().view(),
        dash: t.uint8(),
        dashCd: t.uint16().view(),
        dashX: t.float32().view(),
        dashZ: t.float32().view(),
        buttons: t.uint8(),
        /** Last input sequence the server applied (prediction acknowledgement). */
        seq: t.uint32().view(),
        invuln: t.uint8().view(),
        respawn: t.uint8().view(),
        kills: t.uint16(),
        deaths: t.uint16(),
        painted: t.uint32(),
        /** Cosmetic outfit (validated look string, Phase 6 Gate 3-B). Never read by gameplay. */
        look: t.string()
    },
    'NetPlayer'
);
export type NetPlayer = SchemaType<typeof NetPlayer>;

export const MatchState = schema(
    {
        phase: t.string(),
        round: t.uint16(),
        tick: t.uint32(),
        /** Ticks left in the current timed phase (countdown, match clock, results). */
        ticksLeft: t.uint32(),
        blue: t.uint32(),
        orange: t.uint32(),
        paintable: t.uint32(),
        winner: t.string(),
        players: t.map(NetPlayer)
    },
    'MatchState'
);
export type MatchState = SchemaType<typeof MatchState>;
