import { PLAYER_MAX_HP, RESPAWN, TICK_RATE } from '../constants/simulation.ts';
import type { SpawnZone } from '../map/types.ts';
import type { PlayerState } from '../types/player.ts';

/** GDD 2.2 timings in ticks. */
export const COMBAT = {
    respawnTicks: Math.round(RESPAWN.delaySeconds * TICK_RATE),
    invulnerableTicks: Math.round(RESPAWN.invulnerableSeconds * TICK_RATE)
} as const;

/** True inside the player's own team spawn zone (weapon switching, protection). */
export function inOwnSpawnZone(p: PlayerState, zones: readonly SpawnZone[]): boolean {
    return zones.some((z) => z.team === p.team && inZone(p, z));
}

const inZone = (p: PlayerState, z: SpawnZone) =>
    p.position.x > z.min.x && p.position.x < z.max.x && p.position.z > z.min.z && p.position.z < z.max.z;

/**
 * Whether `target` can take damage now: alive, past respawn protection, and not inside its own
 * team's spawn zone (GDD 2.2: no hits in the base protection area).
 */
export function isVulnerable(target: PlayerState, spawnZones: readonly SpawnZone[]): boolean {
    if (!target.alive || target.invulnerableTicks > 0) return false;
    return !spawnZones.some((z) => z.team === target.team && inZone(target, z));
}

export interface DamageResult {
    damage: number;
    killed: boolean;
}

/** Apply weapon damage. Friendly fire is never applied (GDD 2.2); callers pass enemies only. */
export function applyDamage(target: PlayerState, damage: number): DamageResult {
    const dealt = Math.min(target.hp, Math.max(0, damage));
    target.hp -= dealt;
    if (target.hp <= 0) {
        target.hp = 0;
        target.alive = false;
        target.respawnTicks = COMBAT.respawnTicks;
        target.velocity.x = target.velocity.y = target.velocity.z = 0;
        target.reloadTicksRemaining = 0;
        return { damage: dealt, killed: true };
    }
    return { damage: dealt, killed: false };
}

/** Bring a splatted player back with full HP, a full magazine and spawn protection. */
export function revive(target: PlayerState, magazine: number): void {
    target.alive = true;
    target.hp = PLAYER_MAX_HP;
    target.ammo = magazine;
    target.reloadTicksRemaining = 0;
    target.fireCooldownTicks = 0;
    target.dashCooldownTicks = 0;
    target.respawnTicks = 0;
    target.invulnerableTicks = COMBAT.invulnerableTicks;
}
