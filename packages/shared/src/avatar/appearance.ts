/**
 * Avatar appearance (Phase 6 Gates 3/3-B, v2): what a player wears and which colours. Purely
 * cosmetic — no field may change movement, damage, ammo, hit boxes or visibility. Shared by client
 * and server so both validate against the same allowlist; unknown / injected values fall back to
 * defaults and a URL or script can never be smuggled in as an item.
 *
 * Every list below is APPEND-ONLY: indices travel on the wire (look strings) and in saved data.
 */

export const WARDROBE_SLOTS = ['hair', 'headwear', 'face', 'neck', 'top', 'bottom', 'shoes', 'back', 'weaponSkin'] as const;
export type WardrobeSlot = (typeof WARDROBE_SLOTS)[number];

/** Allowlisted item IDs per slot (first entry = default). `none` = nothing worn in that slot. */
export const WARDROBE_ITEMS = {
    hair: ['hair_sidepart', 'hair_crew', 'hair_ponytail', 'hair_buzz'],
    headwear: ['none', 'headwear_cap', 'headwear_beanie'],
    face: ['none', 'face_goggles', 'face_glasses'],
    neck: ['none', 'neck_scarf', 'neck_headphones'],
    top: ['top_bomber', 'top_hardshell', 'top_tee', 'top_hoodie'],
    bottom: ['bottom_cargo', 'bottom_short', 'bottom_jogger'],
    shoes: ['shoes_runner', 'shoes_boots'],
    back: ['back_tank_standard', 'back_tank_twin'],
    weaponSkin: ['weapon_rifle_default']
} as const satisfies Record<WardrobeSlot, readonly string[]>;

/** Colour choices (palette variants in the shared atlas; see apps/client/src/avatar/atlas.ts). */
export const COLOR_CHOICES = {
    hairColor: ['navy', 'brown', 'black', 'blonde', 'pink', 'silver', 'green', 'red'],
    skinTone: ['light', 'warm', 'tan', 'deep'],
    outfitColor: ['graphite', 'sand', 'olive', 'frost']
} as const;
export type ColorChoice = keyof typeof COLOR_CHOICES;
export const COLOR_FIELDS = ['hairColor', 'skinTone', 'outfitColor'] as const satisfies readonly ColorChoice[];
export type HairColor = (typeof COLOR_CHOICES.hairColor)[number];
export type SkinTone = (typeof COLOR_CHOICES.skinTone)[number];
export type OutfitColor = (typeof COLOR_CHOICES.outfitColor)[number];

export type AvatarAppearance = {
    version: 2;
    hairId: string;
    headwearId: string;
    faceId: string;
    neckId: string;
    topId: string;
    bottomId: string;
    shoesId: string;
    backId: string;
    weaponSkinId: string;
    hairColor: HairColor;
    skinTone: SkinTone;
    outfitColor: OutfitColor;
};

/** Appearance field holding each slot's item. */
export const SLOT_FIELD = {
    hair: 'hairId',
    headwear: 'headwearId',
    face: 'faceId',
    neck: 'neckId',
    top: 'topId',
    bottom: 'bottomId',
    shoes: 'shoesId',
    back: 'backId',
    weaponSkin: 'weaponSkinId'
} as const satisfies Record<WardrobeSlot, keyof AvatarAppearance>;

export const DEFAULT_APPEARANCE: Readonly<AvatarAppearance> = Object.freeze({
    version: 2,
    hairId: 'hair_sidepart',
    headwearId: 'none',
    faceId: 'none',
    neckId: 'none',
    topId: 'top_bomber',
    bottomId: 'bottom_cargo',
    shoesId: 'shoes_runner',
    backId: 'back_tank_standard',
    weaponSkinId: 'weapon_rifle_default',
    hairColor: 'navy',
    skinTone: 'light',
    outfitColor: 'graphite'
});

export function isAllowedItem(slot: WardrobeSlot, id: unknown): id is string {
    return typeof id === 'string' && (WARDROBE_ITEMS[slot] as readonly string[]).includes(id);
}

