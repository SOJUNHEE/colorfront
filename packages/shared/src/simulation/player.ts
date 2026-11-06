import { PLAYER_MAX_HP, TICK_DT } from '../constants/simulation.ts';
import { type ShotTrace, traceShot } from '../combat/hitscan.ts';
import type { SpawnZone } from '../map/types.ts';
import type { PaintGrid } from '../paint/PaintGrid.ts';
import { paintSpeedMultiplier } from '../rules/paint.ts';
import { DEFAULT_WEAPON, WEAPONS, type WeaponStepResult, pelletOffsets, stepWeapon } from '../rules/weapons.ts';
import type { PlayerInput, PlayerState, TeamId } from '../types/player.ts';
import type { CollisionWorld } from './collision.ts';
import { type MovementStepResult, stepMovement } from './movement.ts';

export function createPlayerState(id: string, team: TeamId): PlayerState {
    const weapon = WEAPONS[DEFAULT_WEAPON];
    return {
        id,
        team,
        position: { x: 0, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        yaw: 0,
        pitch: 0,
        grounded: false,
        dashTicksRemaining: 0,
        dashCooldownTicks: 0,
        dashDirX: 0,
        dashDirZ: 0,
        lastButtons: 0,
        lastProcessedSeq: 0,
        hp: PLAYER_MAX_HP,
        alive: true,
        respawnTicks: 0,
        invulnerableTicks: 0,
        weaponId: weapon.id,
        nextWeaponId: null,
        ammo: weapon.magazineSize,
        reloadTicksRemaining: 0,
        fireCooldownTicks: 0
    };
}

/** Place a player on a spawn point and reset transient movement state. */
export function placeAtSpawn(state: PlayerState, zone: SpawnZone, pointIndex: number): void {
    const p = zone.points[((pointIndex % zone.points.length) + zone.points.length) % zone.points.length];
    state.position.x = p.x;
    state.position.y = p.y;
    state.position.z = p.z;
    state.velocity.x = 0;
    state.velocity.y = 0;
    state.velocity.z = 0;
    state.yaw = zone.yaw;
    state.pitch = 0;
    state.grounded = false;
    state.dashTicksRemaining = 0;
}

export interface PlayerStepResult {
    movement: MovementStepResult;
    weapon: WeaponStepResult;
    /** Hitscan of the first pellet fired this tick, if any (same as shots[0]). */
    shot: ShotTrace | null;
    /** Every pellet fired this tick (shotgun: several). */
    shots: ShotTrace[];
    /** Cells whose owner changed because of this tick's shot. */
    paintedCells: number;
}

/**
 * One full fixed tick for a player: weapon timing, paint-aware movement, then the shot from the
 * post-move position. Weapon runs first because both it and movement read `lastButtons` for edge
 * detection and stepMovement commits it. Without a `paint` grid, shots are traced but paint nothing.
 * `targets` are enemies the shot may hit; a shot that hits a player paints nothing.
 * Splatted players (`alive === false`) are handled by MatchSimulation and must not be stepped.
 */
export function stepPlayer(
    state: PlayerState,
    input: PlayerInput,
    world: CollisionWorld,
    paint?: PaintGrid,
    targets: readonly PlayerState[] = []
): PlayerStepResult {
    return stepPlayerCore(state, input, world, paint, targets, true);
}

/**
 * Client-side prediction of the local player (Phase 3): the same weapon timing and paint-aware
 * movement as `stepPlayer`, but the grid is only read, never painted. `targets` only shape the
 * visual trace; hits, damage and paint are decided by the server.
 */
export function predictPlayer(
    state: PlayerState,
    input: PlayerInput,
    world: CollisionWorld,
    paint: PaintGrid | undefined,
    targets: readonly PlayerState[] = []
): PlayerStepResult {
    return stepPlayerCore(state, input, world, paint, targets, false);
}

function stepPlayerCore(
    state: PlayerState,
    input: PlayerInput,
    world: CollisionWorld,
    paint: PaintGrid | undefined,
    targets: readonly PlayerState[],
    writePaint: boolean
): PlayerStepResult {
    const def = WEAPONS[state.weaponId];
    if (state.invulnerableTicks > 0) state.invulnerableTicks--;
    const weapon = stepWeapon(state, input, def);
    // GDD 2.2: respawn protection ends as soon as the player attacks.
    if (weapon.fired) state.invulnerableTicks = 0;
    const speedMultiplier = paint ? paintSpeedMultiplier(paint, state) : 1;
    const movement = stepMovement(state, input, world, TICK_DT, speedMultiplier);

    const shots: ShotTrace[] = [];
    let paintedCells = 0;
    if (weapon.fired) {
        for (const offset of pelletOffsets(def, input.seq)) {
            const shot = traceShot(world, state, def.range, targets, offset);
            shots.push(shot);
            if (writePaint && paint && shot.impact && shot.normal && !shot.hitPlayerId) {
                paintedCells += paint.paintSphere(shot.impact, def.paintRadius, state.team, shot.normal);
            }
        }
    }
    return { movement, weapon, shot: shots[0] ?? null, shots, paintedCells };
}
