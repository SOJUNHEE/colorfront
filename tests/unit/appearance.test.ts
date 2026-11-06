import {
    DEFAULT_APPEARANCE,
    OUTFIT_PRESETS,
    SLOT_FIELD,
    WARDROBE_ITEMS,
    WARDROBE_SLOTS,
    DEFAULT_LOOK,
    appearanceKey,
    decodeAppearance,
    encodeAppearance,
    isValidLook,
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
        for (const bad of [null, undefined, 'x', 7, [], { version: 3, topId: 'top_hardshell' }, { version: '2', topId: 'top_hardshell' }]) {
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

    describe('wire format (Gate 3-B)', () => {
        const all: (typeof DEFAULT_APPEARANCE)[] = [{ ...DEFAULT_APPEARANCE }];
        for (const slot of WARDROBE_SLOTS) {
            const next: (typeof DEFAULT_APPEARANCE)[] = [];
            for (const a of all) for (const id of WARDROBE_ITEMS[slot]) next.push({ ...a, [SLOT_FIELD[slot]]: id });
            all.splice(0, all.length, ...next);
        }

        it('round-trips every outfit through a short versioned string', () => {
            for (const a of all) {
                const look = encodeAppearance(a);
                expect(look.length).toBeLessThanOrEqual(40);
                expect(isValidLook(look)).toBe(true);
                expect(decodeAppearance(look)).toEqual(a);
            }
            expect(DEFAULT_LOOK).toBe('2:0.0.0.0.0.0.0.0.0.0.0.0');
            // Colours travel too.
            const coloured = { ...DEFAULT_APPEARANCE, hairColor: 'pink', skinTone: 'deep', outfitColor: 'olive' } as const;
            expect(decodeAppearance(encodeAppearance(coloured))).toEqual(coloured);
        });

        it('upgrades v1 looks and saved data (append-only lists keep their meaning)', () => {
            const v1 = decodeAppearance('1:1.1.1.1.0.0.0.0');
            expect(v1).toEqual({ ...DEFAULT_APPEARANCE, hairId: 'hair_crew', hairColor: 'brown', headwearId: 'headwear_cap', topId: 'top_hardshell', bottomId: 'bottom_short' });
            const saved = sanitizeAppearance({ version: 1, hairId: 'hair_crew', topId: 'top_hardshell', colorVariant: 'graphite' });
            expect(saved.version).toBe(2);
            expect(saved.hairColor).toBe('brown');
            expect(saved.faceId).toBe('none');
        });

        it('rejects malformed or hostile look strings (decodes to the default outfit)', () => {
            const bad = [
                '', 'x', '0.0.0.0.0.0.0.0', '2:0.0.0.0.0.0.0.0', '1:0.0.0.0.0.0.0', '1:0.0.0.0.0.0.0.0.0',
                '2:0.0.0.0.0.0.0.0.0.0.0.9', '2:9.0.0.0.0.0.0.0.0.0.0.0', '3:0.0.0.0.0.0.0.0.0.0.0.0',
                '1:9.0.0.0.0.0.0.0', '1:0.0.0.0.0.0.0.5', '1:-1.0.0.0.0.0.0.0', '1:0.0.0.0.0.0.0.0 ', '1:0,0,0,0,0,0,0,0',
                '1:0.0.0.0.0.0.0.0<script>', 'https://evil.example/a.glb', '1:' + '0.'.repeat(500) + '0',
                null, undefined, 3, {}, [], { toString: () => '1:0.0.0.0.0.0.0.0' }
            ];
            for (const b of bad) {
                expect(isValidLook(b)).toBe(false);
                expect(decodeAppearance(b)).toEqual(DEFAULT_APPEARANCE);
            }
        });
    });
});
