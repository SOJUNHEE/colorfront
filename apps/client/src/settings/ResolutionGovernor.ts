/**
 * Phase 6 Gate 6 — automatic render-scale fallback ("자동 해상도").
 *
 * Watches real frame times and lowers the internal render resolution in steps when the game
 * cannot hold ~60 fps, then raises it again once there is clear headroom. It only multiplies the
 * player's chosen render scale; the quality preset (shadows, effects) is never changed behind the
 * player's back.
 *
 * Decisions are made on windows of frames (not single spikes):
 *  - step DOWN when more than `slowShare` of the frames in the last `window` seconds took longer
 *    than `slowMs` (default: 20 % over 20 ms);
 *  - step UP when none of the frames in the last `recoverWindow` seconds took longer than
 *    `fastMs`; a step down shortly after a step up blocks further up-steps for `cooldown` seconds
 *    (no oscillation).
 */
export type GovernorOptions = {
    steps: readonly number[];
    window: number;
    slowMs: number;
    slowShare: number;
    recoverWindow: number;
    fastMs: number;
    cooldown: number;
};

export const DEFAULT_GOVERNOR: GovernorOptions = {
    steps: [1, 0.85, 0.72],
    window: 2,
    slowMs: 20,
    slowShare: 0.2,
    recoverWindow: 6,
    fastMs: 15,
    cooldown: 30
};

export class ResolutionGovernor {
    private readonly o: GovernorOptions;
    private step = 0;
    private frames: number[] = [];
    private elapsed = 0;
    private sinceUp = Infinity;
    private blockedFor = 0;
    enabled = true;

    constructor(options: Partial<GovernorOptions> = {}) {
        this.o = { ...DEFAULT_GOVERNOR, ...options };
    }

    /** Current multiplier for the render scale. */
    get scale() {
        return this.enabled ? this.o.steps[this.step] : 1;
    }

    reset() {
        this.step = 0;
        this.frames = [];
        this.elapsed = 0;
        this.sinceUp = Infinity;
        this.blockedFor = 0;
    }

    /**
     * Feed one frame's duration (seconds). Returns true when the scale changed. Frames longer than
     * 0.25 s (tab switches, loading) are ignored.
     */
    sample(dt: number): boolean {
        if (!this.enabled || dt <= 0 || dt > 0.25) return false;
        this.frames.push(dt);
        this.elapsed += dt;
        this.sinceUp += dt;
        this.blockedFor = Math.max(0, this.blockedFor - dt);
        // Keep the longer of the two windows.
        const keep = Math.max(this.o.window, this.o.recoverWindow);
        let total = this.frames.reduce((a, b) => a + b, 0);
        while (this.frames.length && total - this.frames[0] >= keep) total -= this.frames.shift()!;

        const recent = this.lastSeconds(this.o.window);
        if (this.elapsed >= this.o.window && recent.length > 10) {
            const slow = recent.filter((f) => f * 1000 > this.o.slowMs).length / recent.length;
            if (slow > this.o.slowShare && this.step < this.o.steps.length - 1) {
                this.step++;
                if (this.sinceUp < this.o.window * 3) this.blockedFor = this.o.cooldown;
                this.restart();
                return true;
            }
        }
        if (this.step > 0 && this.blockedFor === 0 && this.elapsed >= this.o.recoverWindow) {
            const all = this.lastSeconds(this.o.recoverWindow);
            if (all.every((f) => f * 1000 <= this.o.fastMs)) {
                this.step--;
                this.sinceUp = 0;
                this.restart();
                return true;
            }
        }
        return false;
    }

    private restart() {
        // Judge the new resolution on fresh frames only.
        this.frames = [];
        this.elapsed = 0;
    }

    private lastSeconds(sec: number): number[] {
        const out: number[] = [];
        let t = 0;
        for (let i = this.frames.length - 1; i >= 0 && t < sec; i--) {
            out.push(this.frames[i]);
            t += this.frames[i];
        }
        return out;
    }
}
