import { TICK_RATE } from '../constants/simulation.ts';
import { InputButton, hasButton } from '../input/buttons.ts';
import type { PlayerInput, PlayerState } from '../types/player.ts';
import type { WeaponDefinition, WeaponId } from '../types/weapon.ts';

/** GDD 4.2 balance draft. null fields are not specified in the GDD yet. */
export const WEAPONS: Readonly<Record<WeaponId, WeaponDefinition>> = {
    'paint-rifle': {
        id: 'paint-rifle',
        displayName: 'Paint Rifle',
        fireRate: 6,
        paintRadius: 1.2,
        range: 25,
        damage: 14,
        magazineSize: 36,
        reloadSeconds: 1.8,
        continuous: false,
        availability: 'mvp'
    },
    'splash-shotgun': {
        id: 'splash-shotgun',
        displayName: 'Splash Shotgun',
        fireRate: 1.2,
        paintRadius: 1.8,
        range: 12,
        damage: 40,
        magazineSize: 8,
        reloadSeconds: 2.5,
        continuous: false,
        availability: 'later'
    },
    'charge-cannon': {
        id: 'charge-cannon',
        displayName: 'Charge Cannon',
        fireRate: 0.8,
        paintRadius: 0.7,
        range: 45,
        damage: 50,
        magazineSize: 7,
        reloadSeconds: null,
        continuous: false,
        availability: 'later'
    },
    'paint-roller': {
        id: 'paint-roller',
        displayName: 'Paint Roller',
        fireRate: null,
        paintRadius: 1,
        range: 2,
        damage: null,
        magazineSize: null,
        reloadSeconds: null,
        continuous: true,
        availability: 'later'
    }
};

export const DEFAULT_WEAPON: WeaponId = 'paint-rifle';

/** Shot interval rounded to whole simulation ticks (6/s -> 5 ticks exactly at 30 Hz). */
export const fireIntervalTicks = (def: WeaponDefinition): number =>
    def.fireRate ? Math.max(1, Math.round(TICK_RATE / def.fireRate)) : 1;

export const reloadTicks = (def: WeaponDefinition): number =>
    def.reloadSeconds === null ? 0 : Math.round(def.reloadSeconds * TICK_RATE);

export interface WeaponStepResult {
    fired: boolean;
    reloadStarted: boolean;
    reloadFinished: boolean;
}

/**
 * Advance fire cooldown, ammo and reload for one tick. Phase 1 only uses this to drive the
 * mock ammo HUD — there is no projectile, hit or paint resolution yet (Phase 2).
 */
export function stepWeapon(state: PlayerState, input: PlayerInput, def: WeaponDefinition): WeaponStepResult {
    const result: WeaponStepResult = { fired: false, reloadStarted: false, reloadFinished: false };
    const magazine = def.magazineSize;
    if (magazine === null || !state.alive) return result;

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
