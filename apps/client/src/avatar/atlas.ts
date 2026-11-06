import { COLOR_CHOICES } from '@colorfront/shared';
import type { AvatarAppearance, TeamId } from '@colorfront/shared';

/**
 * Layout of the shared avatar atlas (must match assets-src/blender/atlas_layout.json — a unit test
 * compares them). Blender pixel rows count from the bottom; glTF UVs have v pointing down, so
 * vBlender = 1 - v.
 */
export const ATLAS = { width: 1536, height: 1024, cell: 64, faceTile: 256, faceOriginX: 512 } as const;

export const ATLAS_CELLS: Readonly<Record<string, number>> = {
    skin_light: 0, skin_light_d: 1, skin_warm: 2, skin_warm_d: 3, skin_tan: 4, skin_tan_d: 5, skin_deep: 6, skin_deep_d: 7,
    team_blue: 8, team_d_blue: 9, team_l_blue: 10, led_blue: 11, liquid_blue: 12,
    team_orange: 13, team_d_orange: 14, team_l_orange: 15, led_orange: 16, liquid_orange: 17,
    hair_navy: 18, hair_brown: 19, hair_black: 20, hair_blonde: 21, hair_pink: 22, hair_silver: 23, hair_green: 24, hair_red: 25,
    graphite_graphite: 26, graphite_l_graphite: 27, slate_graphite: 28, slate_d_graphite: 29,
    graphite_sand: 30, graphite_l_sand: 31, slate_sand: 32, slate_d_sand: 33,
    graphite_olive: 34, graphite_l_olive: 35, slate_olive: 36, slate_d_olive: 37,
    graphite_frost: 38, graphite_l_frost: 39, slate_frost: 40, slate_d_frost: 41,
    ivory: 42, rubber: 43, metal: 44, sole: 45, yellow: 46, white: 47, glass: 48, glove: 49, strap: 50, under: 51,
    accent_gold: 56, lens: 57
};

export const ATLAS_EMBLEMS: Readonly<Record<TeamId, readonly [number, number]>> = { blue: [6, 6], orange: [4, 6] };

const CELL_NAMES: string[] = [];
for (const [name, i] of Object.entries(ATLAS_CELLS)) CELL_NAMES[i] = name;

const OUTFIT_FAMILIES = ['graphite', 'graphite_l', 'slate', 'slate_d'] as const;

export type ColourVariant = Pick<AvatarAppearance, 'hairColor' | 'skinTone' | 'outfitColor'> & { team: TeamId };

/** Variant cell for a cell exported with the default colours (blue, light skin, navy hair, graphite). */
function variantName(name: string, v: ColourVariant): string {
    if (v.team === 'orange' && name.endsWith('_blue')) return name.slice(0, -5) + '_orange';
    if (name === 'skin_light') return `skin_${v.skinTone}`;
    if (name === 'skin_light_d') return `skin_${v.skinTone}_d`;
    if (name.startsWith('hair_')) return `hair_${v.hairColor}`;
    for (const fam of OUTFIT_FAMILIES) if (name === `${fam}_graphite`) return `${fam}_${v.outfitColor}`;
    return name;
}

/**
 * UV remap for an outfit's colours. Exported meshes use the default variant cells; merging an
 * outfit moves each vertex's UV to the chosen variant cell (palette), the team's emblem block and
 * the skin tone's face-tile row. Returns null when nothing changes (default variant).
 */
export function makeUvRemap(v: ColourVariant): ((u: number, vv: number) => [number, number]) | null {
    const tone = (COLOR_CHOICES.skinTone as readonly string[]).indexOf(v.skinTone);
    if (v.team === 'blue' && tone <= 0 && v.hairColor === 'navy' && v.outfitColor === 'graphite') return null;
    const { width: W, height: H, cell: C, faceOriginX, faceTile } = ATLAS;
    const [ebc, ebr] = ATLAS_EMBLEMS.blue;
    const [eoc] = ATLAS_EMBLEMS.orange;
    const cellCache = new Map<number, number>();
    return (u, vv) => {
        const px = u * W;
        let py = (1 - vv) * H;
        let outX = px;
        if (px < 8 * C && py < 8 * C) {
            const col = Math.floor(px / C);
            const row = Math.floor(py / C);
            if (col >= ebc && row >= ebr) {
                // Emblem block (keeps the texel position inside the block).
                if (v.team === 'orange') outX = px - (ebc - eoc) * C;
            } else {
                const idx = row * 8 + col;
                let target = cellCache.get(idx);
                if (target === undefined) {
                    const name = CELL_NAMES[idx];
                    target = name ? (ATLAS_CELLS[variantName(name, v)] ?? idx) : idx;
                    cellCache.set(idx, target);
                }
                if (target !== idx) {
                    outX = (target % 8) * C + C / 2;
                    py = Math.floor(target / 8) * C + C / 2;
                }
            }
        } else if (px >= faceOriginX && tone > 0) {
            // Face tiles are exported in the tone-0 row; each skin tone has its own row.
            py += tone * faceTile;
        }
        return [outX / W, 1 - py / H];
    };
}
