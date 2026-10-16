import {
    FixedStepper,
    INPUT_BUTTON_MASK,
    InputButton,
    PITCH_LIMIT,
    WEAPONS,
    canTransition,
    createPlayerState,
    fireIntervalTicks,
    sanitizeInput,
    stepWeapon
} from '@colorfront/shared';
import { describe, expect, it } from 'vitest';

describe('sanitizeInput', () => {
    it('replaces non-finite values and clamps ranges', () => {
        const i = sanitizeInput({ seq: -4, moveX: NaN, moveZ: 50, yaw: Infinity, pitch: 10, buttons: 0xffff });
        expect(i).toEqual({ seq: 0, moveX: 0, moveZ: 1, yaw: 0, pitch: PITCH_LIMIT, buttons: INPUT_BUTTON_MASK });
    });

    it('normalises diagonal movement and wraps yaw', () => {
        const i = sanitizeInput({ moveX: 1, moveZ: 1, yaw: 3 * Math.PI });
        expect(Math.hypot(i.moveX, i.moveZ)).toBeCloseTo(1);
        expect(Math.abs(i.yaw)).toBeCloseTo(Math.PI);
    });

    it('accepts garbage types without throwing', () => {
        const i = sanitizeInput({ moveX: '1' as unknown as number, buttons: {} as unknown as number });
        expect(i.moveX).toBe(0);
        expect(i.buttons).toBe(0);
    });
});

describe('paint rifle (mock ammo)', () => {
    const rifle = WEAPONS['paint-rifle'];
    const fire = (buttons: number, seq: number) => ({ seq, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons });

    it('fires 6 shots per second (5 ticks at 30 Hz)', () => {
        expect(fireIntervalTicks(rifle)).toBe(5);
        const s = createPlayerState('p', 'blue');
        let shots = 0;
        for (let t = 0; t < 30; t++) {
            if (stepWeapon(s, fire(InputButton.Fire, t), rifle).fired) shots++;
            s.lastButtons = InputButton.Fire;
        }
        expect(shots).toBe(6);
        expect(s.ammo).toBe(30);
    });

    it('auto-reloads when empty and refills after 1.8 s', () => {
        const s = createPlayerState('p', 'blue');
        s.ammo = 0;
        expect(stepWeapon(s, fire(InputButton.Fire, 1), rifle).reloadStarted).toBe(true);
        expect(s.reloadTicksRemaining).toBe(54);
        for (let t = 0; t < 53; t++) stepWeapon(s, fire(0, t), rifle);
        expect(s.ammo).toBe(0);
        expect(stepWeapon(s, fire(0, 99), rifle).reloadFinished).toBe(true);
        expect(s.ammo).toBe(36);
    });

    it('ignores reload with a full magazine and reloads on the R press edge', () => {
        const s = createPlayerState('p', 'blue');
        expect(stepWeapon(s, fire(InputButton.Reload, 1), rifle).reloadStarted).toBe(false);
        s.ammo = 10;
        s.lastButtons = InputButton.Reload; // held, not pressed
        expect(stepWeapon(s, fire(InputButton.Reload, 2), rifle).reloadStarted).toBe(false);
        s.lastButtons = 0;
        expect(stepWeapon(s, fire(InputButton.Reload, 3), rifle).reloadStarted).toBe(true);
    });
});

describe('match phases', () => {
    it('only allows GDD transitions', () => {
        expect(canTransition('WAITING', 'COUNTDOWN')).toBe(true);
        expect(canTransition('PLAYING', 'WAITING')).toBe(false);
        expect(canTransition('RESULTS', 'PLAYING')).toBe(false);
        expect(canTransition('CLOSED', 'WAITING')).toBe(false);
    });
});

describe('FixedStepper', () => {
    it('runs whole ticks and carries the remainder', () => {
        const stepper = new FixedStepper(1 / 30);
        const ticks: number[] = [];
        const alpha = stepper.advance(0.05, (t) => ticks.push(t));
        expect(ticks).toEqual([1]);
        expect(alpha).toBeCloseTo(0.5);
        stepper.advance(0.05, (t) => ticks.push(t));
        expect(ticks).toEqual([1, 2, 3]);
    });

    it('caps catch-up after a long stall', () => {
        const stepper = new FixedStepper(1 / 30, 8);
        let n = 0;
        stepper.advance(5, () => n++);
        expect(n).toBe(8);
        stepper.advance(1 / 30, () => n++);
        expect(n).toBe(9);
    });

    it('ignores zero, negative and NaN frame times', () => {
        const stepper = new FixedStepper(1 / 30);
        let n = 0;
        for (const dt of [0, -1, NaN]) stepper.advance(dt, () => n++);
        expect(n).toBe(0);
    });
});
