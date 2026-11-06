import {
    DEFAULT_APPEARANCE,
    OUTFIT_PRESETS,
    SLOT_FIELD,
    WARDROBE_ITEMS,
    WARDROBE_SLOTS,
    appearanceKey,
    randomAppearance,
    sanitizeAppearance,
    withItem
} from '@colorfront/shared';
import { describe, expect, it } from 'vitest';

describe('avatar appearance allowlist (Phase 6 Gate 3)', () => {
    it('keeps a valid appearance unchanged', () => {
        const a = { ...DEFAULT_APPEARANCE, topId: 'top_hardshell', hairId: 'hair_crew', headwearId: 'headwear_cap' };
        expect(sanitizeAppearance(a)).toEqual(a);
    });

    it('rejects injected values slot by slot and falls back to defaults', () => {
        const evil = {
            version: 1,
            hairId: 'https://evil.example/hair.glb',
            headwearId: '<script>alert(1)</script>',
            topId: '../../../etc/passwd',
            bottomId: 'bottom_short', // valid: kept
            shoesId: { toString: () => 'shoes_runner' },
            backId: 'top_bomber', // valid id but wrong slot
            weaponSkinId: 42,
            colorVariant: 'gold'
        };
        const out = sanitizeAppearance(evil);
        expect(out).toEqual({ ...DEFAULT_APPEARANCE, bottomId: 'bottom_short' });
    });

    it('ignores non-objects, arrays, wrong versions and prototype tricks', () => {
        for (const bad of [null, undefined, 'x', 7, [], { version: 2, topId: 'top_hardshell' }]) {
            expect(sanitizeAppearance(bad)).toEqual(DEFAULT_APPEARANCE);
        }
        const proto = JSON.parse('{"version":1,"__proto__":{"topId":"top_hardshell"}}');
        expect(sanitizeAppearance(proto).topId).toBe(DEFAULT_APPEARANCE.topId);
        expect(({} as Record<string, unknown>).topId).toBeUndefined();
    });

    it('drops unknown extra fields (only allowlisted data is kept)', () => {
        const out = sanitizeAppearance({ ...DEFAULT_APPEARANCE, speed: 99, damage: 999 }) as Record<string, unknown>;
        expect(Object.keys(out).sort()).toEqual(Object.keys(DEFAULT_APPEARANCE).sort());
    });

    it('withItem only accepts items of that slot', () => {
        expect(withItem(DEFAULT_APPEARANCE, 'top', 'top_hardshell').topId).toBe('top_hardshell');
        expect(withItem(DEFAULT_APPEARANCE, 'top', 'hair_crew').topId).toBe(DEFAULT_APPEARANCE.topId);
    });

    it('presets and random outfits are valid and deterministic', () => {
        for (const p of OUTFIT_PRESETS) expect(sanitizeAppearance(p.appearance)).toEqual(p.appearance);
        let s = 1;
        const rand = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
        const a = randomAppearance(rand);
        expect(sanitizeAppearance(a)).toEqual(a);
        for (const slot of WARDROBE_SLOTS) expect(WARDROBE_ITEMS[slot]).toContain(a[SLOT_FIELD[slot]]);
        s = 1;
        expect(appearanceKey(randomAppearance(rand))).toBe(appearanceKey(a));
    });
});
