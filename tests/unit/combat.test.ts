import {
    AIM,
    InputButton,
    MATCH_TIMING,
    MAX_RESULTS_REVEAL_SECONDS,
    MOVEMENT,
    NEON_TERMINAL,
    PAINT_SPEED,
    PaintGrid,
    PaintOwner,
    TICK_RATE,
    aimPivot,
    createMatchTiming,
    finalizeRound,
    resultsStageAt,
    stepPlayer,
    traceShot
} from '@colorfront/shared';
import { describe, expect, it } from 'vitest';

import { input, playerAt, world } from './helpers.ts';

const EAST = -Math.PI / 2;
const UP = { x: 0, y: 1, z: 0 };

describe('traceShot (hitscan)', () => {
    it('lands exactly on the floor point under the crosshair', () => {
        const s = playerAt(-28, 0, 0, EAST);
        s.pitch = -Math.atan(AIM.pivotHeight / 10);
        const shot = traceShot(world, s, 25);
        // Pivot is 0.8 m to the right (+Z when facing east); crosshair meets the floor 10 m ahead.
        expect(shot.aimPoint.x).toBeCloseTo(-18, 6);
        expect(shot.aimPoint.y).toBeCloseTo(0, 6);
        expect(shot.aimPoint.z).toBeCloseTo(0.8, 6);
        expect(shot.dropped).toBe(false);
        expect(shot.solidId).toBe('floor');
        expect(shot.impact!.x).toBeCloseTo(-18, 4);
        expect(shot.impact!.y).toBeCloseTo(0, 4);
        expect(shot.impact!.z).toBeCloseTo(0.8, 4);
        expect(shot.normal).toEqual(UP);
    });

    it('stops at the first obstacle within range', () => {
        const s = playerAt(-50, 0, 0, EAST);
        const shot = traceShot(world, s, 25);
        expect(shot.solidId).toBe('lane-barricade-w');
        expect(shot.impact!.x).toBeCloseTo(-46, 4);
        expect(shot.normal).toEqual({ x: -1, y: 0, z: 0 });
    });

    it('drops to the ground at the end of the 25 m range when nothing is hit', () => {
        const s = playerAt(-28, 0, 0, EAST);
        const shot = traceShot(world, s, 25);
        expect(shot.dropped).toBe(true);
        expect(shot.impact!.y).toBeCloseTo(0, 6);
        const travelled = Math.hypot(shot.impact!.x - shot.origin.x, shot.impact!.z - shot.origin.z);
        expect(travelled).toBeGreaterThan(24.9);
        expect(travelled).toBeLessThanOrEqual(25.0001);
    });

    it('pulls the aim pivot in when the right shoulder is against a wall', () => {
        // Against the west boundary (x=-80) inside the blue spawn.
        // Facing north (yaw 0): right is +X, away from the wall -> full shoulder offset.
        const free = aimPivot(world, { x: -79.6, y: 0, z: 0 }, 0);
        // Facing south (yaw π): right is -X, into the wall -> pulled in to keep the margin.
        const blocked = aimPivot(world, { x: -79.6, y: 0, z: 0 }, Math.PI);
        expect(free.x).toBeCloseTo(-79.6 + AIM.shoulderOffset, 6);
        expect(blocked.x).toBeCloseTo(-80 + AIM.wallMargin, 6);
    });
});

describe('stepPlayer with paint', () => {
    it('fires the rifle 6 times per second, consuming ammo and painting the floor', () => {
        const paint = new PaintGrid(world, NEON_TERMINAL);
        const s = playerAt(-28, 0, 0, EAST);
        const pitch = -Math.atan(AIM.pivotHeight / 10);
        let shots = 0;
        let painted = 0;
        for (let t = 0; t < TICK_RATE; t++) {
            const r = stepPlayer(s, input({ yaw: EAST, pitch, buttons: InputButton.Fire }), world, paint);
            if (r.shot) shots++;
            painted += r.paintedCells;
        }
        expect(shots).toBe(6);
        expect(s.ammo).toBe(30);
        expect(painted).toBeGreaterThan(0);
        expect(paint.blueCount).toBe(painted);
        expect(paint.ownerAt(-18, 0, 0.8)).toBe(PaintOwner.Blue);
    });
});

/** Paint a rectangle of floor in one colour. */
function paintFloor(paint: PaintGrid, team: 'blue' | 'orange', x0: number, x1: number, z0: number, z1: number) {
    for (let x = x0; x <= x1; x += 0.75) for (let z = z0; z <= z1; z += 0.75) paint.paintSphere({ x, y: 0, z }, 1.2, team, UP);
}

