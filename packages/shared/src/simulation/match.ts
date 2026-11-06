import type { MapDefinition, SpawnZone } from '../map/types.ts';
import { PaintGrid } from '../paint/PaintGrid.ts';
import { applyDamage, inOwnSpawnZone, isVulnerable, revive } from '../rules/combat.ts';
import { WEAPONS, equipWeapon, isWeaponId } from '../rules/weapons.ts';
import type { WeaponId } from '../types/weapon.ts';
import type { ShotTrace } from '../combat/hitscan.ts';
import type { PlayerInput, PlayerState, TeamId } from '../types/player.ts';
import type { Vec3 } from '../types/math.ts';
import { type CollisionWorld, buildCollisionWorld } from './collision.ts';
import { createPlayerState, placeAtSpawn, stepPlayer } from './player.ts';
import type { MovementStepResult } from './movement.ts';

export type MatchEvent =
    | { type: 'shot'; playerId: string; team: TeamId; shot: ShotTrace; paintedCells: number }
    | { type: 'hit'; attackerId: string; targetId: string; damage: number; at: Vec3 }
    | { type: 'splat'; attackerId: string; targetId: string; team: TeamId; at: Vec3 }
    | { type: 'respawn'; playerId: string }
    | { type: 'move'; playerId: string; movement: MovementStepResult };

/**
 * Authoritative multi-player tick: every player's input, hits, splats and respawns, plus the
 * shared paint grid. Runs offline in the client today (local player + bots) and is meant to be
 * the Phase 3 server room's core. Players are processed in a stable order (join order).
 */
export class MatchSimulation {
    readonly world: CollisionWorld;
    readonly paint: PaintGrid;
    readonly players: PlayerState[] = [];
    readonly map: MapDefinition;
    tick = 0;
    /** Per-player round statistics (GDD 5.1 result screen). */
    readonly stats = new Map<string, { painted: number; kills: number; deaths: number }>();
    private spawnCursor: Record<TeamId, number> = { blue: 0, orange: 0 };

    constructor(map: MapDefinition, world?: CollisionWorld) {
        this.map = map;
        this.world = world ?? buildCollisionWorld(map);
        this.paint = new PaintGrid(this.world, map);
    }

    zoneOf(team: TeamId): SpawnZone {
        return this.map.spawnZones.find((z) => z.team === team)!;
    }

    addPlayer(id: string, team: TeamId): PlayerState {
        const p = createPlayerState(id, team);
        this.spawn(p);
        this.players.push(p);
        this.stats.set(id, { painted: 0, kills: 0, deaths: 0 });
        return p;
    }

    removePlayer(id: string) {
        const i = this.players.findIndex((p) => p.id === id);
        if (i >= 0) this.players.splice(i, 1);
        this.stats.delete(id);
    }

    /** Start a new round: clear paint and stats, revive everyone at their spawn. */
    resetRound() {
        this.paint.clear();
        this.spawnCursor = { blue: 0, orange: 0 };
        for (const p of this.players) {
            this.reviveWithLoadout(p);
            p.invulnerableTicks = 0;
            p.lastButtons = 0;
            this.spawn(p);
            this.stats.set(p.id, { painted: 0, kills: 0, deaths: 0 });
        }
    }

    /** Revive and equip the weapon queued while the player could not switch. */
    private reviveWithLoadout(p: PlayerState) {
        revive(p, WEAPONS[p.weaponId].magazineSize);
        if (p.nextWeaponId) equipWeapon(p, p.nextWeaponId);
    }

    /**
     * Weapon choice (validated). Switches immediately inside the own spawn zone; otherwise the
     * choice is queued and equipped at the next respawn (no mid-fight switching).
     */
    requestWeapon(id: string, weapon: unknown): 'now' | 'next' | 'invalid' {
        const p = this.get(id);
        if (!p || !isWeaponId(weapon)) return 'invalid';
        if (weapon === p.weaponId) {
            p.nextWeaponId = null;
            return 'now';
        }
        if (p.alive && inOwnSpawnZone(p, this.map.spawnZones)) {
            equipWeapon(p, weapon as WeaponId);
            return 'now';
        }
        p.nextWeaponId = weapon as WeaponId;
        return 'next';
    }

