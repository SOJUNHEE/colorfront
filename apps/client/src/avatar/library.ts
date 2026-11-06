import { DEFAULT_APPEARANCE, appearanceKey } from '@colorfront/shared';
import type { AvatarAppearance, TeamId, WeaponId } from '@colorfront/shared';
import {
    Asset,
    Mesh,
    SEMANTIC_BLENDINDICES,
    SEMANTIC_BLENDWEIGHT,
    SEMANTIC_NORMAL,
    SEMANTIC_POSITION,
    SEMANTIC_TEXCOORD0,
    TYPE_FLOAT32,
    TYPE_UINT8
} from 'playcanvas';
import type { AnimTrack, AppBase, ContainerResource, Entity, Material, MeshInstance, Skin, Texture } from 'playcanvas';

import { ClipSet } from './anim.ts';
import { ATLAS, makeUvRemap } from './atlas.ts';
import { outfitParts } from './catalog.ts';

/**
 * Loads the wardrobe GLBs once and turns (appearance, team, weapon) into ONE opaque skinned mesh
 * (+ one glass mesh for the tank) per LOD by merging the parts on the CPU. Colours, team and skin
 * tone are applied by remapping UVs into the shared atlas while merging, so every avatar uses the
 * same material and texture. Avatars with the same look share the merged meshes (reference
 * counted); different players never share a skeleton or skin instance (GlbAvatar owns those).
 */

export const LOD_COUNT = 3;

type FilePart = { mesh: Mesh; material: Material };
type LoadedFile = Map<string, FilePart[]>;

export type OutfitKey = { appearance: AvatarAppearance; team: TeamId; weapon: WeaponId };
export type OutfitMeshes = {
    key: string;
    lod: number;
    opaque: Mesh;
    glass: Mesh | null;
    /** LOD0 only: the face (split out of `opaque`), one mesh per expression (UV shifted to its tile). */
    faces: Mesh[] | null;
    triangles: number;
};

/** Face tiles in the atlas, left to right (assets-src/blender/atlas_layout.json `expressions`). */
export const EXPRESSIONS = ['neutral', 'blink', 'happy', 'surprised'] as const;
export type Expression = (typeof EXPRESSIONS)[number];

/** Is this UV inside the face-tile block of the atlas? */
const inFaceBlock = (u: number) => u * ATLAS.width >= ATLAS.faceOriginX - 0.5;

function loadContainer(app: AppBase, url: string): Promise<ContainerResource> {
    return new Promise((resolve, reject) => {
        const asset = new Asset(url, 'container', { url });
        asset.once('load', () => resolve(asset.resource as ContainerResource));
        asset.once('error', (err: unknown) => reject(new Error(`${url}: ${String(err)}`)));
        app.assets.add(asset);
        app.assets.load(asset);
    });
}

/** Node names may carry Blender duplicate suffixes (`hair.001`). */
const cleanName = (n: string) => n.replace(/\.\d+$/, '');

export const outfitId = (k: OutfitKey, lod: number) => `${appearanceKey(k.appearance)}|${k.team}|${k.weapon}#${lod}`;

export class AvatarLibrary {
    readonly skeleton: Entity;
    /** Canonical skin (joint order + inverse binds) used by every merged mesh. */
    readonly skin: Skin;
    readonly body: Material;
    readonly glass: Material;
    /** Keyframed clips (characters/courier_anims.glb), shared by every avatar. */
    readonly clips: ClipSet;
    private readonly app: AppBase;
    private readonly base: string;
    private readonly files = new Map<string, Promise<LoadedFile>>();
    private readonly outfits = new Map<string, { meshes: OutfitMeshes; refs: number; pinned: boolean }>();
    private readonly building = new Map<string, Promise<void>>();
    private readonly jointIndex: Map<string, number>;
    /** Diagnostics: merged meshes built so far. */
    merges = 0;

