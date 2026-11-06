import { describe, expect, it } from 'vitest';

import { ResolutionGovernor } from '../../apps/client/src/settings/ResolutionGovernor.ts';

const feed = (g: ResolutionGovernor, seconds: number, ms: number) => {
    let changed = 0;
    for (let t = 0; t < seconds; t += ms / 1000) if (g.sample(ms / 1000)) changed++;
    return changed;
};

describe('ResolutionGovernor (Gate 6 automatic render scale)', () => {
    it('keeps full resolution while frames are on budget', () => {
        const g = new ResolutionGovernor();
        feed(g, 20, 16.7);
        expect(g.scale).toBe(1);
    });

    it('ignores isolated spikes', () => {
        const g = new ResolutionGovernor();
        for (let i = 0; i < 20; i++) {
            feed(g, 1, 16.7);
            g.sample(0.08);
        }
        expect(g.scale).toBe(1);
    });

    it('steps down under sustained load, one step per window, down to the floor', () => {
        const g = new ResolutionGovernor();
        feed(g, 2.5, 33);
        expect(g.scale).toBe(0.85);
        feed(g, 2.5, 33);
        expect(g.scale).toBe(0.72);
        feed(g, 10, 33);
        expect(g.scale).toBe(0.72);
    });

    it('recovers when there is clear headroom, and does not oscillate', () => {
        const g = new ResolutionGovernor();
        feed(g, 2.5, 33);
        expect(g.scale).toBe(0.85);
        feed(g, 7, 10);
        expect(g.scale).toBe(1);
        // Too slow again right after recovering: step down and block up-steps for the cooldown.
        feed(g, 1.2, 33);
        expect(g.scale).toBe(0.85);
        feed(g, 20, 10);
        expect(g.scale).toBe(0.85);
        feed(g, 20, 10);
        expect(g.scale).toBe(1);
    });

    it('ignores long stalls (tab switch, loading) and can be disabled', () => {
        const g = new ResolutionGovernor();
        for (let i = 0; i < 50; i++) g.sample(0.5);
        expect(g.scale).toBe(1);
        g.enabled = false;
        feed(g, 10, 40);
        expect(g.scale).toBe(1);
    });
});
