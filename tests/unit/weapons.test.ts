import {
    InputButton,
    MatchSimulation,
    NEON_TERMINAL,
    PLAYABLE_WEAPONS,
    PaintGrid,
    WEAPONS,
    equipWeapon,
    fireIntervalTicks,
    isWeaponId,
    pelletOffsets,
    predictPlayer,
    stepPlayer
} from '@colorfront/shared';
import type { PlayerInput } from '@colorfront/shared';
import { describe, expect, it } from 'vitest';

import { input, playerAt, settle, world } from './helpers.ts';

const EAST = -Math.PI / 2;
const FIRE = InputButton.Fire;

describe('weapons (Phase 6): pellets, spread, rates', () => {
    it('defines four playable weapons with distinct roles', () => {
        expect(PLAYABLE_WEAPONS).toEqual(['paint-rifle', 'splash-shotgun', 'spray-smg', 'long-sniper']);
        const w = PLAYABLE_WEAPONS.map((id) => WEAPONS[id]);
        // shotgun: most pellets and widest cone; smg: fastest; sniper: longest and hardest hitting.
        expect(Math.max(...w.map((x) => x.pellets))).toBe(WEAPONS['splash-shotgun'].pellets);
        expect(Math.max(...w.map((x) => x.spreadRad))).toBe(WEAPONS['splash-shotgun'].spreadRad);
        expect(Math.max(...w.map((x) => x.fireRate))).toBe(WEAPONS['spray-smg'].fireRate);
        expect(Math.max(...w.map((x) => x.range))).toBe(WEAPONS['long-sniper'].range);
        expect(Math.max(...w.map((x) => x.damage))).toBe(WEAPONS['long-sniper'].damage);
        expect(isWeaponId('long-sniper')).toBe(true);
        for (const bad of ['charge-cannon', 'x', 3, null, { id: 'paint-rifle' }]) expect(isWeaponId(bad)).toBe(false);
    });

    it('spread patterns are deterministic and stay inside the cone', () => {
        for (const id of PLAYABLE_WEAPONS) {
            const def = WEAPONS[id];
            for (let seq = 1; seq < 200; seq++) {
                const a = pelletOffsets(def, seq);
                expect(a).toEqual(pelletOffsets(def, seq));
                expect(a).toHaveLength(def.pellets);
                for (const o of a) expect(Math.hypot(o.yaw, o.pitch)).toBeLessThanOrEqual(def.spreadRad + 1e-9);
            }
        }
        expect(pelletOffsets(WEAPONS['paint-rifle'], 7)).toEqual([{ yaw: 0, pitch: 0 }]);
    });

    it('shotgun: one trigger pull fires 7 pellets that paint a wider area than the rifle', () => {
        const paintArea = (id: (typeof PLAYABLE_WEAPONS)[number]) => {
            const paint = new PaintGrid(world, NEON_TERMINAL);
            const s = playerAt(-28, 0, 0, EAST);
            equipWeapon(s, id);
            settle(s, EAST);
            const r = stepPlayer(s, input({ yaw: EAST, pitch: -0.35, buttons: FIRE }), world, paint);
            return { shots: r.shots.length, cells: paint.blueCount, xs: r.shots.map((x) => x.impact!.z) };
        };
        const rifle = paintArea('paint-rifle');
        const shotgun = paintArea('splash-shotgun');
        expect(rifle.shots).toBe(1);
        expect(shotgun.shots).toBe(7);
        expect(shotgun.cells).toBeGreaterThan(rifle.cells * 1.5);
        // Pellets land spread out sideways, not on one spot.
        expect(Math.max(...shotgun.xs) - Math.min(...shotgun.xs)).toBeGreaterThan(1);
    });

    it('fire intervals follow each weapon (smg fastest, sniper slowest)', () => {
        const shotsIn = (id: (typeof PLAYABLE_WEAPONS)[number], ticks: number) => {
            const s = playerAt(-28, 0, 0, EAST);
            equipWeapon(s, id);
            settle(s, EAST);
            let pulls = 0;
            for (let i = 0; i < ticks; i++) if (stepPlayer(s, input({ yaw: EAST, buttons: FIRE }), world).weapon.fired) pulls++;
            return pulls;
        };
        expect(shotsIn('spray-smg', 30)).toBeGreaterThan(shotsIn('paint-rifle', 30));
        expect(shotsIn('long-sniper', 30)).toBeLessThanOrEqual(1);
        expect(fireIntervalTicks(WEAPONS['spray-smg'])).toBeLessThan(fireIntervalTicks(WEAPONS['paint-rifle']));
    });

    it('prediction produces exactly the server pellets for the same input', () => {
        const a = playerAt(-28, 0, 0, EAST);
        const b = playerAt(-28, 0, 0, EAST);
        equipWeapon(a, 'splash-shotgun');
        equipWeapon(b, 'splash-shotgun');
        settle(a, EAST);
        settle(b, EAST);
        const i: PlayerInput = input({ yaw: EAST, pitch: -0.2, buttons: FIRE });
        const server = stepPlayer(a, i, world);
        const client = predictPlayer(b, i, world, undefined);
        expect(client.shots.map((s) => s.impact)).toEqual(server.shots.map((s) => s.impact));
    });
});