    private constructor(app: AppBase, base: string, skeleton: Entity, skin: Skin, body: Material, glass: Material, clips: ClipSet) {
        this.app = app;
        this.clips = clips;
        this.base = base;
        this.skeleton = skeleton;
        this.skin = skin;
        this.body = body;
        this.glass = glass;
        this.jointIndex = new Map(skin.boneNames.map((n, i) => [n, i]));
    }

    static async load(app: AppBase, base = '/assets/'): Promise<AvatarLibrary> {
        // LOD0 base: skeleton template, canonical skin and the shared atlas material; animation clips.
        const [res, animRes] = await Promise.all([
            loadContainer(app, `${base}characters/courier_base_lod0.glb`),
            loadContainer(app, `${base}characters/courier_anims.glb`)
        ]);
        const clips = ClipSet.fromTracks(animRes.animations.map((a) => a.resource as AnimTrack));
        if (clips.names.length === 0) throw new Error('courier_anims.glb: no animation clips');
        const tmp = res.instantiateRenderEntity();
        let skin: Skin | null = null;
        let body: Material | null = null;
        const first: LoadedFile = new Map();
        for (const r of tmp.findComponents('render')) {
            const entity = r.entity as Entity;
            for (const mi of (r as unknown as { meshInstances: MeshInstance[] }).meshInstances) {
                if (!mi.mesh || !mi.material) continue;
                skin ??= mi.mesh.skin;
                if (mi.material.name === 'cf_body') body ??= mi.material;
                const list = first.get(cleanName(entity.name)) ?? [];
                list.push({ mesh: mi.mesh, material: mi.material });
                first.set(cleanName(entity.name), list);
                mi.skinInstance?.destroy();
            }
            entity.removeComponent('render');
        }
        if (!skin || !body) throw new Error('courier_base_lod0.glb: missing skin or cf_body material');
        let glass: Material = body;
        const lib0 = new AvatarLibrary(app, base, tmp, skin, body, body, clips);
        lib0.files.set('characters/courier_base#0', Promise.resolve(first));
        const tank = await lib0.loadFile('clothes', 'back_tank_standard', 0);
        for (const parts of tank.values()) for (const p of parts) if (p.material.name === 'cf_glass') glass = p.material;
        (lib0 as { glass: Material }).glass = glass;
        // The default look (blue and orange, rifle) is always available synchronously.
        await Promise.all((['blue', 'orange'] as const).map((team) => lib0.prepare({ appearance: DEFAULT_APPEARANCE, team, weapon: 'paint-rifle' }, true)));
        return lib0;
    }

    private loadFile(folder: string, file: string, lod: number): Promise<LoadedFile> {
        const key = `${folder}/${file}#${lod}`;
        let p = this.files.get(key);
        if (!p) {
            p = loadContainer(this.app, `${this.base}${folder}/${file}_lod${lod}.glb`).then((res) => {
                // Items use the shared materials of courier_base_lod0; release any texture a file
                // still carries so it never occupies GPU memory.
                for (const t of res.textures) (t.resource as Texture | null)?.destroy();
                const tmp = res.instantiateRenderEntity();
                const out: LoadedFile = new Map();
                for (const r of tmp.findComponents('render')) {
                    const name = cleanName((r.entity as Entity).name);
                    for (const mi of (r as unknown as { meshInstances: MeshInstance[] }).meshInstances) {
                        if (!mi.mesh || !mi.material) continue;
                        const list = out.get(name) ?? [];
                        list.push({ mesh: mi.mesh, material: mi.material });
                        out.set(name, list);
                        mi.skinInstance?.destroy();
                    }
                }
                tmp.destroy();
                return out;
            });
            this.files.set(key, p);
            p.catch(() => this.files.delete(key)); // a failed file can be retried later
        }
        return p;
    }

