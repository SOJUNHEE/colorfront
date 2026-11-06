import { TICK_RATE } from '../constants/simulation.ts';
import { InputButton, hasButton } from '../input/buttons.ts';
import type { PlayerInput, PlayerState } from '../types/player.ts';
import type { WeaponDefinition, WeaponId } from '../types/weapon.ts';

/**
 * Weapon balance (Phase 6). Every pellet is a server hitscan; the spread pattern is deterministic
 * (derived from the input sequence number) so client prediction and the server agree exactly.
 *
 *  rifle   — all-rounder           6/s × 14 dmg, 25 m
 *  shotgun — wide spray, close     1.4/s × 7 pellets × 9 dmg (63 max), 12 m, wide paint coverage
 *  smg     — very fast, short      12/s × 7 dmg, 16 m, small jitter
 *  sniper  — long, heavy, slow     0.9/s × 75 dmg, 55 m, strong aim zoom
 */
export const WEAPONS: Readonly<Record<WeaponId, WeaponDefinition>> = {
    'paint-rifle': {
        id: 'paint-rifle',
        displayName: 'Paint Rifle',
        label: '페인트 라이플',
        role: '균형형 · 중거리',
        fireRate: 6,
        paintRadius: 1.2,
        range: 25,
        damage: 14,
        pellets: 1,
        spreadRad: 0,
        magazineSize: 36,
        reloadSeconds: 1.8,
        aimZoom: 0.72
    },
    'splash-shotgun': {
        id: 'splash-shotgun',
        displayName: 'Splash Shotgun',
        label: '스플래시 샷건',
        role: '근거리 · 넓게 퍼지는 7발',
        fireRate: 1.4,
        paintRadius: 1.0,
        range: 12,
        damage: 9,
        pellets: 7,
        spreadRad: 0.16,
        magazineSize: 8,
        reloadSeconds: 2.2,
        aimZoom: 0.85
    },
    'spray-smg': {
        id: 'spray-smg',
        displayName: 'Spray SMG',
        label: '스프레이 SMG',
        role: '초고속 연사 · 근중거리',
        fireRate: 12,
        paintRadius: 0.8,
        range: 16,
        damage: 7,
        pellets: 1,
        spreadRad: 0.045,
        magazineSize: 50,
        reloadSeconds: 1.5,
        aimZoom: 0.8
    },
    'long-sniper': {
        id: 'long-sniper',
        displayName: 'Long Liner',
        label: '롱라이너 저격총',
        role: '장거리 · 한 발이 강함',
        fireRate: 0.9,
        paintRadius: 1.0,
        range: 55,
        damage: 75,
        pellets: 1,
        spreadRad: 0,
        magazineSize: 5,
        reloadSeconds: 2.4,
        aimZoom: 0.35
    }
};

/** Selectable weapons in key order (1–4). Append only (indices are used on the wire). */
export const PLAYABLE_WEAPONS: readonly WeaponId[] = ['paint-rifle', 'splash-shotgun', 'spray-smg', 'long-sniper'];

export const DEFAULT_WEAPON: WeaponId = 'paint-rifle';

export const isWeaponId = (id: unknown): id is WeaponId => typeof id === 'string' && (PLAYABLE_WEAPONS as readonly string[]).includes(id);

/** Shot interval rounded to whole simulation ticks (6/s -> 5 ticks exactly at 30 Hz). */
export const fireIntervalTicks = (def: WeaponDefinition): number => Math.max(1, Math.round(TICK_RATE / def.fireRate));

export const reloadTicks = (def: WeaponDefinition): number => Math.round(def.reloadSeconds * TICK_RATE);

export interface WeaponStepResult {
    fired: boolean;
    reloadStarted: boolean;
    reloadFinished: boolean;
}

/** Switch weapon: full magazine, no reload or cooldown in progress, nothing queued. */
export function equipWeapon(state: PlayerState, id: WeaponId): void {
    state.weaponId = id;
    state.ammo = WEAPONS[id].magazineSize;
    state.reloadTicksRemaining = 0;
    state.fireCooldownTicks = 0;
    state.nextWeaponId = null;
}

export type AimOffset = { yaw: number; pitch: number };

/**
 * Per-pellet aim offsets for a trigger pull. Deterministic: the pattern only depends on the
 * weapon and the input sequence number, so prediction and server produce identical pellets.
 *  - 1 pellet, no spread: dead centre.
 *  - 1 pellet with spread (SMG): golden-angle jitter inside the cone.
 *  - n pellets (shotgun): one centre pellet + alternating outer/inner ring, rotated per shot.
 */
export function pelletOffsets(def: WeaponDefinition, seq: number): AimOffset[] {
    const s = def.spreadRad;
    if (def.pellets <= 1) {
        if (s <= 0) return [{ yaw: 0, pitch: 0 }];
        const a = seq * 2.39996;
        const r = s * Math.sqrt((seq * 0.61803398875) % 1);
        return [{ yaw: Math.cos(a) * r, pitch: Math.sin(a) * r * 0.7 }];
    }
    const out: AimOffset[] = [{ yaw: 0, pitch: 0 }];
    const ring = def.pellets - 1;
    const rot = seq * 0.9;
    for (let i = 0; i < ring; i++) {
        const a = rot + (Math.PI * 2 * i) / ring;
        const r = s * (i % 2 === 0 ? 1 : 0.55);
        out.push({ yaw: Math.cos(a) * r, pitch: Math.sin(a) * r * 0.6 });
    }
    return out;
}

/**
 * Advance fire cooldown, ammo and reload for one tick (one trigger pull may fire several
 * pellets — see pelletOffsets; ammo counts trigger pulls).
 */
export function stepWeapon(state: PlayerState, input: PlayerInput, def: WeaponDefinition): WeaponStepResult {
    const result: WeaponStepResult = { fired: false, reloadStarted: false, reloadFinished: false };
    const magazine = def.magazineSize;
    if (!state.alive) return result;

    if (state.fireCooldownTicks > 0) state.fireCooldownTicks--;

    if (state.reloadTicksRemaining > 0) {
        state.reloadTicksRemaining--;
        if (state.reloadTicksRemaining === 0) {
            state.ammo = magazine;
            result.reloadFinished = true;
        }
        return result;
    }

    const pressed = input.buttons & ~state.lastButtons;
    const wantsReload = hasButton(pressed, InputButton.Reload) && state.ammo < magazine;
    const emptyTrigger = hasButton(input.buttons, InputButton.Fire) && state.ammo === 0;
    if ((wantsReload || emptyTrigger) && reloadTicks(def) > 0) {
        state.reloadTicksRemaining = reloadTicks(def);
        result.reloadStarted = true;
        return result;
    }

    if (hasButton(input.buttons, InputButton.Fire) && state.fireCooldownTicks === 0 && state.ammo > 0) {
        state.ammo--;
        state.fireCooldownTicks = fireIntervalTicks(def);
        result.fired = true;
    }
    return result;
}