    get(id: string): PlayerState | undefined {
        return this.players.find((p) => p.id === id);
    }

    spawn(p: PlayerState) {
        placeAtSpawn(p, this.zoneOf(p.team), this.spawnCursor[p.team]++);
    }

    /** Advance one fixed tick. Missing inputs count as "no input". */
    step(inputs: ReadonlyMap<string, PlayerInput>): MatchEvent[] {
        this.tick++;
        const events: MatchEvent[] = [];
        // Players splatted this tick start their 5 s countdown on the next tick, whatever their
        // position in the processing order.
        const splattedNow = new Set<string>();
        for (const p of this.players) {
            if (!p.alive) {
                if (splattedNow.has(p.id)) continue;
                if (p.respawnTicks > 0) p.respawnTicks--;
                if (p.respawnTicks === 0) {
                    this.reviveWithLoadout(p);
                    this.spawn(p);
                    events.push({ type: 'respawn', playerId: p.id });
                }
                continue;
            }
            this.stepOne(p, inputs.get(p.id) ?? idleInput(p), events, splattedNow);
        }
        return events;
    }

    /**
     * Extra input steps within the current tick for the given players only (server catch-up after
     * a client's inputs arrived late in a burst). Does not advance the clock or respawn timers;
     * the server bounds how often a player may get one.
     */
    stepExtra(inputs: ReadonlyMap<string, PlayerInput>): MatchEvent[] {
        const events: MatchEvent[] = [];
        const splattedNow = new Set<string>();
        for (const p of this.players) {
            const input = inputs.get(p.id);
            if (input && p.alive) this.stepOne(p, input, events, splattedNow);
        }
        return events;
    }

    private stepOne(p: PlayerState, input: PlayerInput, events: MatchEvent[], splattedNow: Set<string>) {
        const targets = this.players.filter((o) => o.team !== p.team && isVulnerable(o, this.map.spawnZones));
        const r = stepPlayer(p, input, this.world, this.paint, targets);
        events.push({ type: 'move', playerId: p.id, movement: r.movement });
        if (r.movement.fellOut) this.spawn(p);
        if (!r.shots.length) return;
        const st = this.stats.get(p.id);
        if (st) st.painted += r.paintedCells;
        r.shots.forEach((shot, i) => {
            // paintedCells is reported once per trigger pull (on the first pellet).
            events.push({ type: 'shot', playerId: p.id, team: p.team, shot, paintedCells: i === 0 ? r.paintedCells : 0 });
            const targetId = shot.hitPlayerId;
            const target = targetId ? this.get(targetId) : undefined;
            // Later pellets of the same pull skip a target already splatted by an earlier one.
            if (!target || !target.alive || !shot.impact) return;
            const result = applyDamage(target, WEAPONS[p.weaponId].damage);
            events.push({ type: 'hit', attackerId: p.id, targetId: target.id, damage: result.damage, at: shot.impact });
            if (result.killed) {
                splattedNow.add(target.id);
                const ks = this.stats.get(p.id);
                const ds = this.stats.get(target.id);
                if (ks) ks.kills++;
                if (ds) ds.deaths++;
                events.push({ type: 'splat', attackerId: p.id, targetId: target.id, team: target.team, at: { ...target.position } });
            }
        });
    }
}

/** "No input": stand still, keep looking the same way, press nothing. */
const idleInput = (p: PlayerState): PlayerInput => ({ seq: p.lastProcessedSeq, moveX: 0, moveZ: 0, yaw: p.yaw, pitch: p.pitch, buttons: 0 });
