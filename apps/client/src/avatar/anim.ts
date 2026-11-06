import type { AnimTrack } from 'playcanvas';

/**
 * Keyframed animation clips authored in Blender (assets-src/blender/scripts/build_anims.py,
 * exported to characters/courier_anims.glb) and a small sampler/mixer for them.
 *
 * Why not the engine's anim state graph: locomotion here advances by DISTANCE travelled
 * (phase += speed * dt / stride) so the feet follow the server-driven ground speed at any speed,
 * the base layer blends 7 clips by velocity direction, and far avatars evaluate at a reduced rate.
 * The clips themselves are real keyframes from the GLB; nothing is synthesised from sine waves.
 *
 * Layers
 *  - base  (absolute local rotations + hips position): idle, jog, run, jog_back, strafe_L/R, dash,
 *          jump_start, jump_air, land, respawn, victory
 *  - upper (deltas from the identity rest pose, applied on top): aim, fire, reload, hit
 * Arms, gun and tank are never keyed (two-bone IK keeps the hands on the weapon at runtime).
 */

export type ClipName =
    | 'idle'
    | 'jog'
    | 'run'
    | 'jog_back'
    | 'strafe_R'
    | 'strafe_L'
    | 'dash'
    | 'jump_start'
    | 'jump_air'
    | 'land'
    | 'aim'
    | 'fire'
    | 'reload'
    | 'hit'
    | 'respawn'
    | 'victory';

export type ClipInfo = { duration: number; loop: boolean; layer: 'base' | 'upper'; stride: number | null; bones: readonly string[] };

const LEGS = ['thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR'] as const;
const UPPER = ['spine', 'chest', 'neck', 'head'] as const;
const FULL = ['hips', ...UPPER, ...LEGS] as const;

/** Must match assets-src/blender/anim_clips.json (a unit test compares them). */
export const ANIM_CLIPS: Readonly<Record<ClipName, ClipInfo>> = {
    idle: { duration: 2.4, loop: true, layer: 'base', stride: null, bones: FULL },
    jog: { duration: 0.5, loop: true, layer: 'base', stride: 3.0, bones: FULL },
    run: { duration: 0.44, loop: true, layer: 'base', stride: 3.52, bones: FULL },
    jog_back: { duration: 0.5, loop: true, layer: 'base', stride: 3.0, bones: FULL },
    strafe_R: { duration: 0.5, loop: true, layer: 'base', stride: 3.0, bones: FULL },
    strafe_L: { duration: 0.5, loop: true, layer: 'base', stride: 3.0, bones: FULL },
    dash: { duration: 0.2, loop: true, layer: 'base', stride: null, bones: FULL },
    jump_start: { duration: 0.16, loop: false, layer: 'base', stride: null, bones: FULL },
    jump_air: { duration: 0.9, loop: true, layer: 'base', stride: null, bones: FULL },
    land: { duration: 0.42, loop: false, layer: 'base', stride: null, bones: FULL },
    aim: { duration: 0.5, loop: true, layer: 'upper', stride: null, bones: UPPER },
    fire: { duration: 0.16, loop: false, layer: 'upper', stride: null, bones: UPPER },
    reload: { duration: 1.0, loop: false, layer: 'upper', stride: null, bones: UPPER },
    hit: { duration: 0.36, loop: false, layer: 'upper', stride: null, bones: UPPER },
    respawn: { duration: 0.7, loop: false, layer: 'base', stride: null, bones: FULL },
    victory: { duration: 0.9, loop: true, layer: 'base', stride: null, bones: FULL }
};

/** Bones driven by the clips, in a fixed order (index = slot in pose buffers). */
export const ANIM_BONES: readonly string[] = FULL;
const BONE_INDEX = new Map(ANIM_BONES.map((b, i) => [b, i]));
const UPPER_INDICES = UPPER.map((b) => BONE_INDEX.get(b)!);
export const HIPS = BONE_INDEX.get('hips')!;

type Channel = { times: Float32Array; values: Float32Array };
type Clip = { info: ClipInfo; rot: (Channel | null)[]; pos: Channel | null };

function toF32(a: ArrayLike<number>): Float32Array {
    return a instanceof Float32Array ? a : Float32Array.from(a);
}

