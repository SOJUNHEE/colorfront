import { DEFAULT_APPEARANCE, appearanceKey } from '@colorfront/shared';
import type { AvatarAppearance, TeamId } from '@colorfront/shared';
import {
    Asset,
    Mesh,
    SEMANTIC_BLENDINDICES,
    SEMANTIC_BLENDWEIGHT,
    SEMANTIC_NORMAL,
    SEMANTIC_POSITION,
    SEMANTIC_TEXCOORD0,
    TYPE_FLOAT32,
    TYPE_UINT8,
    Texture
} from 'playcanvas';
import type { AppBase, ContainerResource, Entity, Material, MeshInstance, Skin, StandardMaterial } from 'playcanvas';

import { outfitParts } from './catalog.ts';

/**
 * Loads the wardrobe GLBs once and turns an appearance into ONE opaque skinned mesh (+ one glass
 * mesh for the tank) per LOD by merging the parts on the CPU. Avatars wearing the same outfit
 * share the merged meshes (reference counted); different players never share a skeleton or skin
 * instance (that lives in GlbAvatar). This keeps a near avatar at 2 draw calls whatever it wears.
 */

export const LOD_COUNT = 3;

type FilePart = { mesh: Mesh; material: Material };
type LoadedFile = Map<string, FilePart[]>;

export type OutfitMeshes = { key: string; lod: number; opaque: Mesh; glass: Mesh | null; triangles: number };

function loadContainer(app: AppBase, url: string): Promise<ContainerResource> {
    return new Promise((resolve, reject) => {
        const asset = new Asset(url, 'container', { url });
        asset.once('load', () => resolve(asset.resource as ContainerResource));
        asset.once('error', (err: unknown) => reject(new Error(`${url}: ${String(err)}`)));
        app.assets.add(asset);
        app.assets.load(asset);
    });
}

function loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`image ${url}`));
        img.src = url;
    });
}

/** Node names may carry Blender duplicate suffixes (`hair.001`). */
const cleanName = (n: string) => n.replace(/\.\d+$/, '');

export class AvatarLibrary {
    readonly skeleton: Entity;
    /** Canonical skin (joint order + inverse binds) used by every merged mesh. */
    readonly skin: Skin;
    private readonly app: AppBase;
    private readonly base: string;
    private readonly bodyBlue: Material;
    private bodyOrange: Material;
    readonly glass: Material;
    private readonly files = new Map<string, Promise<LoadedFile>>();
    private readonly outfits = new Map<string, { meshes: OutfitMeshes; refs: number; pinned: boolean }>();
    private readonly jointIndex: Map<string, number>;
    /** Diagnostics: merged meshes built so far. */
    merges = 0;

    private constructor(app: AppBase, base: string, skeleton: Entity, skin: Skin, body: Material, glass: Material) {
        this.app = app;
        this.base = base;
        this.skeleton = skeleton;
        this.skin = skin;
        this.bodyBlue = body;
        this.bodyOrange = body;
        this.glass = glass;
        this.jointIndex = new Map(skin.boneNames.map((n, i) => [n, i]));
    }

    static async load(app: AppBase, base = '/assets/'): Promise<AvatarLibrary> {
        // LOD0 base: skeleton template, canonical skin and the shared materials.
        const res = await loadContainer(app, `${base}characters/courier_base_lod0.glb`);
        const tmp = res.instantiateRenderEntity();
        let skin: Skin | null = null;
        let body: Material | null = null;
        let glass: Material | null = null;
        const first: LoadedFile = new Map();
        for (const r of tmp.findComponents('render')) {
            const entity = r.entity as Entity;
            for (const mi of (r as unknown as { meshInstances: MeshInstance[] }).meshInstances) {
                if (!mi.mesh || !mi.material) continue;
                skin ??= mi.mesh.skin;
                if (mi.material.name === 'cf_body') body ??= mi.material;
                if (mi.material.name === 'cf_glass') glass ??= mi.material;
                const list = first.get(cleanName(entity.name)) ?? [];
                list.push({ mesh: mi.mesh, material: mi.material });
                first.set(cleanName(entity.name), list);
                mi.skinInstance?.destroy();
            }
            entity.removeComponent('render');
        }
        if (!skin || !body) throw new Error('courier_base_lod0.glb: missing skin or cf_body material');
        // The base GLB has no tank; take the glass material from the tank file below.
        const lib = new AvatarLibrary(app, base, tmp, skin, body, glass ?? body);
        lib.files.set('characters/courier_base#0', Promise.resolve(first));
        const tank = await lib.loadFile('clothes', 'back_tank_standard', 0);
        for (const parts of tank.values()) for (const p of parts) if (p.material.name === 'cf_glass') (lib as { glass: Material }).glass = p.material;
        await lib.prepareTeam();
        // The default outfit is always available synchronously (pinned in the cache).
        await lib.prepare(DEFAULT_APPEARANCE, true);
        return lib;
    }