const isChoice = (field: ColorChoice, v: unknown): boolean => typeof v === 'string' && (COLOR_CHOICES[field] as readonly string[]).includes(v);

/**
 * Accepts anything (localStorage JSON, network message) and returns a valid v2 appearance. Every
 * slot and colour is checked against the allowlist independently (invalid -> default). v1 data
 * (no face/neck/colours) is upgraded. Never throws.
 */
export function sanitizeAppearance(input: unknown): AvatarAppearance {
    const out: AvatarAppearance = { ...DEFAULT_APPEARANCE };
    if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
    const src = input as Record<string, unknown>;
    if (src.version !== 1 && src.version !== 2) return out;
    const own = (k: string) => (Object.prototype.hasOwnProperty.call(src, k) ? src[k] : undefined);
    for (const slot of WARDROBE_SLOTS) {
        const field = SLOT_FIELD[slot];
        const value = own(field);
        if (isAllowedItem(slot, value)) out[field] = value;
    }
    for (const field of COLOR_FIELDS) {
        const v = own(field);
        if (isChoice(field, v)) (out as Record<string, unknown>)[field] = v;
    }
    // v1 crew cuts were brown by design.
    if (src.version === 1 && out.hairId === 'hair_crew') out.hairColor = 'brown';
    return out;
}

/** Stable key (cache id) for an appearance. */
export function appearanceKey(a: AvatarAppearance): string {
    return [...WARDROBE_SLOTS.map((s) => a[SLOT_FIELD[s]]), ...COLOR_FIELDS.map((f) => a[f])].join('|');
}

export function withItem(a: AvatarAppearance, slot: WardrobeSlot, id: string): AvatarAppearance {
    return isAllowedItem(slot, id) ? { ...a, [SLOT_FIELD[slot]]: id } : { ...a };
}

export function withColor(a: AvatarAppearance, field: ColorChoice, value: string): AvatarAppearance {
    return isChoice(field, value) ? { ...a, [field]: value } : { ...a };
}

export type OutfitPreset = { id: string; label: string; appearance: AvatarAppearance };

const preset = (patch: Partial<AvatarAppearance>): AvatarAppearance => ({ ...DEFAULT_APPEARANCE, ...patch });

/** Starter outfits offered in the wardrobe (labels are Korean UI text). */
export const OUTFIT_PRESETS: readonly OutfitPreset[] = [
    { id: 'courier', label: '기본 쿠리어', appearance: preset({}) },
    { id: 'shell', label: '하드셸 크루', appearance: preset({ topId: 'top_hardshell', bottomId: 'bottom_short', hairId: 'hair_crew', hairColor: 'brown', skinTone: 'warm' }) },
    { id: 'cap', label: '캡 러너', appearance: preset({ headwearId: 'headwear_cap', bottomId: 'bottom_short', faceId: 'face_goggles', outfitColor: 'frost' }) },
    { id: 'street', label: '스트리트 후디', appearance: preset({ topId: 'top_hoodie', bottomId: 'bottom_jogger', headwearId: 'headwear_beanie', neckId: 'neck_headphones', shoesId: 'shoes_boots', hairId: 'hair_ponytail', hairColor: 'pink', skinTone: 'tan', outfitColor: 'sand' }) },
    { id: 'sport', label: '스포츠 티', appearance: preset({ topId: 'top_tee', bottomId: 'bottom_short', hairId: 'hair_buzz', hairColor: 'black', faceId: 'face_glasses', skinTone: 'deep', backId: 'back_tank_twin', outfitColor: 'olive' }) },
    { id: 'storm', label: '스톰 쉘', appearance: preset({ topId: 'top_hardshell', hairId: 'hair_crew', headwearId: 'headwear_cap', neckId: 'neck_scarf', hairColor: 'silver', shoesId: 'shoes_boots' }) }
];

