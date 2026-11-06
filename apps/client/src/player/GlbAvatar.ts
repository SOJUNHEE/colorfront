import { DEFAULT_APPEARANCE, appearanceKey } from '@colorfront/shared';
import type { AvatarAppearance, TeamId, WeaponId } from '@colorfront/shared';
import { Entity, MeshInstance, Quat, SkinInstance, Vec3 } from 'playcanvas';
import type { AppBase } from 'playcanvas';

import { ANIM_BONES, AnimState, HIPS, PoseMixer } from '../avatar/anim.ts';
import type { AnimInput } from '../avatar/anim.ts';
import { WEAPON_MODELS } from '../avatar/catalog.ts';
import { EXPRESSIONS, LOD_COUNT } from '../avatar/library.ts';
import type { AvatarLibrary, Expression, OutfitKey, OutfitMeshes } from '../avatar/library.ts';

import type { AvatarView, RigPose } from './AvatarView.ts';

export { AvatarLibrary } from '../avatar/library.ts';

/**
 * Phase 6 GLB avatar ("Neon Courier", assets-src/blender/scripts/build_courier.py).
 *
 * Contract with the GLBs (checked by assets-src/blender/scripts/validate_avatar.py):
 *  - 22 joints named like CharacterRig.ts, identity rest rotations, metres, +Y up, facing -Z;
 *  - arms are bound in an A-pose, so arm IK reads each bone's rest direction from the skeleton;
 *  - `gun` joint carries the weapon model; `liquid` joint scales the tank fill (ammo).
 *
 * The drawn mesh of each LOD is the merged look from AvatarLibrary: outfit + colours + team +
 * carried weapon (one opaque + one glass mesh, shared with every avatar that looks the same).
 * Changing clothes, team or weapon swaps the mesh of the existing mesh instances; the skeleton,
 * skin instance and animation state stay. Each avatar owns its skeleton and ONE skin instance.
 */

const DOWN = new Vec3(0, -1, 0);
/** How the aim pitch is shared along the upper body (same split as the legacy rig). */
const AIM_SHARE: readonly [string, number][] = [
    ['spine', 0.25],
    ['chest', 0.25],
    ['head', 0.3]
];

export class GlbAvatar implements AvatarView {
    readonly root: Entity;
    private readonly lib: AvatarLibrary;
    private readonly bones = new Map<string, Entity>();
    private readonly restPos = new Map<string, Vec3>();
    /** Per LOD: [opaque, glass] mesh instances. */
    private readonly lods: [MeshInstance, MeshInstance][] = [];
    private readonly hasGlass: boolean[] = [];
    /** LOD0 face (expression tiles); null if the look has no separate face mesh. */
    private faceMesh!: MeshInstance;
    private expr: Expression = 'neutral';
    private exprHold = 0;
    private nextBlink = 2 + Math.random() * 3;
    private readonly held: (OutfitMeshes | null)[] = [];
    private readonly skinInstance: SkinInstance;
    private lod = -1;
    /** What is drawn now, and what was asked for last (may still be loading). */
    private shown: OutfitKey;
    private wanted: OutfitKey;
    private wantedId = '';
    private destroyed = false;

    // Animation: keyframed clips (avatar/anim.ts) + IK/aim/secondary motion on top.
    private readonly anim = new AnimState();
    private readonly mix: PoseMixer;
    private readonly animBones: Entity[];
    private animDt = 0;
    private animFrame = 0;
    private recoil = 0;
    private spawnScale = 1;
    private victory = 0;
    private time = 0;
    private prevForward = 0;
    private prevRight = 0;
    private readonly slosh = { x: 0, y: 0 };
    private readonly sloshV = { x: 0, y: 0 };
    private readonly tmpQ = new Quat();
    private readonly tmpQ2 = new Quat();
    private readonly tmpV = new Vec3();
    private readonly tmpV2 = new Vec3();