    private loadFile(folder: string, file: string, lod: number): Promise<LoadedFile> {
        const key = `${folder}/${file}#${lod}`;
        let p = this.files.get(key);
        if (!p) {
            p = loadContainer(this.app, `${this.base}${folder}/${file}_lod${lod}.glb`).then((res) => {
                // Items are drawn with the shared materials of courier_base_lod0; release any
                // texture a file still carries so it never occupies GPU memory.
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
            // A failed file can be retried later.
            p.catch(() => this.files.delete(key));
        }
        return p;
    }

    /** The GLBs embed the blue atlas; build the orange body material once (shared). */
    private async prepareTeam() {
        const [atlas, emissive] = await Promise.all([
            loadImage(`${this.base}characters/courier_atlas_orange.png`),
            loadImage(`${this.base}characters/courier_emissive_orange.png`)
        ]);
        const m = this.bodyBlue as StandardMaterial;
        const make = (img: HTMLImageElement, like: Texture | null) => {
            const t = new Texture(this.app.graphicsDevice, {
                name: 'courier-orange',
                width: img.width,
                height: img.height,
                format: like?.format,
                mipmaps: true,
                flipY: like?.flipY ?? false,
                minFilter: like?.minFilter,
                magFilter: like?.magFilter,
                addressU: like?.addressU,
                addressV: like?.addressV
            });
            t.setSource(img);
            return t;
        };
        const o = m.clone();
        o.diffuseMap = make(atlas, m.diffuseMap);
        if (m.emissiveMap) o.emissiveMap = make(emissive, m.emissiveMap);
        o.update();
        this.bodyOrange = o;
    }

    bodyMaterial(team: TeamId): Material {
        return team === 'orange' ? this.bodyOrange : this.bodyBlue;
    }

    /** Load every file the appearance needs (all LODs) and build its merged meshes. */
    async prepare(a: AvatarAppearance, pin = false): Promise<void> {
        const parts = outfitParts(a);
        for (let lod = 0; lod < LOD_COUNT; lod++) {
            const key = `${appearanceKey(a)}#${lod}`;
            if (this.outfits.has(key)) {
                if (pin) this.outfits.get(key)!.pinned = true;
                continue;
            }
            const files = await Promise.all(parts.map((p) => this.loadFile(p.folder, p.file, lod)));
            if (this.outfits.has(key)) continue; // built meanwhile by a concurrent call
            const meshes: FilePart[] = [];
            parts.forEach((p, i) => {
                const found = files[i].get(p.node);
                if (!found) throw new Error(`${p.file}_lod${lod}.glb has no node "${p.node}"`);
                meshes.push(...found);
            });
            const opaque = this.merge(meshes.filter((m) => m.material.name !== 'cf_glass'));
            const glassParts = meshes.filter((m) => m.material.name === 'cf_glass');
            const glass = glassParts.length ? this.merge(glassParts) : null;
            const triangles = (opaque.primitive[0].count + (glass?.primitive[0].count ?? 0)) / 3;
            // The cache owns one reference; mesh instances add their own (engine refcount).
            opaque.incRefCount();
            glass?.incRefCount();
            this.outfits.set(key, { meshes: { key, lod, opaque, glass, triangles }, refs: 0, pinned: pin });
        }
    }

    /** Cached merged meshes for an appearance/LOD (null if not prepared yet). Counts a user. */
    acquire(a: AvatarAppearance, lod: number): OutfitMeshes | null {
        const e = this.outfits.get(`${appearanceKey(a)}#${lod}`);
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
        for (const m of [e.meshes.opaque, e.meshes.glass]) {
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

    triangles(a: AvatarAppearance): number[] {
        return [0, 1, 2].map((lod) => this.outfits.get(`${appearanceKey(a)}#${lod}`)?.meshes.triangles ?? 0);
    }

    private merge(parts: FilePart[]): Mesh {
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
            const remap = names.map((name) => {
                const k = this.jointIndex.get(name);
                if (k === undefined) throw new Error(`unknown joint ${name}`);
                return k;
            });
            for (let i = 0; i < count; i++) {
                pos.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
                nor.push(n[i * 3] ?? 0, n[i * 3 + 1] ?? 1, n[i * 3 + 2] ?? 0);
                uv.push(t[i * 2] ?? 0, t[i * 2 + 1] ?? 0);
                for (let c = 0; c < 4; c++) {
                    bi.push(remap[j[i * 4 + c] ?? 0] ?? 0);
                    bw.push(w[i * 4 + c] ?? 0);
                }
            }
            const ind: number[] = [];
            mesh.getIndices(ind);
            const prim = mesh.primitive[0];
            const start = prim.base ?? 0;
            const end = start + (prim.count ?? ind.length);
            for (let i = start; i < end; i++) idx.push(ind[i] + base);
        }
        const m = new Mesh(this.app.graphicsDevice);
        m.setPositions(pos);
        m.setNormals(nor);
        m.setUvs(0, uv);
        m.setVertexStream(SEMANTIC_BLENDINDICES, bi, 4, undefined, TYPE_UINT8);
        m.setVertexStream(SEMANTIC_BLENDWEIGHT, bw, 4, undefined, TYPE_FLOAT32);
        m.setIndices(pos.length / 3 > 65535 ? new Uint32Array(idx) : new Uint16Array(idx));
        m.update();
        m.skin = this.skin;
        this.merges++;
        return m;
    }
}