/** Linear sample of an n-component channel at time t (clamped). Quaternions: nlerp (normalised later). */
function sample(ch: Channel, n: number, t: number, out: number[]) {
    const ts = ch.times;
    const last = ts.length - 1;
    let i = 0;
    if (t <= ts[0]) i = 0;
    else if (t >= ts[last]) i = last;
    else {
        let lo = 0;
        let hi = last;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (ts[mid] <= t) lo = mid;
            else hi = mid;
        }
        const f = (t - ts[lo]) / (ts[hi] - ts[lo]);
        const v = ch.values;
        // Quaternion keys are sign-continuous (the loader flips them), so a plain lerp is an nlerp.
        for (let c = 0; c < n; c++) out[c] = v[lo * n + c] + (v[hi * n + c] - v[lo * n + c]) * f;
        return;
    }
    for (let c = 0; c < n; c++) out[c] = ch.values[i * n + c];
}

/** The clips of courier_anims.glb, indexed by name and bone. Shared by every avatar. */
export class ClipSet {
    private readonly clips = new Map<ClipName, Clip>();

    static fromTracks(tracks: readonly AnimTrack[]): ClipSet {
        const set = new ClipSet();
        for (const track of tracks) {
            const name = track.name as ClipName;
            const info = ANIM_CLIPS[name];
            if (!info) continue;
            const rot: (Channel | null)[] = ANIM_BONES.map(() => null);
            let pos: Channel | null = null;
            for (const curve of track.curves) {
                for (const path of curve.paths) {
                    const bone = path.entityPath[path.entityPath.length - 1];
                    const idx = BONE_INDEX.get(bone);
                    if (idx === undefined || !info.bones.includes(bone)) continue;
                    const ch = { times: toF32(track.inputs[curve.input].data), values: toF32(track.outputs[curve.output].data) };
                    if (path.propertyPath[0] === 'localRotation') rot[idx] = ch;
                    else if (path.propertyPath[0] === 'localPosition' && idx === HIPS) pos = ch;
                }
            }
            set.clips.set(name, { info, rot, pos });
        }
        return set;
    }

    /** Builds a set from plain data (tests / tools): per clip, per bone [times, xyzw values]. */
    static fromData(data: Partial<Record<ClipName, { rot: Record<string, [number[], number[]]>; pos?: [number[], number[]] }>>): ClipSet {
        const set = new ClipSet();
        for (const [name, d] of Object.entries(data) as [ClipName, NonNullable<(typeof data)[ClipName]>][]) {
            const rot = ANIM_BONES.map((b) => (d.rot[b] ? { times: toF32(d.rot[b][0]), values: toF32(d.rot[b][1]) } : null));
            const pos = d.pos ? { times: toF32(d.pos[0]), values: toF32(d.pos[1]) } : null;
            set.clips.set(name, { info: ANIM_CLIPS[name], rot, pos });
        }
        return set;
    }

    has(name: ClipName) {
        return this.clips.has(name);
    }

    get names(): ClipName[] {
        return [...this.clips.keys()];
    }

    /** Raw access for the mixer. */
    clip(name: ClipName): Clip | undefined {
        return this.clips.get(name);
    }
}

const tmp4 = [0, 0, 0, 0];
const tmp3 = [0, 0, 0];

/**
 * Accumulates weighted clip samples into one pose (per animated bone: quaternion, hips position).
 * Base clips are blended by normalised weight; upper clips are applied as weighted deltas.
 */
export class PoseMixer {
    readonly rot = new Float32Array(ANIM_BONES.length * 4);
    readonly pos = new Float32Array(3);
    private readonly weight = new Float32Array(ANIM_BONES.length);
    private posWeight = 0;
    private readonly set: ClipSet;

    constructor(set: ClipSet) {
        this.set = set;
    }

    begin() {
        this.rot.fill(0);
        this.pos.fill(0);
        this.weight.fill(0);
        this.posWeight = 0;
    }

    private time(info: ClipInfo, t: number) {
        if (info.loop) {
            const d = info.duration;
            return ((t % d) + d) % d;
        }
        return Math.min(Math.max(t, 0), info.duration);
    }

    /** Add a base-layer clip at time t (seconds) with weight w. */
    add(name: ClipName, t: number, w: number) {
        if (w <= 1e-4) return;
        const c = this.set.clip(name);
        if (!c) return;
        const tt = this.time(c.info, t);
        for (let b = 0; b < c.rot.length; b++) {
            const ch = c.rot[b];
            if (!ch) continue;
            sample(ch, 4, tt, tmp4);
            const o = b * 4;
            // Keep all contributions in the same hemisphere as the first one.
            const ww = this.weight[b] > 0 && this.rot[o] * tmp4[0] + this.rot[o + 1] * tmp4[1] + this.rot[o + 2] * tmp4[2] + this.rot[o + 3] * tmp4[3] < 0 ? -w : w;
            for (let k = 0; k < 4; k++) this.rot[o + k] += tmp4[k] * ww;
            this.weight[b] += w;
        }
        if (c.pos) {
            sample(c.pos, 3, tt, tmp3);
            for (let k = 0; k < 3; k++) this.pos[k] += tmp3[k] * w;
            this.posWeight += w;
        }
    }

