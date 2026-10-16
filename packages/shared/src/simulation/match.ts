import type { MapDefinition, SpawnZone } from '../map/types.ts';
import { PaintGrid } from '../paint/PaintGrid.ts';
import { applyDamage, isVulnerable, revive } from '../rules/combat.ts';
import { WEAPONS } from '../rules/weapons.ts';
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
        return p;
    }

    removePlayer(id: string) {
        const i = this.players.findIndex((p) => p.id === id);
        if (i >= 0) this.players.splice(i, 1);
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
                    revive(p, WEAPONS[p.weaponId].magazineSize ?? 0);
                    this.spawn(p);
                    events.push({ type: 'respawn', playerId: p.id });
                }
                continue;
            }
            const input = inputs.get(p.id) ?? { seq: p.lastProcessedSeq, moveX: 0, moveZ: 0, yaw: p.yaw, pitch: p.pitch, buttons: 0 };
            const targets = this.players.filter((o) => o.team !== p.team && isVulnerable(o, this.map.spawnZones));
            const r = stepPlayer(p, input, this.world, this.paint, targets);
            events.push({ type: 'move', playerId: p.id, movement: r.movement });
            if (r.movement.fellOut) this.spawn(p);
            if (!r.shot) continue;
            events.push({ type: 'shot', playerId: p.id, team: p.team, shot: r.shot, paintedCells: r.paintedCells });
            const targetId = r.shot.hitPlayerId;
            const target = targetId ? this.get(targetId) : undefined;
            if (target && r.shot.impact) {
                const result = applyDamage(target, WEAPONS[p.weaponId].damage ?? 0);
                events.push({ type: 'hit', attackerId: p.id, targetId: target.id, damage: result.damage, at: r.shot.impact });
                if (result.killed) {
                    splattedNow.add(target.id);
                    events.push({ type: 'splat', attackerId: p.id, targetId: target.id, team: target.team, at: { ...target.position } });
                }
            }
        }
        return events;
    }
}
