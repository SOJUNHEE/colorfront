import { InputButton, MOVEMENT, TICK_RATE, stepPlayer } from '@colorfront/shared';
import { describe, expect, it } from 'vitest';

import { input, playerAt, run, settle, world } from './helpers.ts';

const EAST = -Math.PI / 2; // forward = +X
const WEST = Math.PI / 2; // forward = -X
const NORTH = 0; // forward = -Z

describe('stepMovement', () => {
    it('settles onto the floor', () => {
        const s = playerAt(-20, 2, 0);
        settle(s);
        expect(s.position.y).toBe(0);
        expect(s.grounded).toBe(true);
    });

    it('reaches walk (6 m/s) and sprint (8 m/s) speed', () => {
        const s = playerAt(-60, 0, 0, EAST);
        settle(s);
        run(s, { yaw: EAST, moveZ: 1 }, 10);
        expect(s.velocity.x).toBeCloseTo(MOVEMENT.walkSpeed, 6);
        run(s, { yaw: EAST, moveZ: 1, buttons: InputButton.Sprint }, 10);
        expect(s.velocity.x).toBeCloseTo(MOVEMENT.sprintSpeed, 6);
    });

    it('aiming cancels sprint', () => {
        const s = playerAt(-50, 0, 0, EAST);
        settle(s);
        run(s, { yaw: EAST, moveZ: 1, buttons: InputButton.Sprint | InputButton.Aim }, 15);
        expect(s.velocity.x).toBeCloseTo(MOVEMENT.walkSpeed, 6);
    });

    it('diagonal input is not faster than straight input', () => {
        const s = playerAt(-50, 0, 0, EAST);
        settle(s);
        run(s, { yaw: EAST, moveZ: 1, moveX: 1 }, 15);
        expect(Math.hypot(s.velocity.x, s.velocity.z)).toBeCloseTo(MOVEMENT.walkSpeed, 6);
    });

    it('jumps on the press edge only, to roughly 1.3 m', () => {
        const s = playerAt(-50, 0, 0);
        settle(s);
        let apex = 0;
        for (let i = 0; i < 60; i++) {
            stepPlayer(s, input({ buttons: InputButton.Jump }), world);
            apex = Math.max(apex, s.position.y);
        }
        expect(apex).toBeGreaterThan(1.1);
        expect(apex).toBeLessThan(1.4);
        // Holding jump after landing must not jump again.
        expect(s.position.y).toBe(0);
        expect(s.grounded).toBe(true);
    });

    it('dashes exactly 4 m, then respects the 6 s cooldown', () => {
        const s = playerAt(-30, 0, 0, EAST);
        settle(s, EAST);
        const x0 = s.position.x;
        run(s, { yaw: EAST, buttons: InputButton.Dash }, MOVEMENT.dashTicks);
        expect(s.position.x - x0).toBeCloseTo(MOVEMENT.dashDistance, 6);
        // Cooldown is set on the dash tick and counts down on each following tick.
        expect(s.dashCooldownTicks).toBe(MOVEMENT.dashCooldownTicks - (MOVEMENT.dashTicks - 1));

        settle(s, EAST);
        const x1 = s.position.x;
        run(s, { yaw: EAST }, 1);
        run(s, { yaw: EAST, buttons: InputButton.Dash }, 1);
        run(s, { yaw: EAST }, 10);
        expect(Math.abs(s.position.x - x1)).toBeLessThan(0.01);

        run(s, { yaw: EAST }, 6 * TICK_RATE);
        expect(s.dashCooldownTicks).toBe(0);
    });

    it('stops at the boundary wall and slides along it', () => {
        const s = playerAt(-66, 0, 0, WEST);
        settle(s, WEST);
        run(s, { yaw: WEST, moveZ: 1, moveX: 1 }, 4 * TICK_RATE);
        expect(s.position.x).toBeCloseTo(-80 + 0.4, 3);
        // moveX=1 while facing west is a strafe toward -Z (north), so it keeps sliding.
        expect(s.position.z).toBeLessThan(-5);
    });

    it('cannot walk through a building', () => {
        // Warehouse west spans x[-54,-30], z[24,34]; walk south into it.
        const s = playerAt(-42, 0, 18, Math.PI);
        settle(s, Math.PI);
        run(s, { yaw: Math.PI, moveZ: 1 }, 3 * TICK_RATE);
        expect(s.position.z).toBeCloseTo(24 - 0.4, 3);
        expect(s.position.y).toBe(0);
    });

    it('steps onto low cover but not onto a container', () => {
        const s = playerAt(-50, 0, 0, EAST);
        settle(s, EAST);
        // Lane barricade is 1.4 m high: must block.
        run(s, { yaw: EAST, moveZ: 1 }, 3 * TICK_RATE);
        expect(s.position.x).toBeCloseTo(-46 - 0.4, 3);
    });

    it('walks up the spawn ramp onto the 7 m high ground', () => {
        const s = playerAt(-56, 0, -18, NORTH);
        settle(s, NORTH);
        run(s, { yaw: NORTH, moveZ: 1 }, 3 * TICK_RATE);
        expect(s.position.z).toBeLessThan(-33);
        expect(s.position.y).toBeCloseTo(7, 6);
        expect(s.grounded).toBe(true);
    });

    it('walks back down the ramp while staying grounded', () => {
        const s = playerAt(-56, 7, -36, Math.PI);
        settle(s, Math.PI);
        let airborneTicks = 0;
        for (let i = 0; i < 3 * TICK_RATE; i++) {
            stepPlayer(s, input({ yaw: Math.PI, moveZ: 1 }), world);
            if (!s.grounded) airborneTicks++;
        }
        expect(s.position.y).toBe(0);
        expect(airborneTicks).toBeLessThanOrEqual(1);
    });

    it('walks under the bridge and lands on top of it from above', () => {
        const under = playerAt(0, 0, -36, NORTH);
        settle(under, NORTH);
        run(under, { yaw: NORTH, moveZ: 1 }, 2 * TICK_RATE);
        expect(under.position.z).toBeLessThan(-46);
        expect(under.position.y).toBe(0);

        const above = playerAt(0, 10, -46);
        settle(above);
        run(above, {}, 30);
        expect(above.position.y).toBeCloseTo(7, 6);
    });

    it('bumps its head on the bridge underside', () => {
        const s = playerAt(0, 0, -46);
        settle(s);
        let maxY = 0;
        for (let i = 0; i < 40; i++) {
            stepPlayer(s, input({ buttons: InputButton.Jump }), world);
            maxY = Math.max(maxY, s.position.y);
        }
        // Underside is 6.4 m: a 1.3 m jump does not reach it, so it must behave like a normal jump.
        expect(maxY).toBeLessThan(1.4);
        expect(s.position.y).toBe(0);
    });

    it('is deterministic for the same input sequence', () => {
        const script = (i: number) => ({
            yaw: Math.sin(i * 0.05) * 3,
            moveZ: i % 40 < 30 ? 1 : -1,
            moveX: i % 17 < 8 ? 1 : 0,
            buttons: (i % 45 === 0 ? InputButton.Jump : 0) | (i % 200 === 10 ? InputButton.Dash : 0) | InputButton.Sprint
        });
        const a = playerAt(-70, 0, 0);
        const b = playerAt(-70, 0, 0);
        for (let i = 0; i < 900; i++) {
            stepPlayer(a, input(script(i)), world);
            stepPlayer(b, input(script(i)), world);
        }
        expect(b.position).toEqual(a.position);
        expect(b.velocity).toEqual(a.velocity);
    });
});