/** Deterministic random outfit (local bots, load tests). `rand` returns [0, 1). */
export function randomAppearance(rand: () => number): AvatarAppearance {
    const a: AvatarAppearance = { ...DEFAULT_APPEARANCE };
    const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length) % list.length];
    for (const slot of WARDROBE_SLOTS) a[SLOT_FIELD[slot]] = pick(WARDROBE_ITEMS[slot]);
    a.hairColor = pick(COLOR_CHOICES.hairColor);
    a.skinTone = pick(COLOR_CHOICES.skinTone);
    a.outfitColor = pick(COLOR_CHOICES.outfitColor);
    return a;
}

// ── wire format (Gate 3-B) ─────────────────────────────────────────────────────────────────────
// An outfit travels as a short versioned string of indices into the lists above:
//   v2: "2:" + 9 slot indices + hairColor.skinTone.outfitColor   (e.g. "2:0.0.0.0.0.0.0.0.0.0.0.0")
//   v1: "1:" + 7 slot indices (hair, headwear, top, bottom, shoes, back, weaponSkin) + colorVariant
// Anything that is not exactly one of these shapes, or has an out-of-range index, is rejected.

export const LOOK_VERSION = 2;
export const LOOK_MAX_LENGTH = 48;
const V2_PATTERN = new RegExp(String.raw`^2:\d{1,2}(\.\d{1,2}){${WARDROBE_SLOTS.length + COLOR_FIELDS.length - 1}}$`);
const V1_PATTERN = /^1:\d{1,2}(\.\d{1,2}){7}$/;
const V1_SLOTS: readonly WardrobeSlot[] = ['hair', 'headwear', 'top', 'bottom', 'shoes', 'back', 'weaponSkin'];

export function encodeAppearance(a: AvatarAppearance): string {
    const s = sanitizeAppearance(a);
    const idx = WARDROBE_SLOTS.map((slot) => (WARDROBE_ITEMS[slot] as readonly string[]).indexOf(s[SLOT_FIELD[slot]]));
    for (const f of COLOR_FIELDS) idx.push((COLOR_CHOICES[f] as readonly string[]).indexOf(s[f]));
    return `${LOOK_VERSION}:${idx.join('.')}`;
}

function parseLook(look: unknown): AvatarAppearance | null {
    if (typeof look !== 'string' || look.length > LOOK_MAX_LENGTH) return null;
    const idx = look.slice(2).split('.').map(Number);
    const out: AvatarAppearance = { ...DEFAULT_APPEARANCE };
    if (V2_PATTERN.test(look)) {
        for (let i = 0; i < WARDROBE_SLOTS.length; i++) {
            const list = WARDROBE_ITEMS[WARDROBE_SLOTS[i]] as readonly string[];
            if (idx[i] >= list.length) return null;
            out[SLOT_FIELD[WARDROBE_SLOTS[i]]] = list[idx[i]];
        }
        for (let k = 0; k < COLOR_FIELDS.length; k++) {
            const f = COLOR_FIELDS[k];
            const list = COLOR_CHOICES[f] as readonly string[];
            const v = idx[WARDROBE_SLOTS.length + k];
            if (v >= list.length) return null;
            (out as Record<string, unknown>)[f] = list[v];
        }
        return out;
    }
    if (V1_PATTERN.test(look)) {
        for (let i = 0; i < V1_SLOTS.length; i++) {
            const list = WARDROBE_ITEMS[V1_SLOTS[i]] as readonly string[];
            // v1 lists were the first entries of today's lists (append-only), v1 had 2 hair styles etc.
            if (idx[i] >= list.length) return null;
            out[SLOT_FIELD[V1_SLOTS[i]]] = list[idx[i]];
        }
        if (idx[7] !== 0) return null; // v1 colour variant: only "graphite" existed
        if (out.hairId === 'hair_crew') out.hairColor = 'brown';
        return out;
    }
    return null;
}

/** True only for a well-formed look whose every index names an allowlisted entry. */
export function isValidLook(look: unknown): look is string {
    return parseLook(look) !== null;
}

/** Decode a (possibly hostile) look string. Invalid input gives the default outfit. Never throws. */
export function decodeAppearance(look: unknown): AvatarAppearance {
    return parseLook(look) ?? { ...DEFAULT_APPEARANCE };
}

export const DEFAULT_LOOK = encodeAppearance(DEFAULT_APPEARANCE);
