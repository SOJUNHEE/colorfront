/**
 * Phase 6: contract of the shipped avatar GLBs (built by assets-src/blender/scripts/build_courier.py).
 * The runtime (apps/client/src/player/GlbAvatar.ts) relies on these properties; a rebuilt model that
 * breaks one of them must fail here, not in a browser.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_APPEARANCE, SLOT_FIELD, WARDROBE_ITEMS, WARDROBE_SLOTS } from '@colorfront/shared';
import type { AvatarAppearance } from '@colorfront/shared';
import { describe, expect, it } from 'vitest';

import { outfitParts } from '../../apps/client/src/avatar/catalog.ts';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'apps', 'client', 'public', 'assets');

type Node = { name?: string; mesh?: number; children?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] };
type Gltf = {
    nodes: Node[];
    skins: { joints: number[] }[];
    meshes: { primitives: { attributes: Record<string, number>; indices?: number; material?: number }[] }[];
    accessors: { count: number; min?: number[]; max?: number[] }[];
    materials: { name?: string; alphaMode?: string }[];
};

function readGltf(rel: string): Gltf {
    const buf = readFileSync(join(ASSETS, rel));
    expect(buf.readUInt32LE(0)).toBe(0x46546c67);
    const jsonLen = buf.readUInt32LE(12);
    return JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8')) as Gltf;
}

// Names and parents from CharacterRig.ts (the legacy rig the game animates).
const BONES: Record<string, string | null> = {
    root: null, hips: 'root', spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
    shoulderL: 'chest', upperArmL: 'shoulderL', foreArmL: 'upperArmL', handL: 'foreArmL',
    shoulderR: 'chest', upperArmR: 'shoulderR', foreArmR: 'upperArmR', handR: 'foreArmR',
    thighL: 'hips', shinL: 'thighL', footL: 'shinL', thighR: 'hips', shinR: 'thighR', footR: 'shinR',
    gun: 'chest', liquid: 'chest'
};

const LODS: [string, number, number][] = [
    ['characters/courier_default_lod0.glb', 5000, 8000],
    ['characters/courier_default_lod1.glb', 1800, 3000],
    ['characters/courier_default_lod2.glb', 500, 1200]
];

describe('avatar GLB contract', () => {
    for (const [file, lo, hi] of LODS) {
        describe(file, () => {
            const g = readGltf(file);
            const parent = new Map<number, number>();
            g.nodes.forEach((n, i) => n.children?.forEach((c) => parent.set(c, i)));

            it('has the 22 CharacterRig joints with the same hierarchy', () => {
                expect(g.skins).toHaveLength(1);
                const names = g.skins[0].joints.map((j) => g.nodes[j].name);
                expect(new Set(names)).toEqual(new Set(Object.keys(BONES)));
                for (const j of g.skins[0].joints) {
                    const want = BONES[g.nodes[j].name!];
                    if (want) expect(g.nodes[parent.get(j)!].name).toBe(want);
                }
            });

            it('uses identity rest rotations and unit scale (procedural animation convention)', () => {
                for (const j of g.skins[0].joints) {
                    const r = g.nodes[j].rotation ?? [0, 0, 0, 1];
                    expect(Math.abs(r[0]) + Math.abs(r[1]) + Math.abs(r[2])).toBeLessThan(1e-4);
                    for (const s of g.nodes[j].scale ?? [1, 1, 1]) expect(s).toBeCloseTo(1, 4);
                }
            });

            it(`stays within ${lo}-${hi} triangles, soles at y=0, 2 materials (body + tank glass)`, () => {
                let tris = 0;
                let minY = Infinity;
                let maxY = -Infinity;
                const mats = new Set<number>();
                for (const m of g.meshes) {
                    for (const p of m.primitives) {
                        tris += g.accessors[p.indices!].count / 3;
                        const pos = g.accessors[p.attributes.POSITION];
                        minY = Math.min(minY, pos.min![1]);
                        maxY = Math.max(maxY, pos.max![1]);
                        mats.add(p.material!);
                        expect(p.attributes.JOINTS_0).toBeDefined();
                        expect(p.attributes.JOINTS_1).toBeUndefined(); // <= 4 influences
                    }
                }
                expect(tris).toBeGreaterThanOrEqual(lo);
                expect(tris).toBeLessThanOrEqual(hi);
                expect(Math.abs(minY)).toBeLessThan(0.012);
                expect(maxY).toBeGreaterThan(1.6);
                expect(maxY).toBeLessThan(1.78);
                expect(mats.size).toBe(2);
                expect(g.materials.filter((m) => m.alphaMode === 'BLEND').map((m) => m.name)).toEqual(['cf_glass']);
            });

            it('keeps the legacy muzzle offset under the gun joint', () => {
                const i = g.nodes.findIndex((n) => n.name === 'muzzle');
                expect(i).toBeGreaterThanOrEqual(0);
                expect(g.nodes[parent.get(i)!].name).toBe('gun');
                const t = g.nodes[i].translation!;
                expect(t[0]).toBeCloseTo(0, 3);
                expect(t[1]).toBeCloseTo(0.03, 3);
                expect(t[2]).toBeCloseTo(-0.64, 3);
            });
        });
    }

    it('ships the orange team textures the runtime swaps in', () => {
        for (const f of ['courier_atlas_orange.png', 'courier_emissive_orange.png']) {
            const png = readFileSync(join(ASSETS, 'characters', f));
            expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
        }
    });

    describe('wardrobe items (Gate 3)', () => {
        const BUDGET = [8000, 3000, 1200];
        const cache = new Map<string, Gltf>();
        const gltfOf = (folder: string, file: string, lod: number) => {
            const rel = `${folder}/${file}_lod${lod}.glb`;
            if (!cache.has(rel)) cache.set(rel, readGltf(rel));
            return cache.get(rel)!;
        };
        /** Triangles of the mesh nodes called `node` (Blender may append .001) in one GLB. */
        const nodeTris = (g: Gltf, node: string) => {
            let t = 0;
            let found = false;
            for (const n of g.nodes) {
                if (n.mesh === undefined || (n.name ?? '').split('.')[0] !== node) continue;
                found = true;
                for (const p of g.meshes[n.mesh].primitives) t += g.accessors[p.indices!].count / 3;
            }
            if (!found) throw new Error(`node ${node} missing`);
            return t;
        };
        // Every combination of every slot (2*2*2*2*1*1*1 = 16 outfits today).
        const combos: AvatarAppearance[] = [{ ...DEFAULT_APPEARANCE }];
        for (const slot of WARDROBE_SLOTS) {
            const next: AvatarAppearance[] = [];
            for (const a of combos) for (const id of WARDROBE_ITEMS[slot]) next.push({ ...a, [SLOT_FIELD[slot]]: id });
            combos.splice(0, combos.length, ...next);
        }

        it('every item GLB uses the canonical skeleton with identity rest rotations', () => {
            const seen = new Set<string>();
            for (const a of combos) for (const p of outfitParts(a)) seen.add(`${p.folder}/${p.file}`);
            for (const f of seen) {
                for (let lod = 0; lod < 3; lod++) {
                    const [folder, file] = f.split('/');
                    const g = gltfOf(folder, file, lod);
                    expect(g.skins).toHaveLength(1);
                    expect(new Set(g.skins[0].joints.map((j) => g.nodes[j].name))).toEqual(new Set(Object.keys(BONES)));
                    for (const j of g.skins[0].joints) {
                        const r = g.nodes[j].rotation ?? [0, 0, 0, 1];
                        expect(Math.abs(r[0]) + Math.abs(r[1]) + Math.abs(r[2])).toBeLessThan(1e-4);
                    }
                }
            }
        });

        it(`all ${combos.length} outfits stay within the per-avatar LOD budget (${BUDGET.join('/')})`, () => {
            for (const a of combos) {
                for (let lod = 0; lod < 3; lod++) {
                    const tris = outfitParts(a).reduce((n, p) => n + nodeTris(gltfOf(p.folder, p.file, lod), p.node), 0);
                    expect(tris, `${Object.values(a).join(',')} LOD${lod}`).toBeLessThanOrEqual(BUDGET[lod]);
                }
            }
        });

        it('headwear swaps the hair to its capped variant and clothes hide the covered base regions', () => {
            const nodes = (a: AvatarAppearance) => outfitParts(a).map((p) => p.node);
            expect(nodes(DEFAULT_APPEARANCE)).toContain('hair');
            expect(nodes({ ...DEFAULT_APPEARANCE, headwearId: 'headwear_cap' })).toContain('hair_capped');
            expect(nodes(DEFAULT_APPEARANCE)).not.toContain('base_torso');
            expect(nodes(DEFAULT_APPEARANCE)).not.toContain('base_shins');
            const shorts = nodes({ ...DEFAULT_APPEARANCE, bottomId: 'bottom_short' });
            expect(shorts).toContain('base_shins');
            expect(shorts).toContain('base_knees');
            expect(shorts).not.toContain('base_thighs');
        });
    });
});