    /** Normalise the base layer (bones without any contribution become identity / rest). */
    resolve(restHips: { x: number; y: number; z: number }) {
        for (let b = 0; b < ANIM_BONES.length; b++) {
            const o = b * 4;
            const len = Math.hypot(this.rot[o], this.rot[o + 1], this.rot[o + 2], this.rot[o + 3]);
            if (len < 1e-6) {
                this.rot.set([0, 0, 0, 1], o);
            } else for (let k = 0; k < 4; k++) this.rot[o + k] /= len;
        }
        if (this.posWeight > 1e-6) for (let k = 0; k < 3; k++) this.pos[k] /= this.posWeight;
        else this.pos.set([restHips.x, restHips.y, restHips.z]);
    }

    /** Apply an upper-layer clip on top: rot = rot * slerp(identity, delta, w). */
    addDelta(name: ClipName, t: number, w: number) {
        if (w <= 1e-4) return;
        const c = this.set.clip(name);
        if (!c) return;
        const tt = this.time(c.info, t);
        for (const b of UPPER_INDICES) {
            const ch = c.rot[b];
            if (!ch) continue;
            sample(ch, 4, tt, tmp4);
            // Partial delta: nlerp from identity.
            let [x, y, z, ww] = tmp4;
            if (ww < 0) {
                x = -x;
                y = -y;
                z = -z;
                ww = -ww;
            }
            x *= w;
            y *= w;
            z *= w;
            ww = 1 - w + ww * w;
            const l = Math.hypot(x, y, z, ww);
            mulInto(this.rot, b * 4, x / l, y / l, z / l, ww / l);
        }
    }
}