describe('paint speed modifiers', () => {
    const ground = (team: 'blue' | 'orange', painter: 'blue' | 'orange' | null, buttons = 0) => {
        const paint = new PaintGrid(world, NEON_TERMINAL);
        if (painter) paintFloor(paint, painter, -31, -14, -3, 3);
        const s = playerAt(-29, 0, 0, EAST);
        s.team = team;
        for (let i = 0; i < 15; i++) stepPlayer(s, input({ yaw: EAST }), world, paint);
        for (let i = 0; i < 12; i++) stepPlayer(s, input({ yaw: EAST, moveZ: 1, buttons }), world, paint);
        return { s, paint };
    };

    it('walks 1.15x on ally paint, 0.8x on enemy paint, 1x on bare floor', () => {
        expect(ground('blue', 'blue').s.velocity.x).toBeCloseTo(MOVEMENT.walkSpeed * PAINT_SPEED.ally, 6);
        expect(ground('orange', 'blue').s.velocity.x).toBeCloseTo(MOVEMENT.walkSpeed * PAINT_SPEED.enemy, 6);
        expect(ground('blue', null).s.velocity.x).toBeCloseTo(MOVEMENT.walkSpeed, 6);
    });

    it('applies the multiplier once to sprint (no stacking)', () => {
        expect(ground('blue', 'blue', InputButton.Sprint).s.velocity.x).toBeCloseTo(MOVEMENT.sprintSpeed * PAINT_SPEED.ally, 6);
        expect(ground('orange', 'blue', InputButton.Sprint).s.velocity.x).toBeCloseTo(MOVEMENT.sprintSpeed * PAINT_SPEED.enemy, 6);
    });

    it('does not apply in the air', () => {
        const { s, paint } = ground('blue', 'blue');
        stepPlayer(s, input({ yaw: EAST, moveZ: 1, buttons: InputButton.Jump }), world, paint);
        for (let i = 0; i < 8; i++) stepPlayer(s, input({ yaw: EAST, moveZ: 1 }), world, paint);
        expect(s.grounded).toBe(false);
        expect(s.velocity.x).toBeCloseTo(MOVEMENT.walkSpeed, 6);
    });

    it('keeps the dash at exactly 4 m on enemy and ally paint', () => {
        for (const team of ['orange', 'blue'] as const) {
            const paint = new PaintGrid(world, NEON_TERMINAL);
            paintFloor(paint, 'blue', -31, -14, -3, 3);
            const s = playerAt(-29, 0, 0, EAST);
            s.team = team;
            for (let i = 0; i < 15; i++) stepPlayer(s, input({ yaw: EAST }), world, paint);
            const x0 = s.position.x;
            for (let i = 0; i < MOVEMENT.dashTicks; i++) stepPlayer(s, input({ yaw: EAST, buttons: InputButton.Dash }), world, paint);
            expect(s.position.x - x0).toBeCloseTo(MOVEMENT.dashDistance, 6);
            // No post-dash slide either, whatever the paint underneath.
            for (let i = 0; i < 15; i++) stepPlayer(s, input({ yaw: EAST }), world, paint);
            expect(s.position.x - x0).toBeCloseTo(MOVEMENT.dashDistance, 6);
        }
    });
});

describe('round result (no JUDGING phase)', () => {
    it('decides the winner on raw cell counts; equal counts draw', () => {
        expect(finalizeRound({ paintable: 100, blue: 40, orange: 39, unpainted: 21 }).winner).toBe('blue');
        expect(finalizeRound({ paintable: 100, blue: 10, orange: 11, unpainted: 79 }).winner).toBe('orange');
        expect(finalizeRound({ paintable: 100, blue: 30, orange: 30, unpainted: 40 }).winner).toBe('draw');
        // 0.4 % vs 0.5 % both round to 0 % — still decided by counts.
        expect(finalizeRound({ paintable: 55_192, blue: 221, orange: 220, unpainted: 54_751 }).winner).toBe('blue');
    });

    it('splits RESULTS into a configurable reveal then the summary', () => {
        expect(resultsStageAt(0)).toBe('reveal');
        expect(resultsStageAt(MATCH_TIMING.resultsRevealSeconds)).toBe('summary');
        expect(resultsStageAt(MATCH_TIMING.resultsRevealSeconds + MATCH_TIMING.resultsSummarySeconds)).toBe('done');
        const instant = createMatchTiming({ resultsRevealSeconds: 0 });
        expect(resultsStageAt(0, instant)).toBe('summary');
        expect(createMatchTiming({ resultsRevealSeconds: 120 }).resultsRevealSeconds).toBe(MAX_RESULTS_REVEAL_SECONDS);
        expect(createMatchTiming({ resultsRevealSeconds: -3 }).resultsRevealSeconds).toBe(0);
    });
});
