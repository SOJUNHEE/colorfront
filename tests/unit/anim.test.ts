/**
 * Phase 6 Gate 4 — keyframed clips: the shipped GLB really contains Blender keyframes for every
 * clip (not constant poses), the runtime clip table matches what Blender wrote, and the mixer /
 * state machine blend as intended.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ANIM_BONES, ANIM_CLIPS, AnimState, ClipSet, HIPS, PoseMixer } from '../../apps/client/src/avatar/anim.ts';
import type { AnimInput, ClipName } from '../../apps/client/src/avatar/anim.ts';
import { compact } from '../../apps/client/src/avatar/library.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GLB = join(ROOT, 'apps', 'client', 'public', 'assets', 'characters', 'courier_anims.glb');

type Gltf = {
    nodes: { name: string }[];
    accessors: { bufferView: number; byteOffset?: number; count: number; type: string; componentType: number }[];
    bufferViews: { byteOffset?: number }[];
    animations: { name: string; channels: { sampler: number; target: { node: number; path: string } }[]; samplers: { input: number; output: number }[] }[];
};

function readGlb() {
    const buf = readFileSync(GLB);
    const jsonLen = buf.readUInt32LE(12);
    const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8')) as Gltf;
    const bin = 20 + jsonLen + 8;
    const read = (i: number) => {
        const a = json.accessors[i];
        const n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type as 'SCALAR']!;
        const off = bin + (json.bufferViews[a.bufferView].byteOffset ?? 0) + (a.byteOffset ?? 0);
        const out: number[] = [];
        for (let k = 0; k < a.count * n; k++) out.push(buf.readFloatLE(off + k * 4));
        return { n, values: out, count: a.count };
    };
    return { json, read };
}

describe('animation clips (Gate 4)', () => {
    const { json, read } = readGlb();

    it('runtime clip table matches assets-src/blender/anim_clips.json', () => {
        const table = JSON.parse(readFileSync(join(ROOT, 'assets-src', 'blender', 'anim_clips.json'), 'utf8')) as Record<string, unknown>;
        const runtime = Object.fromEntries(Object.entries(ANIM_CLIPS).map(([k, v]) => [k, { ...v, bones: [...v.bones] }]));
        expect(table).toEqual(runtime);
    });

    it('ships every clip, keyed (not constant) on its bones, with unit quaternions and the right length', () => {
        const names = json.animations.map((a) => a.name).sort();
        expect(names).toEqual(Object.keys(ANIM_CLIPS).sort());
        for (const anim of json.animations) {
            const info = ANIM_CLIPS[anim.name as ClipName];
            let moving = 0;
            for (const ch of anim.channels) {
                const bone = json.nodes[ch.target.node].name;
                if (!info.bones.includes(bone) || ch.target.path !== 'rotation') continue;
                const s = anim.samplers[ch.sampler];
                const t = read(s.input).values;
                const q = read(s.output);
                expect(t[t.length - 1], `${anim.name} length`).toBeCloseTo(info.duration, 1);
                for (let k = 0; k < q.count; k++) {
                    const [x, y, z, w] = q.values.slice(k * 4, k * 4 + 4);
                    expect(Math.hypot(x, y, z, w)).toBeCloseTo(1, 3);
                }
                const first = q.values.slice(0, 4);
                const spread = Math.max(...Array.from({ length: q.count }, (_, k) => 1 - Math.abs(first.reduce((d, c, i) => d + c * q.values[k * 4 + i], 0))));
                if (q.count > 2 && spread > 1e-4) moving++;
            }
            // Every clip animates several of its bones (real keyframes, not a held pose).
            expect(moving, anim.name).toBeGreaterThanOrEqual(anim.name === 'aim' ? 0 : 3);
        }
    });

    it('never keys the root, arms, gun or tank (root motion / hand IK stay with the runtime)', () => {
        for (const info of Object.values(ANIM_CLIPS))
            for (const b of info.bones) expect(['root', 'gun', 'liquid', 'upperArmL', 'upperArmR', 'foreArmL', 'foreArmR', 'handL', 'handR']).not.toContain(b);
    });
});

// ── mixer / state machine on synthetic clips ────────────────────────────────────────────────────
const rotX = (deg: number) => {
    const h = (deg * Math.PI) / 360;
    return [Math.sin(h), 0, 0, Math.cos(h)];
};
const constant = (deg: number): [number[], number[]] => [[0, 1], [...rotX(deg), ...rotX(deg)]];
const angleX = (m: PoseMixer, bone: string) => {
    const i = ANIM_BONES.indexOf(bone) * 4;
    return (2 * Math.asin(m.rot[i]) * 180) / Math.PI;
};
const REST = { x: 0, y: 0.72, z: 0 };

function synthetic() {
    const data: Parameters<typeof ClipSet.fromData>[0] = {};
    const deg: Partial<Record<ClipName, number>> = { idle: 0, jog: 40, run: 60, jog_back: -20, strafe_R: 10, strafe_L: -10, dash: 70, jump_start: 15, jump_air: 50, land: 80, respawn: 90, victory: 30 };
    for (const [name, d] of Object.entries(deg) as [ClipName, number][]) data[name] = { rot: { thighL: constant(d) }, pos: [[0, 1], [0, 0.72, 0, 0, 0.72, 0]] };
    for (const name of ['aim', 'fire', 'reload', 'hit'] as const) data[name] = { rot: { chest: constant(20) } };
    return ClipSet.fromData(data);
}

const input = (o: Partial<AnimInput> = {}): AnimInput => ({
    forward: 0,
    right: 0,
    vy: 0,
    grounded: true,
    dashing: false,
    aiming: false,
    reload: -1,
    victory: false,
    ...o
});

function run(state: AnimState, mix: PoseMixer, seconds: number, a: AnimInput) {
    for (let t = 0; t < seconds; t += 1 / 60) state.step(1 / 60, a, mix, REST);
}

describe('PoseMixer / AnimState', () => {
    it('stands in idle, jogs at walking speed and blends toward run at sprint speed', () => {
        const set = synthetic();
        const mix = new PoseMixer(set);
        const s = new AnimState();
        run(s, mix, 1, input());
        expect(angleX(mix, 'thighL')).toBeCloseTo(0, 1);
        run(s, mix, 1, input({ forward: 6 }));
        expect(angleX(mix, 'thighL')).toBeCloseTo(40, 0);
        run(s, mix, 1, input({ forward: 8 }));
        expect(angleX(mix, 'thighL')).toBeCloseTo(60, 0);
        run(s, mix, 1, input({ forward: -5 }));
        expect(angleX(mix, 'thighL')).toBeCloseTo(-20, 0);
    });

    it('advances the gait phase by distance travelled (stride), not by time', () => {
        const s = new AnimState();
        const mix = new PoseMixer(synthetic());
        run(s, mix, 0.5, input({ forward: 6 }));
        const p0 = s.phase;
        s.step(0.1, input({ forward: 6 }), mix, REST);
        const dp = (s.phase - p0 + 1) % 1;
        expect(dp).toBeCloseTo((6 * 0.1) / ANIM_CLIPS.jog.stride!, 3);
    });

    it('goes airborne, lands with a one-shot and returns to idle', () => {
        const s = new AnimState();
        const mix = new PoseMixer(synthetic());
        run(s, mix, 0.5, input({ grounded: false, vy: 4 }));
        expect(angleX(mix, 'thighL')).toBeGreaterThan(40);
        s.step(1 / 60, input({ grounded: true, vy: -9 }), mix, REST);
        run(s, mix, 0.1, input());
        expect(angleX(mix, 'thighL')).toBeGreaterThan(40); // land crouch dominates
        run(s, mix, 1, input());
        expect(angleX(mix, 'thighL')).toBeCloseTo(0, 0);
    });

    it('respawn and victory override the base layer; upper clips add on top', () => {
        const s = new AnimState();
        const mix = new PoseMixer(synthetic());
        s.respawned();
        s.step(0.05, input(), mix, REST);
        expect(angleX(mix, 'thighL')).toBeGreaterThan(80);
        run(s, mix, 2, input({ victory: true }));
        expect(angleX(mix, 'thighL')).toBeGreaterThan(25);
        run(s, mix, 1, input({ aiming: true }));
        expect(angleX(mix, 'chest')).toBeCloseTo(20, 0);
        run(s, mix, 1, input());
        expect(angleX(mix, 'chest')).toBeCloseTo(0, 0);
        s.step(1 / 60, input({ reload: 0.5 }), mix, REST);
        expect(angleX(mix, 'chest')).toBeCloseTo(20, 0);
    });

    it('hips position comes from the clips (no root motion)', () => {
        const s = new AnimState();
        const mix = new PoseMixer(synthetic());
        run(s, mix, 1, input({ forward: 6 }));
        expect(Array.from(mix.pos)).toEqual([0, expect.closeTo(0.72, 5), 0]);
        expect(HIPS).toBe(ANIM_BONES.indexOf('hips'));
    });
});

describe('outfit merge helpers', () => {
    it('compact keeps only the vertices a partial mesh uses, in first-use order', () => {
        const { order, index } = compact([5, 2, 9, 9, 2, 7], 10);
        expect(order).toEqual([5, 2, 9, 7]);
        expect(index).toEqual([0, 1, 2, 2, 1, 3]);
    });
});