describe('weapons (Phase 6): switching and damage in a match', () => {
    const duel = () => {
        const sim = new MatchSimulation(NEON_TERMINAL);
        const a = sim.addPlayer('a', 'blue');
        const b = sim.addPlayer('b', 'orange');
        return { sim, a, b };
    };

    it('switches immediately inside the own spawn zone, otherwise at the next respawn', () => {
        const { sim, a } = duel();
        expect(sim.requestWeapon('a', 'long-sniper')).toBe('now');
        expect(a.weaponId).toBe('long-sniper');
        expect(a.ammo).toBe(WEAPONS['long-sniper'].magazineSize);
        // Walk out of the spawn zone (server-side setup): now the choice is queued.
        a.position = { x: 0, y: 0, z: 0 };
        expect(sim.requestWeapon('a', 'spray-smg')).toBe('next');
        expect(a.weaponId).toBe('long-sniper');
        expect(a.nextWeaponId).toBe('spray-smg');
        expect(sim.requestWeapon('a', 'rocket-launcher')).toBe('invalid');
        expect(sim.requestWeapon('nobody', 'spray-smg')).toBe('invalid');
        // Splat and respawn: the queued weapon is equipped with a full magazine.
        a.hp = 0;
        a.alive = false;
        a.respawnTicks = 1;
        sim.step(new Map());
        expect(a.alive).toBe(true);
        expect(a.weaponId).toBe('spray-smg');
        expect(a.nextWeaponId).toBeNull();
        expect(a.ammo).toBe(WEAPONS['spray-smg'].magazineSize);
    });

    it('a point-blank shotgun blast deals pellet damage and stops at the splat', () => {
        const { sim, a, b } = duel();
        sim.requestWeapon('a', 'splash-shotgun');
        a.position = { x: -10, y: 0, z: 0 };
        b.position = { x: -7.5, y: 0, z: 0 };
        a.invulnerableTicks = b.invulnerableTicks = 0;
        for (let i = 0; i < 20; i++) sim.step(new Map());
        b.hp = 100;
        const events = sim.step(new Map([['a', input({ yaw: EAST, pitch: -0.05, buttons: FIRE })]]));
        const hits = events.filter((e) => e.type === 'hit');
        expect(hits.length).toBeGreaterThanOrEqual(3);
        const dealt = hits.reduce((n, e) => n + (e.type === 'hit' ? e.damage : 0), 0);
        expect(dealt).toBe(100 - b.hp);
        expect(dealt).toBeLessThanOrEqual(WEAPONS['splash-shotgun'].damage * WEAPONS['splash-shotgun'].pellets);
        // One more blast at full HP left: splat happens once, extra pellets do not double count.
        b.hp = 20;
        for (let i = 0; i < fireIntervalTicks(WEAPONS['splash-shotgun']); i++) sim.step(new Map());
        const ev2 = sim.step(new Map([['a', input({ yaw: EAST, pitch: -0.05, buttons: FIRE })]]));
        expect(ev2.filter((e) => e.type === 'splat')).toHaveLength(1);
        expect(b.hp).toBe(0);
    });

    it('a sniper shot hits hard at long range where the rifle cannot reach', () => {
        const { sim, a, b } = duel();
        a.position = { x: -30, y: 0, z: 13 };
        // Over-the-shoulder aim: a level shot at 40 m passes ~0.5 m right of the shooter line.
        b.position = { x: 10, y: 0, z: 13.55 };
        a.invulnerableTicks = b.invulnerableTicks = 0;
        for (let i = 0; i < 20; i++) sim.step(new Map());
        const yaw = -Math.PI / 2;
        // Rifle (25 m) cannot reach 40 m.
        const r1 = sim.step(new Map([['a', input({ yaw, pitch: 0, buttons: FIRE })]]));
        expect(r1.some((e) => e.type === 'hit')).toBe(false);
        // Out of the spawn zone the choice waits for a respawn; equip directly for this check.
        equipWeapon(a, 'long-sniper');
        for (let i = 0; i < 10; i++) sim.step(new Map());
        const r2 = sim.step(new Map([['a', input({ yaw, pitch: 0, buttons: FIRE })]]));
        const hit = r2.find((e) => e.type === 'hit');
        expect(hit && hit.type === 'hit' ? hit.damage : 0).toBe(WEAPONS['long-sniper'].damage);
    });
});
