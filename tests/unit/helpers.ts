import {
    type PlayerInput,
    type PlayerState,
    NEON_TERMINAL,
    buildCollisionWorld,
    createPlayerState,
    sanitizeInput,
    stepPlayer
} from '@colorfront/shared';

export const world = buildCollisionWorld(NEON_TERMINAL);

export function playerAt(x: number, y: number, z: number, yaw = 0): PlayerState {
    const s = createPlayerState('p1', 'blue');
    s.position = { x, y, z };
    s.yaw = yaw;
    return s;
}

let seq = 0;

export function input(partial: Partial<PlayerInput> = {}): PlayerInput {
    return sanitizeInput({ moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0, ...partial, seq: ++seq });
}

/** Run `ticks` fixed ticks with the same input (buttons held). */
export function run(state: PlayerState, partial: Partial<PlayerInput>, ticks: number) {
    for (let i = 0; i < ticks; i++) stepPlayer(state, input(partial), world);
}

/** Let the player settle on the ground. */
export function settle(state: PlayerState, yaw = state.yaw) {
    run(state, { yaw }, 15);
}

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
