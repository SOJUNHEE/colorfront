import {
    AIM,
    COMBAT,
    InputButton,
    MatchSimulation,
    NEON_TERMINAL,
    PLAYER_MAX_HP,
    SimpleBot,
    WEAPONS,
    lookAt,
    rayVsPlayer,
    sanitizeInput,
    traceShot
} from '@colorfront/shared';
import type { PlayerInput } from '@colorfront/shared';
import { describe, expect, it } from 'vitest';

import { playerAt, world } from './helpers.ts';

const aimAt = (sim: MatchSimulation, fromId: string, toId: string, buttons = InputButton.Fire): PlayerInput => {
    const a = sim.get(fromId)!;
    const b = sim.get(toId)!;
    const look = lookAt({ x: a.position.x, y: a.position.y + AIM.pivotHeight, z: a.position.z }, { x: b.position.x, y: b.position.y + 1, z: b.position.z });
    return sanitizeInput({ seq: sim.tick + 1, moveX: 0, moveZ: 0, yaw: look.yaw, pitch: look.pitch, buttons });
};

function duel() {
    const sim = new MatchSimulation(NEON_TERMINAL, world);
    const blue = sim.addPlayer('b', 'blue');
    const orange = sim.addPlayer('o', 'orange');
    // Face each other across the open plaza, outside both spawns.
    Object.assign(blue.position, { x: -10, y: 0, z: 14 });
    Object.assign(orange.position, { x: 6, y: 0, z: 14 });
    return { sim, blue, orange };
}

describe('player hits', () => {
    it('intersects the vertical hit cylinder from the side and from above', () => {
        const t = playerAt(0, 0, 0);
        expect(rayVsPlayer({ x: -5, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 50, t)).toBeCloseTo(5 - 0.48, 6);
        expect(rayVsPlayer({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 50, t)).toBeCloseTo(5 - 1.65, 6);
        expect(rayVsPlayer({ x: -5, y: 3, z: 0 }, { x: 1, y: 0, z: 0 }, 50, t)).toBeNull();
        expect(rayVsPlayer({ x: -5, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 3, t)).toBeNull();
    });

    it('stops a shot at an enemy in front of a wall and paints nothing', () => {
        const shooter = playerAt(-30, 0, 2, -Math.PI / 2);
        const target = playerAt(-24, 0, 2.8);
        const shot = traceShot(world, shooter, 25, [target]);
        expect(shot.hitPlayerId).toBe(target.id);
        expect(shot.impact!.x).toBeLessThan(-24);
    });
});

describe('MatchSimulation', () => {
    it('applies 14 damage per rifle hit and splats after 8 hits, then respawns after 5 s', () => {
        const { sim, blue, orange } = duel();
        let hits = 0;
        let splatTick = -1;
        for (let t = 0; t < 120 && splatTick < 0; t++) {
            const events = sim.step(new Map([['b', aimAt(sim, 'b', 'o')]]));
            hits += events.filter((e) => e.type === 'hit').length;
            if (events.some((e) => e.type === 'splat')) splatTick = sim.tick;
        }
        expect(WEAPONS['paint-rifle'].damage).toBe(14);
        expect(hits).toBe(Math.ceil(PLAYER_MAX_HP / 14));
        expect(orange.alive).toBe(false);
        expect(blue.alive).toBe(true);

        let respawned = -1;
        for (let t = 0; t < COMBAT.respawnTicks + 5 && respawned < 0; t++) {
            if (sim.step(new Map()).some((e) => e.type === 'respawn')) respawned = sim.tick;
        }
        expect(respawned - splatTick).toBe(COMBAT.respawnTicks);
        expect(orange.alive).toBe(true);
        expect(orange.hp).toBe(PLAYER_MAX_HP);
        expect(orange.invulnerableTicks).toBe(COMBAT.invulnerableTicks);
        const zone = NEON_TERMINAL.spawnZones.find((z) => z.team === 'orange')!;
        expect(orange.position.x).toBeGreaterThan(zone.min.x);
    });

    it('never damages team mates, invulnerable players or players inside their own spawn', () => {
        const { sim, blue } = duel();
        const mate = sim.addPlayer('b2', 'blue');
        Object.assign(mate.position, { x: 0, y: 0, z: 14 });
        for (let t = 0; t < 30; t++) sim.step(new Map([['b', aimAt(sim, 'b', 'b2')]]));
        expect(mate.hp).toBe(PLAYER_MAX_HP);

        const enemy = sim.get('o')!;
        enemy.invulnerableTicks = 1000;
        for (let t = 0; t < 30; t++) sim.step(new Map([['b', aimAt(sim, 'b', 'o')]]));
        expect(enemy.hp).toBe(PLAYER_MAX_HP);

        enemy.invulnerableTicks = 0;
        Object.assign(enemy.position, { x: 60, y: 0, z: 0 }); // inside orange spawn
        Object.assign(blue.position, { x: 45, y: 0, z: 0 });
        for (let t = 0; t < 30; t++) sim.step(new Map([['b', aimAt(sim, 'b', 'o')]]));
        expect(enemy.hp).toBe(PLAYER_MAX_HP);
    });

    it('cancels respawn protection when the protected player fires', () => {
        const { sim, blue } = duel();
        blue.invulnerableTicks = 60;
        sim.step(new Map([['b', sanitizeInput({ seq: 1, yaw: 0, pitch: -0.3, buttons: InputButton.Fire })]]));
        expect(blue.invulnerableTicks).toBe(0);
    });

    it('runs 30 bots for one simulated minute with consistent paint and no invalid state', () => {
        const sim = new MatchSimulation(NEON_TERMINAL, world);
        const bots: SimpleBot[] = [];
        for (let i = 0; i < 30; i++) {
            const id = `bot${i}`;
            sim.addPlayer(id, i % 2 ? 'orange' : 'blue');
            bots.push(new SimpleBot(id, 1000 + i));
        }
        let shots = 0;
        let splats = 0;
        for (let t = 0; t < 60 * 30; t++) {
            const inputs = new Map<string, PlayerInput>();
            for (const b of bots) {
                const p = sim.get(b.id)!;
                if (p.alive) inputs.set(b.id, b.think(p, sim));
            }
            for (const e of sim.step(inputs)) {
                if (e.type === 'shot') shots++;
                if (e.type === 'splat') splats++;
            }
            for (const p of sim.players) {
                expect(Number.isFinite(p.position.x + p.position.y + p.position.z)).toBe(true);
                expect(p.hp).toBeGreaterThanOrEqual(0);
            }
        }
        const score = sim.paint.score();
        expect(sim.paint.recount()).toEqual(score);
        expect(shots).toBeGreaterThan(500);
        expect(score.blue).toBeGreaterThan(0);
        expect(score.orange).toBeGreaterThan(0);
        // Not asserted: a minimum number of splats (bot skill is not a requirement).
        expect(splats).toBeGreaterThanOrEqual(0);
    });
});
