import type { PlayerInput } from '../types/player.ts';

/** Bit flags packed into PlayerInput.buttons. */
export const InputButton = {
    Jump: 1 << 0,
    Sprint: 1 << 1,
    Dash: 1 << 2,
    Fire: 1 << 3,
    Aim: 1 << 4,
    Reload: 1 << 5
} as const;
export type InputButton = (typeof InputButton)[keyof typeof InputButton];

export const INPUT_BUTTON_MASK = Object.values(InputButton).reduce((mask, bit) => mask | bit, 0);

export const PITCH_LIMIT = (85 * Math.PI) / 180;

export const hasButton = (buttons: number, button: InputButton): boolean => (buttons & button) !== 0;

const finiteOr = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const clamp = (v: number, min: number, max: number) => (v < min ? min : v > max ? max : v);

const wrapAngle = (a: number): number => {
    const twoPi = Math.PI * 2;
    a %= twoPi;
    if (a > Math.PI) a -= twoPi;
    else if (a < -Math.PI) a += twoPi;
    return a;
};

/**
 * Clamp an untrusted input into the valid range. The server must run this on every message;
 * the client runs it too so prediction sees exactly what the server will see.
 */
export function sanitizeInput(raw: Partial<PlayerInput>): PlayerInput {
    let moveX = clamp(finiteOr(raw.moveX, 0), -1, 1);
    let moveZ = clamp(finiteOr(raw.moveZ, 0), -1, 1);
    const lenSq = moveX * moveX + moveZ * moveZ;
    if (lenSq > 1) {
        const len = Math.sqrt(lenSq);
        moveX /= len;
        moveZ /= len;
    }
    const seq = finiteOr(raw.seq, 0);
    return {
        seq: seq >= 0 ? Math.floor(seq) : 0,
        moveX,
        moveZ,
        yaw: wrapAngle(finiteOr(raw.yaw, 0)),
        pitch: clamp(finiteOr(raw.pitch, 0), -PITCH_LIMIT, PITCH_LIMIT),
        buttons: Math.floor(finiteOr(raw.buttons, 0)) & INPUT_BUTTON_MASK
    };
}
