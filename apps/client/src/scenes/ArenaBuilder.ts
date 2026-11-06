import { buildCollisionWorld, buildNeonTerminalDecor, buildNeonTerminalSkin, decorBounds, surfaceTopAt } from '@colorfront/shared';
import type {
    CompiledSolid,
    DecorItem,
    DecorMaterial,
    DecorSign,
    MapDefinition,
    PaintScore,
    TeamId
} from '@colorfront/shared';
import { Color, Entity, MeshInstance, StandardMaterial } from 'playcanvas';
import type { AppBase } from 'playcanvas';

import { MaterialLibrary } from '../render/Materials.ts';
import { MeshBatch } from '../render/MeshBatch.ts';
import type { Tint, UvMode } from '../render/MeshBatch.ts';
import { SignRenderer } from '../render/Signs.ts';

export const TEAM_COLORS: Record<TeamId, Color> = {
    blue: new Color(0.16, 0.48, 1),
    orange: new Color(1, 0.5, 0.1)
};

export function emissiveMaterial(color: Color, intensity = 1): StandardMaterial {
    const m = new StandardMaterial();
    m.diffuse = new Color(0, 0, 0);
    m.emissive = color.clone();
    m.emissiveIntensity = intensity;
    m.update();
    return m;
}

const WORLD4: UvMode = { kind: 'world', metres: 4 };
const WORLD2: UvMode = { kind: 'world', metres: 2 };

/** Stable pseudo-random tint per solid id (same colours every load, mirrored pairs match). */
function idHash(id: string) {
    const key = id.replace(/-[we]$/, '');
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
    return (h >>> 0) / 4294967296;
}
const CONTAINER_TINTS: Tint[] = [
    [0.56, 0.17, 0.12],
    [0.14, 0.33, 0.42],
    [0.64, 0.47, 0.13],
    [0.2, 0.4, 0.24],
    [0.36, 0.38, 0.42]
];

type V3 = [number, number, number];

/** Emit the faces of a collision solid: top (flat or sloped) into `top`, sides/bottom into `side`. */
function solidFaces(s: CompiledSolid, top: MeshBatch, side: MeshBatch, topUv: UvMode, sideUv: UvMode, tint?: Tint) {
    const x0 = s.minX,
        x1 = s.maxX,
        y0 = s.minY,
        z0 = s.minZ,
        z1 = s.maxZ;
    const corners: [number, number][] = [
        [x0, z0],
        [x1, z0],
        [x1, z1],
        [x0, z1]
    ];
    const t = corners.map(([x, z]) => [x, surfaceTopAt(s, x, z), z] as V3);
    const b = corners.map(([x, z]) => [x, y0, z] as V3);
    top.quad(t[0], t[1], t[2], t[3], [0, 1, 0], topUv, tint);
    if (y0 > 0.001) side.quad(b[0], b[1], b[2], b[3], [0, -1, 0], sideUv, tint);
    const outward: V3[] = [
        [0, 0, -1],
        [1, 0, 0],
        [0, 0, 1],
        [-1, 0, 0]
    ];
    for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        if (t[i][1] - y0 < 1e-4 && t[j][1] - y0 < 1e-4) continue;
        side.quad(b[i], b[j], t[j], t[i], outward[i], sideUv, tint);
    }
}

export type ArenaView = {
    root: Entity;
    materials: MaterialLibrary;
    signs: SignRenderer;
    update(dt: number, score: PaintScore): void;
    destroy(): void;
};

/**
 * Builds the level visuals: collision solids drawn with PBR materials, plus non-colliding decor
 * (validated in shared tests). All static geometry is merged per material, so the whole map is a
 * couple of dozen draw calls.
 */