    /** Load every file the look needs (all LODs) and build its merged meshes. */
    async prepare(k: OutfitKey, pin = false): Promise<void> {
        const id0 = outfitId(k, 0);
        if (this.outfits.has(id0)) {
            if (pin) for (let l = 0; l < LOD_COUNT; l++) this.outfits.get(outfitId(k, l))!.pinned = true;
            return;
        }
        let job = this.building.get(id0);
        if (!job) {
            job = this.build(k, pin).finally(() => this.building.delete(id0));
            this.building.set(id0, job);
        }
        await job;
        if (pin) for (let l = 0; l < LOD_COUNT; l++) this.outfits.get(outfitId(k, l))!.pinned = true;
    }

    private async build(k: OutfitKey, pin: boolean) {
        const parts = outfitParts(k.appearance, k.weapon);
        const remap = makeUvRemap({ ...k.appearance, team: k.team });
        for (let lod = 0; lod < LOD_COUNT; lod++) {
            const files = await Promise.all(parts.map((p) => this.loadFile(p.folder, p.file, lod)));
            const meshes: FilePart[] = [];
            parts.forEach((p, i) => {
                const found = files[i].get(p.node);
                if (!found) throw new Error(`${p.file}_lod${lod}.glb has no node "${p.node}"`);
                meshes.push(...found);
            });
            const solid = meshes.filter((m) => m.material.name !== 'cf_glass');
            // LOD0: the face triangles become their own small mesh so expressions can be swapped per
            // avatar (4 UV-shifted copies); far LODs keep the neutral face inside the body mesh.
            const opaque = this.merge(solid, remap, lod === 0 ? 'body' : 'all');
            const faces = lod === 0 ? EXPRESSIONS.map((_, e) => this.merge(solid, remap, 'face', (e * ATLAS.faceTile) / ATLAS.width)) : null;
            const glassParts = meshes.filter((m) => m.material.name === 'cf_glass');
            const glass = glassParts.length ? this.merge(glassParts, null) : null;
            const triangles = (opaque.primitive[0].count + (glass?.primitive[0].count ?? 0) + (faces?.[0].primitive[0].count ?? 0)) / 3;
            // The cache owns one reference; mesh instances add their own (engine refcount).
            for (const m of [opaque, glass, ...(faces ?? [])]) m?.incRefCount();
            const id = outfitId(k, lod);
            this.outfits.set(id, { meshes: { key: id, lod, opaque, glass, faces, triangles }, refs: 0, pinned: pin });
        }
    }

    /** Cached merged meshes for a look/LOD (null if not prepared yet). Counts a user. */
    acquire(k: OutfitKey, lod: number): OutfitMeshes | null {
        const e = this.outfits.get(outfitId(k, lod));
        if (!e) return null;
        e.refs++;
        return e.meshes;
    }

    release(key: string) {
        const e = this.outfits.get(key);
        if (!e) return;
        e.refs--;
        if (e.refs > 0 || e.pinned) return;
        this.outfits.delete(key);
        for (const m of [e.meshes.opaque, e.meshes.glass, ...(e.meshes.faces ?? [])]) {
            if (!m) continue;
            m.decRefCount();
            if (m.refCount < 1) m.destroy();
        }
    }

    /** Diagnostics: cached outfits and their users. */
    stats() {
        let refs = 0;
        for (const e of this.outfits.values()) refs += e.refs;
        return { outfits: this.outfits.size, refs, files: this.files.size, merges: this.merges };
    }

    triangles(k: OutfitKey): number[] {
        return [0, 1, 2].map((lod) => this.outfits.get(outfitId(k, lod))?.meshes.triangles ?? 0);
    }