    constructor(app: AppBase, lib: AvatarLibrary, team: TeamId, appearance: AvatarAppearance = DEFAULT_APPEARANCE, weapon: WeaponId = 'paint-rifle') {
        this.lib = lib;
        this.root = new Entity('avatar');
        const inst = lib.skeleton.clone() as Entity;
        this.root.addChild(inst);
        const walk = (e: Entity) => {
            this.bones.set(e.name, e);
            this.restPos.set(e.name, e.getLocalPosition().clone());
            for (const c of e.children) walk(c as Entity);
        };
        walk(inst);
        const rootBone = this.bones.get('root') ?? inst;
        this.skinInstance = new SkinInstance(lib.skin);
        this.skinInstance.bones = lib.skin.boneNames.map((n) => {
            const b = this.bones.get(n);
            if (!b) throw new Error(`avatar skeleton is missing joint ${n}`);
            return b;
        });
        this.skinInstance.rootBone = rootBone;
        this.mix = new PoseMixer(lib.clips);
        this.animBones = ANIM_BONES.map((n) => this.bones.get(n)!);
        this.animFrame = Math.floor(Math.random() * 3); // stagger reduced-rate updates

        // Start with the requested look if it is ready, else the always-ready default for the team.
        this.wanted = { appearance: { ...appearance }, team, weapon };
        const ready = lib.acquire(this.wanted, 0);
        if (ready) lib.release(ready.key);
        this.shown = ready ? this.wanted : { appearance: DEFAULT_APPEARANCE, team, weapon: 'paint-rifle' };
        for (let lod = 0; lod < LOD_COUNT; lod++) {
            const om = lib.acquire(this.shown, lod)!;
            this.held.push(om);
            const opaque = new MeshInstance(om.opaque, lib.body);
            const glass = new MeshInstance(om.glass ?? om.opaque, lib.glass);
            this.hasGlass.push(om.glass !== null);
            for (const mi of [opaque, glass]) mi.skinInstance = this.skinInstance;
            const e = new Entity(`avatar-lod${lod}`);
            const instances = [opaque, glass];
            if (lod === 0) {
                this.faceMesh = new MeshInstance(om.faces?.[0] ?? om.opaque, lib.body);
                this.faceMesh.skinInstance = this.skinInstance;
                instances.push(this.faceMesh);
            }
            e.addComponent('render', { meshInstances: instances, castShadows: lod === 0, receiveShadows: true });
            this.root.addChild(e);
            this.lods.push([opaque, glass]);
        }
        app.root.addChild(this.root);
        // The render component nulls skinInstance before destroying its mesh instances, so the
        // manually created skin instance (bone texture) is released here; looks are un-held.
        this.root.once('destroy', () => {
            this.destroyed = true;
            this.skinInstance.destroy();
            for (const h of this.held) if (h) this.lib.release(h.key);
            this.held.length = 0;
        });
        this.setLod(0);
        if (!ready) void this.request(this.wanted);
    }

    get currentLod() {
        return this.lod;
    }

    get currentAppearance(): AvatarAppearance {
        return { ...this.shown.appearance };
    }

    get currentWeapon(): WeaponId {
        return this.shown.weapon;
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
        this.faceMesh.visible = lod === 0 && !!this.held[0]?.faces;
        this.faceMesh.castShadow = false;
    }

    setTeam(team: TeamId) {
        if (team === this.wanted.team) return;
        void this.request({ ...this.wanted, team });
    }

    setAppearance(a: AvatarAppearance): Promise<void> {
        return this.request({ ...this.wanted, appearance: { ...a } });
    }

    setWeapon(weapon: WeaponId) {
        if (weapon === this.wanted.weapon) return;
        void this.request({ ...this.wanted, weapon });
    }

