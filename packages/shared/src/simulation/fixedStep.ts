/**
 * Accumulator that turns variable frame times into a whole number of fixed ticks and returns
 * the interpolation factor for rendering between the last two simulated states.
 */
export class FixedStepper {
    private accumulator = 0;

    /** Total ticks simulated so far. */
    tick = 0;

    readonly step: number;

    /** Upper bound on ticks per advance() so a long stall cannot freeze the page (spiral of death). */
    readonly maxStepsPerAdvance: number;

    constructor(step: number, maxStepsPerAdvance = 8) {
        this.step = step;
        this.maxStepsPerAdvance = maxStepsPerAdvance;
    }

    /**
     * @param frameDt Seconds since the previous frame.
     * @param onTick Called once per fixed tick, in order.
     * @returns Interpolation alpha in [0, 1).
     */
    advance(frameDt: number, onTick: (tick: number) => void): number {
        if (!(frameDt > 0)) return this.accumulator / this.step;
        this.accumulator += frameDt;
        let steps = 0;
        while (this.accumulator >= this.step) {
            if (steps === this.maxStepsPerAdvance) {
                // Drop the backlog instead of trying to catch up.
                this.accumulator = 0;
                break;
            }
            this.accumulator -= this.step;
            this.tick++;
            steps++;
            onTick(this.tick);
        }
        return this.accumulator / this.step;
    }
}
