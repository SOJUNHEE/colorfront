import type { TeamId } from '@colorfront/shared';
import { Asset, Entity, MeshInstance, Quat, SkinInstance, Texture, Vec3 } from 'playcanvas';
import type { AppBase, ContainerResource, Material, Mesh, StandardMaterial } from 'playcanvas';

import type { AvatarView, RigPose } from './AvatarView.ts';

/**
 * Phase 6 GLB avatar ("Neon Courier", assets-src/blender/scripts/build_courier.py).
 *
 * Contract with the GLB (checked by assets-src/blender/scripts/validate_avatar.py):
 *  - 22 joints named like CharacterRig.ts, identity rest rotations, metres, +Y up, facing -Z;
 *  - arms are bound in an A-pose, so arm IK reads each bone's rest direction from the skeleton;
 *  - `muzzle` node under `gun`; `liquid` joint scales the tank fill (ammo);
 *  - material `cf_body` (palette/face atlas, team colours baked per team atlas) + `cf_glass`.
 *
 * Sharing: meshes and materials are loaded once (AvatarLibrary) and shared by every avatar.
 * Each avatar owns its skeleton entities and one SkinInstance per LOD mesh, so different players
 * never share a pose. Only the LOD0 skeleton is animated; LOD1/LOD2 meshes are bound to it.
 * Team changes swap to a cached per-team material (no vertex buffer writes).
 */

type Part = { mesh: Mesh; material: Material };

const LOD_FILES = ['courier_default_lod0.glb', 'courier_default_lod1.glb', 'courier_default_lod2.glb'];