    /**
     * Load/merge the look if needed (async), then swap the meshes of the existing mesh instances
     * in one frame. The latest request wins.
     */
    private request(k: OutfitKey): Promise<void> {
        this.wanted = k;
        const id = `${appearanceKey(k.appearance)}|${k.team}|${k.weapon}`;
        this.wantedId = id;
        return this.lib.prepare(k).then(
            () => {
                if (this.destroyed || this.wantedId !== id) return;
                const next = [0, 1, 2].map((lod) => this.lib.acquire(k, lod)!);
                next.forEach((om, lod) => {
                    const [opaque, glass] = this.lods[lod];
                    opaque.mesh = om.opaque;
                    if (om.glass) glass.mesh = om.glass;
                    this.hasGlass[lod] = om.glass !== null;
                    if (lod === 0 && om.faces) this.faceMesh.mesh = om.faces[EXPRESSIONS.indexOf(this.expr)];
                });
                for (const h of this.held) if (h) this.lib.release(h.key);
                this.held.splice(0, this.held.length, ...next);
                this.shown = k;
                const lod = this.lod;
                this.lod = -1;
                this.setLod(lod);
            },
            (err: unknown) => console.warn('[avatar] look unavailable, keeping the current one:', err)
        );
    }

    setVisible(v: boolean) {
        this.root.enabled = v;
    }

    /** Nozzle of the drawn weapon model (visual only; shots are traced by the simulation). */
    muzzle(out: Vec3): Vec3 {
        const [x, y, z] = WEAPON_MODELS[this.shown.weapon].muzzle;
        this.bone('gun').getWorldTransform().transformPoint(this.tmpV.set(x, y, z), out);
        return out;
    }

    fired() {
        this.recoil = 1;
        this.anim.fired();
    }

    hit() {
        this.anim.hit();
        this.expression('surprised', 0.6);
    }

    /** Show an expression for `hold` seconds (then back to neutral / blinking). */
    expression(e: Expression, hold: number) {
        this.exprHold = hold;
        this.setExpr(e);
    }

    get currentExpression(): Expression {
        return this.expr;
    }

    private setExpr(e: Expression) {
        if (e === this.expr) return;
        this.expr = e;
        const faces = this.held[0]?.faces;
        if (faces) this.faceMesh.mesh = faces[EXPRESSIONS.indexOf(e)];
    }

    /** Victory smile, hit surprise, otherwise neutral with a blink every few seconds. */
    private updateFace(dt: number, far: boolean) {
        if (far) return;
        if (this.exprHold > 0) {
            this.exprHold -= dt;
            if (this.exprHold > 0) return;
        }
        if (this.victory > 0) return this.setExpr('happy');
        this.nextBlink -= dt;
        if (this.nextBlink <= 0) {
            this.nextBlink = 2.2 + Math.random() * 3.5;
            this.exprHold = 0.12;
            return this.setExpr('blink');
        }
        this.setExpr('neutral');
    }

