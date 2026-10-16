import type { Vec3 } from './math.ts';
import type { WeaponId } from './weapon.ts';

export type TeamId = 'blue' | 'orange';

/**
 * One fixed-tick command from a client. Only intent is sent — never positions, hits or paint
 * results (GDD 2.2, 7.2). See sanitizeInput() for valid ranges.
 */
export interface PlayerInput {
    /** Monotonic per-client sequence, used for server acknowledgement and reconciliation. */
    seq: number;
    /** Strafe axis, -1 (left) .. 1 (right). */
    moveX: number;
    /** Forward axis, -1 (back) .. 1 (forward). */
    moveZ: number;
    /** Radians. 0 looks down -Z; positive turns toward -X (PlayCanvas convention). */
    yaw: number;
    /** Radians, positive looks up. */
    pitch: number;
    /** InputButton bit flags. */
    buttons: number;
}

/** Simulation state of one player. Mutated in place by the shared step functions. */
export interface PlayerState {
    id: string;
    team: TeamId;
    /** Feet position (bottom centre of the collision cylinder). */
    position: Vec3;
    velocity: Vec3;
    yaw: number;
    pitch: number;
    grounded: boolean;

    dashTicksRemaining: number;
    dashCooldownTicks: number;
    dashDirX: number;
    dashDirZ: number;

    /** Buttons of the previous processed input, for edge detection (jump/dash/reload). */
    lastButtons: number;
    lastProcessedSeq: number;

    hp: number;
    alive: boolean;
    /** Ticks until a splatted player may respawn (GDD 2.2: 5 s). */
    respawnTicks: number;
    /** Ticks of post-respawn protection left (GDD 2.2: 2 s, cancelled by firing). */
    invulnerableTicks: number;

    weaponId: WeaponId;
    ammo: number;
    reloadTicksRemaining: number;
    fireCooldownTicks: number;
}