/** q[o..o+3] = q * (x, y, z, w). */
function mulInto(q: Float32Array, o: number, bx: number, by: number, bz: number, bw: number) {
    const ax = q[o];
    const ay = q[o + 1];
    const az = q[o + 2];
    const aw = q[o + 3];
    q[o] = aw * bx + ax * bw + ay * bz - az * by;
    q[o + 1] = aw * by - ax * bz + ay * bw + az * bx;
    q[o + 2] = aw * bz + ax * by - ay * bx + az * bw;
    q[o + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

const smooth = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * Math.min(1, rate * dt);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** What the animation needs to know each frame (derived from RigPose; visual only). */
export type AnimInput = {
    /** Local horizontal velocity: forward (+ = facing direction) and right. m/s. */
    forward: number;
    right: number;
    vy: number;
    grounded: boolean;
    dashing: boolean;
    aiming: boolean;
    /** 0..1 while reloading, else -1. */
    reload: number;
    victory: boolean;
};

/**
 * Per-avatar state machine choosing clip weights from AnimInput. Transitions are cross-fades:
 * idle <-> move (by speed), move direction (by velocity angle), jog -> run (by speed),
 * ground <-> air (jump_start then jump_air, land on touchdown), dash, victory; one-shots respawn,
 * land, fire, hit; reload follows the reload progress.
 */
export class AnimState {
    phase = 0;
    private idleT = 0;
    private airW = 0;
    private dashW = 0;
    private victoryW = 0;
    private aimW = 0;
    private moveW = 0;
    private dir = { f: 1, b: 0, l: 0, r: 0 };
    private wasGrounded = true;
    private jumpT = -1;
    private landT = -1;
    private landStrength = 1;
    private respawnT = -1;
    private fireT = -1;
    private hitT = -1;
    private airT = 0;
    private victoryT = 0;

    fired() {
        this.fireT = 0;
    }

    hit() {
        this.hitT = 0;
    }

    respawned() {
        this.respawnT = 0;
        this.airW = 0;
        this.dashW = 0;
        this.landT = -1;
        this.jumpT = -1;
    }

    /** Advance by dt and write the mixed pose into `mix`. */
    step(dt: number, a: AnimInput, mix: PoseMixer, restHips: { x: number; y: number; z: number }, upper = true) {
        const speed = Math.hypot(a.forward, a.right);
        this.idleT += dt;

        // Ground / air transitions.
        if (!a.grounded && this.wasGrounded) {
            this.jumpT = a.vy > 0.5 ? 0 : -1;
            this.airT = 0;
        }
        if (a.grounded && !this.wasGrounded) {
            this.landT = 0;
            this.landStrength = clamp01(0.45 + Math.min(1, Math.max(0, -a.vy) / 9) * 0.55);
        }
        this.wasGrounded = a.grounded;
        this.airW = smooth(this.airW, a.grounded ? 0 : 1, a.grounded ? 14 : 10, dt);
        this.dashW = smooth(this.dashW, a.dashing ? 1 : 0, 20, dt);
        this.victoryW = smooth(this.victoryW, a.victory ? 1 : 0, 6, dt);
        this.aimW = smooth(this.aimW, a.aiming ? 1 : 0, 10, dt);
        if (!a.grounded) this.airT += dt;
        if (a.victory) this.victoryT += dt;
        else this.victoryT = 0;

        // Locomotion: idle <-> move by speed; direction weights by velocity angle.
        this.moveW = smooth(this.moveW, clamp01((speed - 0.4) / 2.6), 12, dt);
        if (speed > 0.3) {
            const f = Math.max(0, a.forward);
            const b = Math.max(0, -a.forward);
            const r = Math.max(0, a.right);
            const l = Math.max(0, -a.right);
            const sum = f + b + r + l;
            this.dir.f = smooth(this.dir.f, f / sum, 12, dt);
            this.dir.b = smooth(this.dir.b, b / sum, 12, dt);
            this.dir.r = smooth(this.dir.r, r / sum, 12, dt);
            this.dir.l = smooth(this.dir.l, l / sum, 12, dt);
        }
        const run = clamp01((speed - 6) / 2);
        const stride =
            this.dir.f * (ANIM_CLIPS.jog.stride! * (1 - run) + ANIM_CLIPS.run.stride! * run) +
            (this.dir.b + this.dir.r + this.dir.l) * ANIM_CLIPS.jog.stride!;
        if (a.grounded && !a.dashing) this.phase = (this.phase + (speed * dt) / Math.max(0.5, stride)) % 1;

        // One-shots.
        const adv = (t: number, dur: number) => (t < 0 ? -1 : t + dt > dur ? -1 : t + dt);
        this.jumpT = adv(this.jumpT, ANIM_CLIPS.jump_start.duration);
        this.landT = adv(this.landT, ANIM_CLIPS.land.duration);
        this.respawnT = adv(this.respawnT, ANIM_CLIPS.respawn.duration);
        this.fireT = adv(this.fireT, ANIM_CLIPS.fire.duration);
        this.hitT = adv(this.hitT, ANIM_CLIPS.hit.duration);
        const envelope = (t: number, dur: number, fadeIn: number, fadeOut: number) =>
            t < 0 ? 0 : Math.min(1, fadeIn > 0 ? t / fadeIn : 1, (dur - t) / fadeOut);

        mix.begin();
        // Ground mix.
        const ground = (1 - this.airW) * (1 - this.dashW);
        const move = ground * this.moveW;
        mix.add('idle', this.idleT, ground * (1 - this.moveW));
        const at = (name: ClipName) => this.phase * ANIM_CLIPS[name].duration;
        mix.add('jog', at('jog'), move * this.dir.f * (1 - run));
        mix.add('run', at('run'), move * this.dir.f * run);
        mix.add('jog_back', at('jog_back'), move * this.dir.b);
        mix.add('strafe_R', at('strafe_R'), move * this.dir.r);
        mix.add('strafe_L', at('strafe_L'), move * this.dir.l);
        // Air: the take-off clip leads into the air loop.
        const jumpW = this.jumpT >= 0 ? 1 - this.jumpT / ANIM_CLIPS.jump_start.duration : 0;
        mix.add('jump_start', this.jumpT, this.airW * jumpW);
        mix.add('jump_air', this.airT, this.airW * (1 - jumpW));
        mix.add('dash', this.idleT, this.dashW * (1 - this.airW));
        // Full-body one-shots and victory override what is underneath: the weights above sum to 1,
        // so adding w / (1 - w) makes the override exactly a fraction w of the normalised result.
        const over = (w: number) => (w > 0 ? Math.min(0.97, w) / (1 - Math.min(0.97, w)) : 0);
        const landW = envelope(this.landT, ANIM_CLIPS.land.duration, 0.03, 0.16) * this.landStrength * (1 - 0.65 * this.moveW) * (1 - this.airW);
        mix.add('land', this.landT, over(landW));
        mix.add('respawn', this.respawnT, over(envelope(this.respawnT, ANIM_CLIPS.respawn.duration, 0, 0.18)));
        mix.add('victory', this.victoryT, over(this.victoryW));
        mix.resolve(restHips);

        if (!upper) return;
        mix.addDelta('aim', this.idleT, this.aimW);
        if (a.reload >= 0) mix.addDelta('reload', a.reload * ANIM_CLIPS.reload.duration, 1);
        mix.addDelta('fire', this.fireT, this.fireT >= 0 ? 1 : 0);
        mix.addDelta('hit', this.hitT, this.hitT >= 0 ? 1 : 0);
    }
}
