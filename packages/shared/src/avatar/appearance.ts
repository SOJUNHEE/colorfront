/**
 * Avatar appearance (Phase 6 Gate 3): what a player wears. Purely cosmetic — no field may change
 * movement, damage, ammo, hit boxes or visibility. Shared by client and (later, Gate 3-B) server so
 * both validate against the same allowlist; unknown / injected values fall back to defaults and a
 * URL or script can never be smuggled in as an item.
 */

export const WARDROBE_SLOTS = ['hair', 'headwear', 'top', 'bottom', 'shoes', 'back', 'weaponSkin'] as const;
export type WardrobeSlot = (typeof WARDROBE_SLOTS)[number];

/** Allowlisted item IDs per slot (first entry = default). `none` = nothing worn in that slot. */
export const WARDROBE_ITEMS = {
    hair: ['hair_sidepart', 'hair_crew'],
    headwear: ['none', 'headwear_cap'],
    top: ['top_bomber', 'top_hardshell'],
    bottom: ['bottom_cargo', 'bottom_short'],
    shoes: ['shoes_runner'],
    back: ['back_tank_standard'],
    weaponSkin: ['weapon_rifle_default']
} as const satisfies Record<WardrobeSlot, readonly string[]>;

export const COLOR_VARIANTS = ['graphite'] as const;
export type ColorVariant = (typeof COLOR_VARIANTS)[number];

export type AvatarAppearance = {
    version: 1;
    hairId: string;
    headwearId: string;
    topId: string;
    bottomId: string;
    shoesId: string;
    backId: string;
    weaponSkinId: string;
    colorVariant: ColorVariant;
};

/** Appearance field holding each slot's item. */
export const SLOT_FIELD = {
    hair: 'hairId',
    headwear: 'headwearId',
    top: 'topId',
    bottom: 'bottomId',
    shoes: 'shoesId',
    back: 'backId',
    weaponSkin: 'weaponSkinId'
} as const satisfies Record<WardrobeSlot, keyof AvatarAppearance>;

export const DEFAULT_APPEARANCE: Readonly<AvatarAppearance> = Object.freeze({
    version: 1,
    hairId: 'hair_sidepart',
    headwearId: 'none',
    topId: 'top_bomber',
    bottomId: 'bottom_cargo',
    shoesId: 'shoes_runner',
    backId: 'back_tank_standard',
    weaponSkinId: 'weapon_rifle_default',
    colorVariant: 'graphite'
});

export function isAllowedItem(slot: WardrobeSlot, id: unknown): id is string {
    return typeof id === 'string' && (WARDROBE_ITEMS[slot] as readonly string[]).includes(id);
}

/**
 * Accepts anything (localStorage JSON, network message) and returns a valid appearance. Every slot
 * is checked against the allowlist independently; invalid slots get the default. Never throws.
 */
export function sanitizeAppearance(input: unknown): AvatarAppearance {
    const out: AvatarAppearance = { ...DEFAULT_APPEARANCE };
    if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
    const src = input as Record<string, unknown>;
    if (src.version !== 1) return out;
    for (const slot of WARDROBE_SLOTS) {
        const field = SLOT_FIELD[slot];
        const value = Object.prototype.hasOwnProperty.call(src, field) ? src[field] : undefined;
        if (isAllowedItem(slot, value)) out[field] = value;
    }
    const cv = src.colorVariant;
    if (typeof cv === 'string' && (COLOR_VARIANTS as readonly string[]).includes(cv)) out.colorVariant = cv as ColorVariant;
    return out;
}

/** Stable key (cache id) for an appearance. */
export function appearanceKey(a: AvatarAppearance): string {
    return WARDROBE_SLOTS.map((s) => a[SLOT_FIELD[s]]).join('|') + '|' + a.colorVariant;
}

export function withItem(a: AvatarAppearance, slot: WardrobeSlot, id: string): AvatarAppearance {
    return isAllowedItem(slot, id) ? { ...a, [SLOT_FIELD[slot]]: id } : { ...a };
}

export type OutfitPreset = { id: string; label: string; appearance: AvatarAppearance };

/** Starter outfits offered in the wardrobe (labels are Korean UI text). */
export const OUTFIT_PRESETS: readonly OutfitPreset[] = [
    { id: 'courier', label: '기본 쿠리어', appearance: { ...DEFAULT_APPEARANCE } },
    {
        id: 'shell',
        label: '하드셸 크루',
        appearance: { ...DEFAULT_APPEARANCE, topId: 'top_hardshell', bottomId: 'bottom_short', hairId: 'hair_crew' }
    },
    {
        id: 'cap',
        label: '캡 러너',
        appearance: { ...DEFAULT_APPEARANCE, headwearId: 'headwear_cap', bottomId: 'bottom_short' }
    },
    {
        id: 'storm',
        label: '스톰 쉘',
        appearance: { ...DEFAULT_APPEARANCE, topId: 'top_hardshell', hairId: 'hair_crew', headwearId: 'headwear_cap' }
    }
];

/** Deterministic random outfit (local bots, load tests). `rand` returns [0, 1). */
export function randomAppearance(rand: () => number): AvatarAppearance {
    const a: AvatarAppearance = { ...DEFAULT_APPEARANCE };
    for (const slot of WARDROBE_SLOTS) {
        const list = WARDROBE_ITEMS[slot];
        a[SLOT_FIELD[slot]] = list[Math.floor(rand() * list.length) % list.length];
    }
    return a;
}