    /**
     * Merge parts into one skinned mesh. `pick`: all triangles, only the face-tile triangles
     * ('face', UVs shifted right by `faceShift` to pick an expression tile) or everything else ('body').
     */
    private merge(
        parts: FilePart[],
        remap: ((u: number, v: number) => [number, number]) | null,
        pick: 'all' | 'body' | 'face' = 'all',
        faceShift = 0
    ): Mesh {
        const pos: number[] = [];
        const nor: number[] = [];
        const uv: number[] = [];
        const bi: number[] = [];
        const bw: number[] = [];
        const idx: number[] = [];
        for (const { mesh } of parts) {
            const base = pos.length / 3;
            const p: number[] = [];
            const n: number[] = [];
            const t: number[] = [];
            const j: number[] = [];
            const w: number[] = [];
            const count = mesh.getVertexStream(SEMANTIC_POSITION, p);
            mesh.getVertexStream(SEMANTIC_NORMAL, n);
            mesh.getVertexStream(SEMANTIC_TEXCOORD0, t);
            mesh.getVertexStream(SEMANTIC_BLENDINDICES, j);
            mesh.getVertexStream(SEMANTIC_BLENDWEIGHT, w);
            // Remap joint indices by bone name onto the canonical skin.
            const names = mesh.skin?.boneNames ?? this.skin.boneNames;
            const jmap = names.map((name) => {
                const k = this.jointIndex.get(name);
                if (k === undefined) throw new Error(`unknown joint ${name}`);
                return k;
            });
            for (let i = 0; i < count; i++) {
                pos.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
                nor.push(n[i * 3] ?? 0, n[i * 3 + 1] ?? 1, n[i * 3 + 2] ?? 0);
                const tu = t[i * 2] ?? 0;
                const tv = t[i * 2 + 1] ?? 0;
                if (remap) {
                    const [ru, rv] = remap(tu, tv);
                    uv.push(ru, rv);
                } else uv.push(tu, tv);
                for (let c = 0; c < 4; c++) {
                    bi.push(jmap[j[i * 4 + c] ?? 0] ?? 0);
                    bw.push(w[i * 4 + c] ?? 0);
                }
            }
            const ind: number[] = [];
            mesh.getIndices(ind);
            const prim = mesh.primitive[0];
            const start = prim.base ?? 0;
            const end = start + (prim.count ?? ind.length);
            for (let i = start; i + 2 < end; i += 3) {
                if (pick !== 'all') {
                    const face = inFaceBlock(t[ind[i] * 2] ?? 0) && inFaceBlock(t[ind[i + 1] * 2] ?? 0) && inFaceBlock(t[ind[i + 2] * 2] ?? 0);
                    if (face !== (pick === 'face')) continue;
                }
                idx.push(ind[i] + base, ind[i + 1] + base, ind[i + 2] + base);
            }
        }
        if (pick === 'face' && faceShift) for (let i = 0; i < uv.length; i += 2) if (inFaceBlock(uv[i])) uv[i] += faceShift;
        // A partial pick keeps only the vertices its triangles use (the face is a few hundred).
        const s = pick === 'all' ? null : compact(idx, pos.length / 3);
        const take = (src: number[], n: number) => (s ? s.order.flatMap((v) => src.slice(v * n, v * n + n)) : src);
        const m = new Mesh(this.app.graphicsDevice);
        m.setPositions(take(pos, 3));
        m.setNormals(take(nor, 3));
        m.setUvs(0, take(uv, 2));
        m.setVertexStream(SEMANTIC_BLENDINDICES, take(bi, 4), 4, undefined, TYPE_UINT8);
        m.setVertexStream(SEMANTIC_BLENDWEIGHT, take(bw, 4), 4, undefined, TYPE_FLOAT32);
        const index = s ? s.index : idx;
        const verts = s ? s.order.length : pos.length / 3;
        m.setIndices(verts > 65535 ? new Uint32Array(index) : new Uint16Array(index));
        m.update();
        m.skin = this.skin;
        this.merges++;
        return m;
    }
}

/** Renumber the vertices used by `idx` densely: `order[newIndex] = oldIndex`. */
export function compact(idx: readonly number[], vertexCount: number): { order: number[]; index: number[] } {
    const map = new Int32Array(vertexCount).fill(-1);
    const order: number[] = [];
    const index = idx.map((v) => {
        if (map[v] < 0) {
            map[v] = order.length;
            order.push(v);
        }
        return map[v];
    });
    return { order, index };
}