function loadAsset(app: AppBase, name: string, type: string, url: string): Promise<Asset> {
    return new Promise((resolve, reject) => {
        const asset = new Asset(name, type, { url });
        asset.once('load', () => resolve(asset));
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

/** Shared, loaded-once avatar resources. */
export class AvatarLibrary {
    /** Bone hierarchy (incl. `muzzle`) without any render component; cloned per avatar. */
    readonly skeleton: Entity;
    /** Mesh/material pairs per LOD (index 0..2). */
    readonly parts: Part[][];
    private readonly teamMats = new Map<Material, Material>();

    private constructor(skeleton: Entity, parts: Part[][]) {
        this.skeleton = skeleton;
        this.parts = parts;
    }

    static async load(app: AppBase, base = '/assets/characters/'): Promise<AvatarLibrary> {
        const assets = await Promise.all(LOD_FILES.map((f) => loadAsset(app, f, 'container', base + f)));
        let skeleton: Entity | null = null;
        const parts = assets.map((a, lod) => {
            const res = a.resource as ContainerResource;
            const tmp = res.instantiateRenderEntity();
            const out: Part[] = [];
            for (const r of tmp.findComponents('render')) {
                for (const mi of (r as unknown as { meshInstances: MeshInstance[] }).meshInstances) {
                    if (mi.mesh && mi.material) out.push({ mesh: mi.mesh, material: mi.material });
                    // Release the engine-created (cached) skin instance's bone texture now.
                    mi.skinInstance?.destroy();
                }
                (r.entity as Entity).removeComponent('render');
            }
            if (lod === 0) skeleton = tmp;
            else tmp.destroy();
            return out;
        });
        // Every LOD GLB embeds the same atlas/ORM/emissive textures. Use LOD0's materials for all
        // LODs so the duplicates are never uploaded to the GPU (~25 MB VRAM saved).
        const byName = new Map(parts[0].map((p) => [p.material.name, p.material] as const));
        for (const lodParts of parts.slice(1)) {
            for (const p of lodParts) p.material = byName.get(p.material.name) ?? p.material;
        }
        const lib = new AvatarLibrary(skeleton!, parts);
        await lib.prepareTeam(app, base);
        return lib;
    }

    /** The GLBs embed the blue atlas; build the orange body material once (shared). */
    private async prepareTeam(app: AppBase, base: string) {
        const [atlas, emissive] = await Promise.all([
            loadImage(`${base}courier_atlas_orange.png`),
            loadImage(`${base}courier_emissive_orange.png`)
        ]);
        const make = (img: HTMLImageElement, like: Texture | null) => {
            const t = new Texture(app.graphicsDevice, {
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
        for (const lod of this.parts) {
            for (const p of lod) {
                const m = p.material as StandardMaterial;
                if (this.teamMats.has(m) || !m.diffuseMap) continue;
                const o = m.clone();
                o.diffuseMap = make(atlas, m.diffuseMap);
                if (m.emissiveMap) o.emissiveMap = make(emissive, m.emissiveMap);
                o.update();
                this.teamMats.set(m, o);
            }
        }
    }

    material(base: Material, team: TeamId): Material {
        return team === 'orange' ? (this.teamMats.get(base) ?? base) : base;
    }
}

const DOWN = new Vec3(0, -1, 0);

export class GlbAvatar implements AvatarView {
    readonly root: Entity;
    private readonly lib: AvatarLibrary;
    private readonly bones = new Map<string, Entity>();
    private readonly restPos = new Map<string, Vec3>();
    private readonly lods: MeshInstance[][] = [];
    private readonly skins: SkinInstance[] = [];
    private readonly muzzleNode: Entity | null;
    private team: TeamId;
    private lod = -1;

    // Animation state (same model as the legacy CharacterRig, tuned for the new proportions).
    private phase = 0;
    private recoil = 0;
    private flinch = 0;
    private landSquash = 0;
    private wasGrounded = true;
    private spawnScale = 1;
    private victory = 0;
    private lean = 0;
    private hipTwist = 0;
    private time = 0;
    private readonly tmpQ = new Quat();
    private readonly tmpV = new Vec3();
    private readonly tmpV2 = new Vec3();

    constructor(app: AppBase, lib: AvatarLibrary, team: TeamId) {
        this.lib = lib;
        this.team = team;
        this.root = new Entity('avatar');
        // Own copy of the skeleton (plain entities, no render components).
        const inst = lib.skeleton.clone() as Entity;
        this.root.addChild(inst);
        const walk = (e: Entity) => {
            this.bones.set(e.name, e);
            this.restPos.set(e.name, e.getLocalPosition().clone());
            for (const c of e.children) walk(c as Entity);
        };
        walk(inst);
        this.muzzleNode = this.bones.get('muzzle') ?? null;
        const rootBone = this.bones.get('root') ?? inst;
        // One skin instance (bone palette) per avatar, shared by every LOD/primitive whose skin
        // has the same joint order (all LODs come from one armature). Others get their own.
        const shared = new Map<string, SkinInstance>();
        const skinFor = (mesh: Mesh) => {
            const skin = mesh.skin!;
            const key = skin.boneNames.join(',');
            let si = shared.get(key);
            if (!si) {
                si = new SkinInstance(skin);
                si.bones = skin.boneNames.map((n) => this.bones.get(n)!);
                si.rootBone = rootBone;
                shared.set(key, si);
                this.skins.push(si);
            }
            return si;
        };
        lib.parts.forEach((parts, i) => {
            const instances = parts.map((p) => {
                const mi = new MeshInstance(p.mesh, lib.material(p.material, team));
                mi.skinInstance = skinFor(p.mesh);
                return mi;
            });
            const e = new Entity(`avatar-lod${i}`);
            e.addComponent('render', { meshInstances: instances, castShadows: i === 0, receiveShadows: true });
            this.root.addChild(e);
            this.lods.push(instances);
        });
        app.root.addChild(this.root);
        // The render component nulls skinInstance before destroying its mesh instances, so
        // manually created skin instances (bone textures) must be released here.
        this.root.once('destroy', () => {
            for (const si of this.skins) si.destroy();
            this.skins.length = 0;
        });
        this.setLod(0);
    }

    get currentLod() {
        return this.lod;
    }

    setLod(lod: number) {
        if (lod === this.lod) return;
        this.lod = lod;
        this.lods.forEach((mis, i) => {
            for (const mi of mis) {
                mi.visible = i === lod;
                mi.castShadow = i === 0 && lod === 0;
            }
        });
    }

    setTeam(team: TeamId) {
        if (team === this.team) return;
        this.team = team;
        this.lib.parts.forEach((parts, i) => {
            parts.forEach((p, k) => {
                this.lods[i][k].material = this.lib.material(p.material, team);
            });
        });
    }

    setVisible(v: boolean) {
        this.root.enabled = v;
    }

    muzzle(out: Vec3): Vec3 {
        if (this.muzzleNode) return out.copy(this.muzzleNode.getPosition());
        const gun = this.bone('gun');
        gun.getWorldTransform().transformPoint(this.tmpV.set(0, 0.03, -0.64), out);
        return out;
    }

    fired() {
        this.recoil = 1;
    }

    hit() {
        this.flinch = 1;
    }

    respawned() {
        this.spawnScale = 0;
    }

    celebrate(on: boolean) {
        this.victory = on ? Math.max(this.victory, 0.001) : 0;
    }

    private bone(name: string): Entity {
        const b = this.bones.get(name);
        if (!b) throw new Error(`avatar bone missing: ${name}`);
        return b;
    }

    private rest(name: string): Vec3 {
        return this.restPos.get(name)!;
    }

    /**
     * Two-bone IK. Bones have identity rest rotations, so a bone's rest direction is the local
     * offset of its child (A-pose arms are not straight down, unlike the legacy rig).
     */
    private reach(side: 'L' | 'R', target: Vec3, pole: Vec3) {
        const upper = this.bone(`upperArm${side}`);
        const fore = this.bone(`foreArm${side}`);
        const hand = this.bone(`hand${side}`);
        const a = this.rest(`foreArm${side}`).length();
        const b = this.rest(`hand${side}`).length();
        const s = upper.getPosition().clone();
        const toT = this.tmpV.sub2(target, s);
        let dist = toT.length();
        dist = Math.max(0.05, Math.min(a + b - 0.005, dist));
        const u = toT.normalize();
        const cosA = (a * a + dist * dist - b * b) / (2 * a * dist);
        const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
        const w = this.tmpV2
            .copy(pole)
            .sub(u.clone().mulScalar(pole.dot(u)))
            .normalize();
        const elbow = new Vec3()
            .copy(s)
            .add(u.clone().mulScalar(cosA * a))
            .add(w.mulScalar(sinA * a));
        const handPos = new Vec3().copy(s).add(u.clone().mulScalar(dist));
        const restUpper = this.rest(`foreArm${side}`).clone().normalize();
        const restFore = this.rest(`hand${side}`).clone().normalize();
        upper.setRotation(new Quat().setFromDirections(restUpper, new Vec3().sub2(elbow, s).normalize()));
        fore.setRotation(new Quat().setFromDirections(restFore, new Vec3().sub2(handPos, elbow).normalize()));
        hand.setLocalEulerAngles(0, 0, 0);
    }

    update(dt: number, pose: RigPose, cameraDistance: number, lodDistance: number) {
        this.time += dt;
        this.setLod(cameraDistance > lodDistance * 2.5 ? 2 : cameraDistance > lodDistance ? 1 : 0);
        const far = cameraDistance > lodDistance * 1.6;

        const speed = Math.hypot(pose.vx, pose.vz);
        const yawDeg = (pose.yaw * 180) / Math.PI;
        this.spawnScale = Math.min(1, this.spawnScale + dt * 3.5);
        const sc = 0.2 + 0.8 * (1 - Math.pow(1 - this.spawnScale, 3));
        this.root.setPosition(pose.x, pose.y, pose.z);
        this.root.setEulerAngles(0, yawDeg, 0);
        this.root.setLocalScale(sc, sc * (1 + (1 - this.spawnScale) * 0.3), sc);

        const fx = -Math.sin(pose.yaw);
        const fz = -Math.cos(pose.yaw);
        const rx = Math.cos(pose.yaw);
        const rz = -Math.sin(pose.yaw);
        const fwd = pose.vx * fx + pose.vz * fz;
        const side = pose.vx * rx + pose.vz * rz;

        if (pose.grounded && !this.wasGrounded) this.landSquash = 1;
        this.wasGrounded = pose.grounded;
        this.landSquash = Math.max(0, this.landSquash - dt * 5);
        this.recoil = Math.max(0, this.recoil - dt * 12);
        this.flinch = Math.max(0, this.flinch - dt * 4);
        if (this.victory > 0) this.victory += dt;

        const run = Math.min(1, speed / 8);
        if (pose.grounded) this.phase += (speed / 1.25) * Math.PI * dt;
        const swing = Math.sin(this.phase);
        const swing2 = Math.sin(this.phase * 2);
        const moving = Math.min(1, speed / 2);
        const back = fwd < -0.5 ? -1 : 1;

        const hipsRest = this.rest('hips');
        const targetTwist = speed > 1 ? Math.atan2(side, Math.abs(fwd) + 0.01) * 0.55 * back : 0;
        this.hipTwist += (targetTwist - this.hipTwist) * Math.min(1, dt * 10);
        const bob = pose.grounded ? -Math.abs(swing2) * 0.035 * moving - this.landSquash * 0.09 : 0;
        const breathe = Math.sin(this.time * 2.2) * 0.006 * (1 - moving);
        this.bone('hips').setLocalPosition(hipsRest.x, hipsRest.y + bob + breathe, hipsRest.z);
        this.bone('hips').setLocalEulerAngles(0, (this.hipTwist * 180) / Math.PI, swing * 3 * moving);

        const targetLean = pose.dashing ? 22 : Math.max(-8, Math.min(14, fwd * 1.6));
        this.lean += (targetLean - this.lean) * Math.min(1, dt * 8);
        const aimPitch = (pose.pitch * 180) / Math.PI;
        const flinch = this.flinch * 18;
        this.bone('spine').setLocalEulerAngles(
            -this.lean * 0.5 - aimPitch * 0.25 + flinch * 0.4,
            ((-this.hipTwist * 180) / Math.PI) * 0.6,
            0
        );
        this.bone('chest').setLocalEulerAngles(
            -this.lean * 0.35 - aimPitch * 0.25 + flinch + this.recoil * 3 + breathe * 60,
            ((-this.hipTwist * 180) / Math.PI) * 0.4,
            0
        );
        this.bone('head').setLocalEulerAngles(-aimPitch * 0.3 + this.lean * 0.5 - flinch * 0.5, 0, 0);

        this.bone('liquid').setLocalScale(1, Math.max(0.02, pose.ammo), 1);

        const legAmp = pose.dashing ? 55 : 22 + 18 * run;
        for (const s of ['L', 'R'] as const) {
            const sgn = s === 'L' ? 1 : -1;
            let hip: number;
            let knee: number;
            if (!pose.grounded) {
                const tuck = pose.vy > 0 ? 1 : Math.max(0, 1 + pose.vy * 0.15);
                hip = -35 * tuck + (s === 'L' ? -10 : 15);
                knee = 60 * tuck + 10;
            } else if (pose.dashing) {
                hip = sgn * 40;
                knee = 20 + (sgn > 0 ? 50 : 10);
            } else {
                const ph = swing * sgn * back;
                hip = -ph * legAmp * moving;
                knee =
                    (Math.max(0, -Math.cos(this.phase + (sgn > 0 ? 0 : Math.PI))) * (30 + 40 * run) + 4) * moving +
                    this.landSquash * 40 +
                    3;
            }
            this.bone(`thigh${s}`).setLocalEulerAngles(hip - this.lean * 0.3 + this.landSquash * -30, 0, sgn * 3);
            this.bone(`shin${s}`).setLocalEulerAngles(knee, 0, 0);
            this.bone(`foot${s}`).setLocalEulerAngles(-(hip + knee) * 0.35, 0, 0);
        }

        const gun = this.bone('gun');
        const gunRest = this.rest('gun');
        const reloading = pose.reload >= 0;
        const rl = reloading ? Math.sin(Math.min(1, pose.reload) * Math.PI) : 0;
        gun.setLocalPosition(
            gunRest.x - (pose.aiming ? 0.04 : 0),
            gunRest.y + (pose.aiming ? 0.03 : 0),
            gunRest.z + this.recoil * 0.07 - (pose.aiming ? 0.05 : 0)
        );
        const victoryUp = this.victory > 0 ? 70 : 0;
        this.tmpQ.setFromEulerAngles(aimPitch + this.recoil * 7 - rl * 35 + victoryUp, yawDeg + rl * 25, rl * 20);
        gun.setRotation(this.tmpQ);

        if (!far) {
            const gm = gun.getWorldTransform();
            const grip = gm.transformPoint(new Vec3(0, -0.08, 0.02), new Vec3());
            const fore = gm.transformPoint(new Vec3(0, -0.04, -0.3), new Vec3());
            const poleR = new Vec3(rx * 0.8, -1, rz * 0.8).normalize();
            const poleL = new Vec3(-rx * 0.8, -1, -rz * 0.8).normalize();
            this.reach('R', grip, poleR);
            if (reloading) {
                const tank = this.bone('liquid').getPosition().clone();
                const t = Math.sin(Math.min(1, pose.reload) * Math.PI);
                this.reach('L', new Vec3().lerp(fore, tank, t), poleL);
            } else if (this.victory > 0) {
                const s = this.bone('shoulderL').getPosition();
                this.reach(
                    'L',
                    new Vec3(s.x - rx * 0.1, s.y + 0.45 + Math.sin(this.victory * 8) * 0.05, s.z - rz * 0.1),
                    new Vec3(-rx, 0, -rz)
                );
            } else this.reach('L', fore, poleL);
        } else {
            // Far away: no IK, arms hang down along the body.
            for (const s of ['L', 'R'] as const) {
                const restDir = this.rest(`foreArm${s}`).clone().normalize();
                this.bone(`upperArm${s}`).setLocalRotation(new Quat().setFromDirections(restDir, DOWN));
            }
        }

        if (this.victory > 0) {
            const hop = Math.abs(Math.sin(this.victory * 5)) * 0.25;
            this.root.setPosition(pose.x, pose.y + hop, pose.z);
        }
    }
}
