/**
 * Simulation constants shared by client prediction and the (future) authoritative server.
 * Numbers marked "GDD" come from COLORFRONT_GDD_v1.md; the rest are Phase 1 tuning guesses
 * that must be confirmed by play-testing.
 */

/** GDD 7.3: fixed 30 Hz simulation. */
export const TICK_RATE = 30;
export const TICK_DT = 1 / TICK_RATE;

/** GDD 3.1: 160 m x 120 m outer footprint, centred on the origin. */
export const ARENA = {
    width: 160,
    depth: 120,
    minX: -80,
    maxX: 80,
    minZ: -60,
    maxZ: 60
} as const;

/** GDD 2.1 / 7.1 */
export const MAX_PLAYERS_PER_ROOM = 30;
export const TEAM_SIZE = 15;

/** Server hit capsule approximated as a vertical cylinder (GDD 4.1: ~1.65 m character). */
export const PLAYER_SHAPE = {
    radius: 0.4,
    height: 1.65,
    eyeHeight: 1.45
} as const;

export const MOVEMENT = {
    /** GDD 2.2 */
    walkSpeed: 6,
    /** GDD 2.2 */
    sprintSpeed: 8,
    groundAcceleration: 60,
    airAcceleration: 14,
    gravity: 25,
    /** ~1.3 m jump apex. GDD only says "기본 점프". */
    jumpSpeed: 8,
    maxFallSpeed: 50,
    /** GDD 2.2: 4 m dash. Duration is not in the GDD: 5 ticks (~0.17 s). */
    dashDistance: 4,
    dashTicks: 5,
    /** GDD 2.2: 6 s cooldown, stored in ticks to stay integer/deterministic. */
    dashCooldownTicks: 6 * TICK_RATE,
    stepHeight: 0.4,
    groundSnapDistance: 0.35,
    /** Largest horizontal move per collision sub-step (must stay below PLAYER_SHAPE.radius). */
    maxSubstepDistance: 0.2,
    /** Anything below this is treated as out of the world. */
    killY: -30
} as const;

export const DASH_SPEED = MOVEMENT.dashDistance / (MOVEMENT.dashTicks * TICK_DT);

/** GDD 2.2: respawn timings (used from Phase 2). */
export const RESPAWN = {
    delaySeconds: 5,
    invulnerableSeconds: 2
} as const;

export const PLAYER_MAX_HP = 100;
