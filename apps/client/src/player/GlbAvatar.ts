import { DEFAULT_APPEARANCE, appearanceKey } from '@colorfront/shared';
import type { AvatarAppearance, TeamId } from '@colorfront/shared';
import { Entity, MeshInstance, Quat, SkinInstance, Vec3 } from 'playcanvas';
import type { AppBase } from 'playcanvas';

import { LOD_COUNT } from '../avatar/library.ts';
import type { AvatarLibrary, OutfitMeshes } from '../avatar/library.ts';

import type { AvatarView, RigPose } from './AvatarView.ts';

export { AvatarLibrary } from '../avatar/library.ts';

/**
 * Phase 6 GLB avatar ("Neon Courier", assets-src/blender/scripts/build_courier.py).
 *
 * Contract with the GLBs (checked by assets-src/blender/scripts/validate_avatar.py):
 *  - 22 joints named like CharacterRig.ts, identity rest rotations, metres, +Y up, facing -Z;
 *  - arms are bound in an A-pose, so arm IK reads each bone's rest direction from the skeleton;
 *  - `muzzle` node under `gun`; `liquid` joint scales the tank fill (ammo).
 *
 * Wardrobe (Gate 3): the drawn mesh of each LOD is the merged outfit from AvatarLibrary (one opaque
 * + one glass mesh, shared with every avatar wearing the same outfit). Changing clothes swaps the
 * mesh of the existing mesh instances; the skeleton, skin instance and animation state stay.
 * Each avatar owns its skeleton entities and ONE skin instance shared by all its mesh instances.
 */

const DOWN = new Vec3(0, -1, 0);

export class GlbAvatar implements AvatarView {
    readonly root: Entity;
    private readonly lib: AvatarLibrary;
    private readonly bones = new Map<string, Entity>();
    private readonly restPos = new Map<string, Vec3>();
    /** Per LOD: [opaque, glass] mesh instances. */
    private readonly lods: [MeshInstance, MeshInstance][] = [];
    private readonly hasGlass: boolean[] = [];
    private readonly held: (OutfitMeshes | null)[] = [];
    private readonly skinInstance: SkinInstance;
    private readonly muzzleNode: Entity | null;
    private team: TeamId;
    private lod = -1;
    private appearance: AvatarAppearance;
    private wanted = '';
    private destroyed = false;

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

    constructor(app: AppBase, lib: AvatarLibrary, team: TeamId, appearance: AvatarAppearance = DEFAULT_APPEARANCE) {
        this.lib = lib;
        this.team = team;
        this.appearance = { ...appearance };
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
        this.skinInstance = new SkinInstance(lib.skin);
        this.skinInstance.bones = lib.skin.boneNames.map((n) => {
            const b = this.bones.get(n);
            if (!b) throw new Error(`avatar skeleton is missing joint ${n}`);
            return b;
        });
        this.skinInstance.rootBone = rootBone;

        // Start with the requested outfit if it is ready, else the always-ready default.
        const exact = lib.acquire(this.appearance, 0) !== null;
        if (exact) lib.release(`${appearanceKey(this.appearance)}#0`);
        const start = exact ? this.appearance : DEFAULT_APPEARANCE;
        for (let lod = 0; lod < LOD_COUNT; lod++) {
            const om = lib.acquire(start, lod)!;
            this.held.push(om);
            const opaque = new MeshInstance(om.opaque, lib.bodyMaterial(team));
            const glass = new MeshInstance(om.glass ?? om.opaque, lib.glass);
            this.hasGlass.push(om.glass !== null);
            for (const mi of [opaque, glass]) mi.skinInstance = this.skinInstance;
            const e = new Entity(`avatar-lod${lod}`);
            e.addComponent('render', { meshInstances: [opaque, glass], castShadows: lod === 0, receiveShadows: true });
            this.root.addChild(e);
            this.lods.push([opaque, glass]);
        }
        app.root.addChild(this.root);
        // The render component nulls skinInstance before destroying its mesh instances, so the
        // manually created skin instance (bone texture) is released here; outfits are un-held.
        this.root.once('destroy', () => {
            this.destroyed = true;
            this.skinInstance.destroy();
            for (const h of this.held) if (h) this.lib.release(h.key);
            this.held.length = 0;
        });
        this.setLod(0);
        if (!exact) this.setAppearance(this.appearance);
    }

    get currentLod() {
        return this.lod;
    }

    get currentAppearance(): AvatarAppearance {
        return { ...this.appearance };
    }

    /** Triangles drawn at the current LOD (diagnostics). */
    get triangles() {
        return this.held[Math.max(0, this.lod)]?.triangles ?? 0;
    }

    setLod(lod: number) {
        if (lod === this.lod) return;
        this.lod = lod;
        this.lods.forEach(([opaque, glass], i) => {
            opaque.visible = i === lod;
            glass.visible = i === lod && this.hasGlass[i];
            opaque.castShadow = i === 0 && lod === 0;
            glass.castShadow = false;
        });
    }

    setTeam(team: TeamId) {
        if (team === this.team) return;
        this.team = team;
        for (const [opaque] of this.lods) opaque.material = this.lib.bodyMaterial(team);
    }

    /**
     * Change clothes. Loads/merges the outfit if needed (async), then swaps the meshes of the
     * existing mesh instances in one frame. The latest request wins.
     */
    setAppearance(a: AvatarAppearance): Promise<void> {
        const key = appearanceKey(a);
        this.wanted = key;
        return this.lib.prepare(a).then(
            () => {
                if (this.destroyed || this.wanted !== key) return;
                const next = [0, 1, 2].map((lod) => this.lib.acquire(a, lod)!);
                next.forEach((om, lod) => {
                    const [opaque, glass] = this.lods[lod];
                    opaque.mesh = om.opaque;
                    if (om.glass) glass.mesh = om.glass;
                    this.hasGlass[lod] = om.glass !== null;
                });
                for (const h of this.held) if (h) this.lib.release(h.key);
                this.held.splice(0, this.held.length, ...next);
                this.appearance = { ...a };
                const lod = this.lod;
                this.lod = -1;
                this.setLod(lod);
            },
            (err: unknown) => console.warn('[avatar] outfit unavailable, keeping the current one:', err)
        );
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