export function buildArena(
    app: AppBase,
    map: MapDefinition,
    options: { textureSize: number; decorDensity: number }
): ArenaView {
    const device = app.graphicsDevice;
    const lib = new MaterialLibrary(device, options.textureSize);
    const world = buildCollisionWorld(map);
    const root = new Entity('arena');

    const batches = new Map<StandardMaterial, { batch: MeshBatch; shadows: boolean }>();
    const batchFor = (material: StandardMaterial, shadows = true) => {
        let entry = batches.get(material);
        if (!entry) {
            entry = { batch: new MeshBatch(), shadows };
            batches.set(material, entry);
        }
        return entry.batch;
    };

    // ---- Collision solids ----
    for (const s of world.solids) {
        const tag = s.source.tag;
        const height = s.maxY - s.minY;
        switch (tag) {
            case 'floor':
                batchFor(lib.floor, false).quad(
                    [s.minX, 0, s.maxZ],
                    [s.maxX, 0, s.maxZ],
                    [s.maxX, 0, s.minZ],
                    [s.minX, 0, s.minZ],
                    [0, 1, 0],
                    WORLD4
                );
                break;
            case 'boundary':
                solidFaces(s, batchFor(lib.darkMetal), batchFor(lib.boundary), WORLD4, WORLD4);
                break;
            case 'building': {
                const facadeUv: UvMode = { kind: 'facade', y0: s.minY, y1: s.maxY, uMetres: 24 };
                solidFaces(s, batchFor(lib.roof), batchFor(lib.facade), WORLD4, facadeUv);
                break;
            }
            case 'platform':
                solidFaces(s, batchFor(lib.platformTop), batchFor(lib.wall), WORLD4, WORLD4);
                break;
            case 'ramp':
                solidFaces(s, batchFor(lib.tread), batchFor(lib.wall), WORLD2, WORLD4);
                break;
            case 'bridge':
                solidFaces(s, batchFor(lib.tread), batchFor(lib.darkMetal), WORLD2, WORLD2);
                break;
            case 'cover': {
                if (height >= 2.4 && height < 3) {
                    // Shipping container: corrugated steel in a stable per-id colour.
                    const tint = CONTAINER_TINTS[Math.floor(idHash(s.source.id) * CONTAINER_TINTS.length)];
                    solidFaces(s, batchFor(lib.container), batchFor(lib.container), WORLD4, WORLD4, tint);
                    // Dark corner posts, flush with the faces.
                    const post = batchFor(lib.darkMetal);
                    for (const [px, pz] of [
                        [s.minX, s.minZ],
                        [s.maxX, s.minZ],
                        [s.maxX, s.maxZ],
                        [s.minX, s.maxZ]
                    ]) {
                        const sx = px === s.minX ? 1 : -1;
                        const sz = pz === s.minZ ? 1 : -1;
                        post.box(
                            [Math.min(px, px + sx * 0.14), s.minY, Math.min(pz, pz + sz * 0.14)],
                            [Math.max(px, px + sx * 0.14), s.maxY + 0.01, Math.max(pz, pz + sz * 0.14)],
                            WORLD2
                        );
                    }
                } else if (height > 3) {
                    solidFaces(s, batchFor(lib.wall), batchFor(lib.wall), WORLD4, WORLD4, [0.7, 0.72, 0.74]);
                } else {
                    // Low concrete barriers and crates.
                    solidFaces(s, batchFor(lib.barrier), batchFor(lib.barrier), WORLD2, WORLD2);
                    const band = batchFor(lib.hazard);
                    band.box(
                        [s.minX - 0.005, s.maxY - 0.22, s.minZ - 0.005],
                        [s.maxX + 0.005, s.maxY - 0.08, s.maxZ + 0.005],
                        { kind: 'world', metres: 1 },
                        undefined,
                        'xXzZ'
                    );
                }
                break;
            }
            default:
                solidFaces(s, batchFor(lib.wall), batchFor(lib.wall), WORLD4, WORLD4);
        }
    }

    // ---- Decor (visual only) ----
    const base = buildNeonTerminalDecor(options.decorDensity);
    // Gate 5 visual skin: detail derived from the solids (kept clear of the signs).
    const signBounds = base.filter((d) => d.kind === 'sign').map(decorBounds);
    const decor = [...base, ...buildNeonTerminalSkin(map, options.decorDensity, signBounds)];
    const materialFor = (m: DecorMaterial): [StandardMaterial, boolean] => {
        switch (m) {
            case 'trim':
                return [lib.darkMetal, true];
            case 'hazard':
                return [lib.hazard, false];
            case 'neon-blue':
                return [lib.neonBlue, false];
            case 'neon-orange':
                return [lib.neonOrange, false];
            case 'neon-white':
                return [lib.neonWhite, false];
            case 'machine':
                return [lib.roof, true];
            case 'tank':
                return [lib.painted, true];
            case 'beacon':
                return [lib.beacon, false];
            case 'crane':
                return [lib.painted, false];
            case 'skyline':
                return [lib.skyline, false];
            case 'container':
                return [lib.container, false];
            case 'pole':
                return [lib.darkMetal, false];
            case 'lamp':
                return [lib.lamp, false];
            case 'apron':
                return [lib.apron, false];
            case 'water':
                return [lib.water, false];
            case 'marking':
                return [lib.marking, false];
            case 'girder':
                return [lib.darkMetal, true];
        }
    };
    const signs: DecorSign[] = [];
    for (const item of decor as DecorItem[]) {
        if (item.kind === 'sign') {
            signs.push(item);
            continue;
        }
        const [material, shadows] = materialFor(item.material);
        const batch = batchFor(material, shadows);
        const tint = item.color as Tint | undefined;
        if (item.kind === 'box') {
            const uv: UvMode =
                item.material === 'skyline'
                    ? { kind: 'world', metres: 30 }
                    : item.material === 'water'
                      ? { kind: 'world', metres: 24 }
                      : WORLD4;
            // Skip faces nobody can see (undersides of things standing on the ground).
            const faces = item.min.y <= 0.001 ? 'xXYzZ' : 'xXyYzZ';
            batch.box([item.min.x, item.min.y, item.min.z], [item.max.x, item.max.y, item.max.z], uv, tint, faces);
        } else {
            batch.cylinder(
                [item.base.x, item.base.y, item.base.z],
                item.radius,
                item.height,
                item.radius > 1 ? 20 : 10,
                4,
                tint
            );
        }
    }

    for (const [material, { batch, shadows }] of batches) {
        const mesh = batch.toMesh(device);
        if (!mesh) continue;
        const entity = new Entity(`static-${material.name}`);
        entity.addComponent('render', {
            meshInstances: [new MeshInstance(mesh, material)],
            castShadows: shadows,
            receiveShadows: true
        });
        root.addChild(entity);
    }

    // Team spawn pads: subtle tinted deck with a glowing rim.
    for (const zone of map.spawnZones) {
        const color = TEAM_COLORS[zone.team];
        const pad = new Entity(`spawn-pad-${zone.team}`);
        const padMat = new StandardMaterial();
        padMat.diffuse = new Color(0.16 + color.r * 0.12, 0.16 + color.g * 0.12, 0.17 + color.b * 0.12);
        padMat.emissive = color.clone();
        padMat.emissiveIntensity = 0.035;
        padMat.gloss = 0.5;
        padMat.useMetalness = true;
        padMat.update();
        pad.addComponent('render', { type: 'plane', material: padMat, castShadows: false });
        pad.setLocalScale(zone.max.x - zone.min.x, 1, zone.max.z - zone.min.z);
        pad.setPosition((zone.min.x + zone.max.x) / 2, 0.008, (zone.min.z + zone.max.z) / 2);
        root.addChild(pad);
    }

    app.root.addChild(root);
    const signRenderer = new SignRenderer(app, signs);
    return {
        root,
        materials: lib,
        signs: signRenderer,
        update: (dt, score) => signRenderer.update(dt, score),
        destroy: () => {
            root.destroy();
            signRenderer.destroy();
            lib.destroy();
        }
    };
}
