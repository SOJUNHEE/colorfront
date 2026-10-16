import {
    InputButton,
    MOVEMENT,
    NEON_TERMINAL,
    PLAYER_SHAPE,
    TICK_RATE,
    createPlayerState,
    cylinderOverlapsSolid,
    placeAtSpawn,
    sanitizeInput,
    stepPlayer
} from '@colorfront/shared';
import { describe, expect, it } from 'vitest';

import { rng, world } from './helpers.ts';

/**
 * Phase 1 gate proxy: "5 minutes of offline movement without collision problems". This drives
 * the shared simulation with random inputs for 5 simulated minutes. It is NOT a substitute for a
 * human play-test in the browser.
 */
describe('5-minute random movement soak', () => {
    const FIVE_MINUTES = 5 * 60 * TICK_RATE;

    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
        it(`seed ${seed}: never embeds in geometry, leaves the arena or produces NaN`, () => {
            const random = rng(seed);
            const s = createPlayerState('soak', seed % 2 ? 'blue' : 'orange');
            placeAtSpawn(s, NEON_TERMINAL.spawnZones[seed % 2], seed);
            let yaw = s.yaw;
            let held = { moveX: 0, moveZ: 1, buttons: 0 };
            let maxY = 0;

            for (let t = 0; t < FIVE_MINUTES; t++) {
                if (t % 20 === 0) {
                    held = {
                        moveX: random() * 2 - 1,
                        moveZ: random() < 0.8 ? 1 : random() * 2 - 1,
                        buttons: (random() < 0.5 ? InputButton.Sprint : 0) | (random() < 0.1 ? InputButton.Aim : 0)
                    };
                }
                yaw += (random() - 0.5) * 0.3;
                let buttons = held.buttons;
                if (random() < 0.04) buttons |= InputButton.Jump;
                if (random() < 0.01) buttons |= InputButton.Dash;

                const result = stepPlayer(s, sanitizeInput({ seq: t + 1, yaw, pitch: 0, ...held, buttons }), world);
                const p = s.position;

                expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
                expect(result.movement.fellOut).toBe(false);
                expect(p.x).toBeGreaterThanOrEqual(NEON_TERMINAL.bounds.minX);
                expect(p.x).toBeLessThanOrEqual(NEON_TERMINAL.bounds.maxX);
                expect(p.z).toBeGreaterThanOrEqual(NEON_TERMINAL.bounds.minZ);
                expect(p.z).toBeLessThanOrEqual(NEON_TERMINAL.bounds.maxZ);
                // Overlap within the step height is allowed (rim of a ledge); deeper is a bug.
                const embedded = cylinderOverlapsSolid(
                    world,
                    { x: p.x, y: p.y + MOVEMENT.stepHeight, z: p.z },
                    PLAYER_SHAPE.radius,
                    PLAYER_SHAPE.height - MOVEMENT.stepHeight,
                    0.01
                );
                if (embedded) throw new Error(`tick ${t}: embedded in ${embedded.source.id} at ${JSON.stringify(p)}`);
                maxY = Math.max(maxY, p.y);
            }
            expect(maxY).toBeGreaterThan(0);
        });
    }
});