    respawned() {
        this.spawnScale = 0;
        this.anim.respawned();
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

        const yawDeg = (pose.yaw * 180) / Math.PI;
        this.spawnScale = Math.min(1, this.spawnScale + dt * 5);
        const sc = 0.55 + 0.45 * (1 - Math.pow(1 - this.spawnScale, 3));
        this.root.setPosition(pose.x, pose.y, pose.z);
        this.root.setEulerAngles(0, yawDeg, 0);
        this.root.setLocalScale(sc, sc, sc);

        const fx = -Math.sin(pose.yaw);
        const fz = -Math.cos(pose.yaw);
        const rx = Math.cos(pose.yaw);
        const rz = -Math.sin(pose.yaw);
        const forward = pose.vx * fx + pose.vz * fz;
        const right = pose.vx * rx + pose.vz * rz;
        this.recoil = Math.max(0, this.recoil - dt * 12);
        const aimPitch = (pose.pitch * 180) / Math.PI;

        // Keyframed clips (base + upper layer). Far avatars evaluate every 2nd/3rd frame (their
        // bones keep the last pose in between).
        this.animDt += dt;
        const every = this.lod >= 2 ? 3 : this.lod === 1 ? 2 : 1;
        if (++this.animFrame % every === 0) {
            const input: AnimInput = {
                forward,
                right,
                vy: pose.vy,
                grounded: pose.grounded,
                dashing: pose.dashing,
                aiming: pose.aiming,
                reload: pose.reload,
                victory: this.victory > 0
            };
            this.anim.step(this.animDt, input, this.mix, this.rest('hips'), !far);
            this.animDt = 0;
            const r = this.mix.rot;
            this.animBones.forEach((bone, i) => bone.setLocalRotation(r[i * 4], r[i * 4 + 1], r[i * 4 + 2], r[i * 4 + 3]));
            this.animBones[HIPS].setLocalPosition(this.mix.pos[0], this.mix.pos[1], this.mix.pos[2]);
            // Aim pitch is shared by spine, chest and head on top of the clips (additive).
            for (const [name, k] of AIM_SHARE) {
                const bone = this.bone(name);
                this.tmpQ.setFromEulerAngles(-aimPitch * k, 0, 0);
                bone.setLocalRotation(this.tmpQ2.copy(bone.getLocalRotation()).mul(this.tmpQ));
            }
        }
        if (this.victory > 0) this.victory += dt;

        // Secondary motion: the paint in the tank sloshes against acceleration (spring), near only.
        const liquid = this.bone('liquid');
        if (!far && dt > 0) {
            const af = (forward - this.prevForward) / dt;
            const ar = (right - this.prevRight) / dt;
            const k = 140;
            const c = 7;
            this.sloshV.x += (-k * this.slosh.x - c * this.sloshV.x - af * 0.6) * dt;
            this.sloshV.y += (-k * this.slosh.y - c * this.sloshV.y + ar * 0.6) * dt;
            this.slosh.x = Math.max(-14, Math.min(14, this.slosh.x + this.sloshV.x * dt));
            this.slosh.y = Math.max(-14, Math.min(14, this.slosh.y + this.sloshV.y * dt));
            liquid.setLocalEulerAngles(this.slosh.x, 0, this.slosh.y);
        }
        this.prevForward = forward;
        this.prevRight = right;
        liquid.setLocalScale(1, Math.max(0.02, pose.ammo), 1);

        // Weapon: carried per model (hold offset), aimed at the camera pitch, kicks on fire.
        const hold = WEAPON_MODELS[this.shown.weapon];
        const gun = this.bone('gun');
        const gunRest = this.rest('gun');
        const reloading = pose.reload >= 0;
        const rl = reloading ? Math.sin(Math.min(1, pose.reload) * Math.PI) : 0;
        gun.setLocalPosition(
            gunRest.x + hold.offset[0] - (pose.aiming ? 0.04 : 0),
            gunRest.y + hold.offset[1] + (pose.aiming ? 0.03 : 0),
            gunRest.z + hold.offset[2] + this.recoil * 0.07 - (pose.aiming ? 0.05 : 0)
        );
        const victoryUp = this.victory > 0 ? 70 : 0;
        this.tmpQ.setFromEulerAngles(aimPitch + this.recoil * 7 - rl * 35 + victoryUp, yawDeg + rl * 25, rl * 20);
        gun.setRotation(this.tmpQ);

        if (!far) {
            const gm = gun.getWorldTransform();
            const grip = gm.transformPoint(this.tmpV.set(hold.grip[0], hold.grip[1], hold.grip[2]), new Vec3());
            const fore = gm.transformPoint(this.tmpV.set(hold.fore[0], hold.fore[1], hold.fore[2]), new Vec3());
            const poleR = new Vec3(rx * 0.8, -1, rz * 0.8).normalize();
            const poleL = new Vec3(-rx * 0.8, -1, -rz * 0.8).normalize();
            this.reach('R', grip, poleR);
            if (reloading) {
                const tank = liquid.getPosition().clone();
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
        this.updateFace(dt, far);
    }
}
