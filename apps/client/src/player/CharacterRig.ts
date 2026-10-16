import type { TeamId } from '@colorfront/shared';
import {
    BoxGeometry,
    CapsuleGeometry,
    Color,
    ConeGeometry,
    CylinderGeometry,
    Entity,
    Mat4,
    Mesh,
    MeshInstance,
    Quat,
    SEMANTIC_BLENDINDICES,
    SEMANTIC_BLENDWEIGHT,
    SHADERLANGUAGE_GLSL,
    Skin,
    SkinInstance,
    SphereGeometry,
    StandardMaterial,
    TYPE_FLOAT32,
    TYPE_UINT8,
    Vec3
} from 'playcanvas';
import type { AppBase, Geometry } from 'playcanvas';

/** Bone hierarchy (rest pose, character facing -Z, +X to its right, feet at the origin). */
const BONES = [
    ['root', -1, 0, 0, 0],
    ['hips', 0, 0, 0.72, 0],
    ['spine', 1, 0, 0.09, 0],
    ['chest', 2, 0, 0.17, 0],
    ['neck', 3, 0, 0.16, 0],
    ['head', 4, 0, 0.05, 0],
    ['shoulderL', 3, -0.17, 0.12, 0],
    ['upperArmL', 6, 0, 0, 0],
    ['foreArmL', 7, 0, -0.24, 0],
    ['handL', 8, 0, -0.22, 0],
    ['shoulderR', 3, 0.17, 0.12, 0],
    ['upperArmR', 10, 0, 0, 0],
    ['foreArmR', 11, 0, -0.24, 0],
    ['handR', 12, 0, -0.22, 0],
    ['thighL', 1, -0.09, -0.04, 0],
    ['shinL', 14, 0, -0.34, 0],
    ['footL', 15, 0, -0.32, 0],
    ['thighR', 1, 0.09, -0.04, 0],
    ['shinR', 17, 0, -0.34, 0],
    ['footR', 18, 0, -0.32, 0],
    ['gun', 3, 0.19, 0.15, -0.06],
    ['liquid', 3, 0, -0.19, 0.19]
] as const;
type BoneName = (typeof BONES)[number][0];
const BONE_INDEX = Object.fromEntries(BONES.map((b, i) => [b[0], i])) as Record<BoneName, number>;

type ColorKey =
    | 'skin'
    | 'skinDark'
    | 'suit'
    | 'suitDark'
    | 'team'
    | 'teamDark'
    | 'boot'
    | 'sole'
    | 'glove'
    | 'white'
    | 'iris'
    | 'pupil'
    | 'metal'
    | 'lens'
    | 'hair'
    | 'strap'
    | 'glass'
    | 'liquid'
    | 'led'
    | 'mouth'
    | 'gunBody';

/** Glossy/emissive layer keys (second material). Value = emissive strength stored in vertex alpha. */
const GLOSS: Partial<Record<ColorKey, number>> = {
    hair: 0.12,
    lens: 0.25,
    iris: 0.15,
    glass: 0.0,
    liquid: 0.9,
    led: 2.5,
    white: 0.05,
    pupil: 0
};

const SKIN_TONES: [number, number, number][] = [
    [0.93, 0.66, 0.5],
    [0.78, 0.5, 0.34],
    [0.56, 0.34, 0.22],
    [0.98, 0.78, 0.62],
    [0.42, 0.26, 0.18]
];

function palette(team: TeamId, skin: [number, number, number]): Record<ColorKey, [number, number, number]> {
    const t: [number, number, number] = team === 'blue' ? [0.06, 0.32, 1.0] : [1.0, 0.36, 0.04];
    const td: [number, number, number] = team === 'blue' ? [0.03, 0.12, 0.42] : [0.45, 0.13, 0.02];
    return {
        skin,
        skinDark: [skin[0] * 0.8, skin[1] * 0.7, skin[2] * 0.7],
        suit: [0.16, 0.17, 0.2],
        suitDark: [0.08, 0.085, 0.1],
        team: t,
        teamDark: td,
        boot: [0.12, 0.12, 0.13],
        sole: [0.85, 0.85, 0.82],
        glove: [0.1, 0.1, 0.11],
        white: [0.95, 0.95, 0.95],
        iris: t,
        pupil: [0.02, 0.02, 0.03],
        metal: [0.55, 0.57, 0.6],
        lens: [t[0] * 0.5 + 0.1, t[1] * 0.5 + 0.1, t[2] * 0.5 + 0.1],
        hair: t,
        strap: [0.06, 0.06, 0.07],
        glass: [0.75, 0.85, 0.9],
        liquid: t,
        led: t,
        mouth: [0.3, 0.08, 0.08],
        gunBody: [0.88, 0.88, 0.86]
    };
}

type Part = {
    bone: BoneName;
    geom: Geometry;
    at: [number, number, number];
    rot?: [number, number, number];
    scale?: [number, number, number];
    color: ColorKey;
    lod?: 0;
};

const sphere = (r: number, d: number) => new SphereGeometry({ radius: r, latitudeBands: d, longitudeBands: d + 4 });
const capsule = (r: number, h: number, d: number) =>
    new CapsuleGeometry({ radius: r, height: h, sides: d, heightSegments: 1 });
const cyl = (r: number, h: number, d: number) =>
    new CylinderGeometry({ radius: r, height: h, capSegments: d, heightSegments: 1 });
const cone = (r0: number, r1: number, h: number, d: number) =>
    new ConeGeometry({ baseRadius: r0, peakRadius: r1, height: h, capSegments: d, heightSegments: 1 });
const box = (x: number, y: number, z: number) => new BoxGeometry({ halfExtents: new Vec3(x / 2, y / 2, z / 2) });

/** Original "colour runner" courier: built from rounded primitives, rigidly skinned to 22 bones. */
function buildParts(detail: 0 | 1, hairStyle: number): Part[] {
    const d = detail === 0 ? 10 : 5;
    const P: Part[] = [];
    const add = (p: Part) => P.push(p);
    // Head and face (head bone at the base of the skull).
    add({ bone: 'head', geom: sphere(0.21, d), at: [0, 0.19, 0], scale: [1, 0.96, 0.95], color: 'skin' });
    add({ bone: 'head', geom: sphere(0.05, 6), at: [-0.205, 0.17, 0.01], scale: [0.6, 1, 1], color: 'skinDark' });
    add({ bone: 'head', geom: sphere(0.05, 6), at: [0.205, 0.17, 0.01], scale: [0.6, 1, 1], color: 'skinDark' });
    for (const s of [-1, 1]) {
        add({
            bone: 'head',
            geom: sphere(0.058, d),
            at: [0.078 * s, 0.19, -0.16],
            scale: [1, 1.15, 0.6],
            color: 'white',
            lod: 0
        });
        add({
            bone: 'head',
            geom: sphere(0.036, d),
            at: [0.078 * s, 0.185, -0.188],
            scale: [1, 1.15, 0.5],
            color: 'iris',
            lod: 0
        });
        add({
            bone: 'head',
            geom: sphere(0.019, 6),
            at: [0.078 * s, 0.183, -0.203],
            scale: [1, 1.2, 0.5],
            color: 'pupil',
            lod: 0
        });
        add({ bone: 'head', geom: sphere(0.009, 4), at: [0.078 * s + 0.012, 0.2, -0.212], color: 'white', lod: 0 });
        add({
            bone: 'head',
            geom: box(0.07, 0.018, 0.02),
            at: [0.08 * s, 0.265, -0.178],
            rot: [0, 0, -12 * s],
            color: 'teamDark',
            lod: 0
        });
    }
    add({ bone: 'head', geom: sphere(0.018, 6), at: [0, 0.14, -0.205], color: 'skinDark', lod: 0 });
    add({
        bone: 'head',
        geom: capsule(0.012, 0.06, 6),
        at: [0, 0.095, -0.19],
        rot: [0, 0, 90],
        color: 'mouth',
        lod: 0
    });
    // Glossy paint-gel hair: cap + spikes (style varies per player).
    add({ bone: 'head', geom: sphere(0.222, d), at: [0, 0.235, 0.015], scale: [1.04, 0.78, 1.04], color: 'hair' });
    const spikes = hairStyle % 2 === 0 ? 7 : 5;
    for (let i = 0; i < spikes; i++) {
        const a = (i / (spikes - 1) - 0.5) * 2.4;
        add({
            bone: 'head',
            geom: cone(0.07, 0, 0.2 + (i % 2) * 0.05, 6),
            at: [Math.sin(a) * 0.12, 0.35, 0.07 + Math.cos(a) * 0.05],
            rot: [-55 + (i % 2) * 15, (a * 180) / Math.PI, 0],
            color: 'hair',
            lod: i % 2 ? 0 : undefined
        });
    }
    for (let i = 0; i < 3; i++) {
        add({
            bone: 'head',
            geom: cone(0.05, 0, 0.14, 6),
            at: [(i - 1) * 0.07, 0.33, -0.15],
            rot: [-150, 0, (i - 1) * 25],
            color: 'hair',
            lod: i === 1 ? undefined : 0
        });
    }
    // Goggles pushed up on the forehead + strap, and headphones.
    add({
        bone: 'head',
        geom: cyl(0.215, 0.035, d),
        at: [0, 0.31, 0.01],
        scale: [1.02, 1, 1.02],
        rot: [-12, 0, 0],
        color: 'strap'
    });
    for (const s of [-1, 1]) {
        add({
            bone: 'head',
            geom: cyl(0.045, 0.03, 10),
            at: [0.065 * s, 0.33, -0.19],
            rot: [70, 0, 0],
            color: 'lens',
            lod: 0
        });
        add({
            bone: 'head',
            geom: cyl(0.06, 0.06, 10),
            at: [0.215 * s, 0.17, 0.01],
            rot: [0, 0, 90],
            color: 'suitDark'
        });
        add({
            bone: 'head',
            geom: cyl(0.035, 0.065, 8),
            at: [0.217 * s, 0.17, 0.01],
            rot: [0, 0, 90],
            color: 'led',
            lod: 0
        });
    }
    // Neck and torso: jacket in team colour over a dark suit.
    add({ bone: 'neck', geom: cyl(0.06, 0.12, 8), at: [0, 0.03, 0], color: 'skin' });
    add({ bone: 'chest', geom: capsule(0.16, 0.36, d), at: [0, 0.03, 0], scale: [1.18, 1, 0.82], color: 'team' });
    add({ bone: 'chest', geom: cyl(0.1, 0.06, 10), at: [0, 0.17, 0], scale: [1.1, 1, 0.9], color: 'teamDark' });
    add({ bone: 'chest', geom: box(0.06, 0.3, 0.02), at: [0, 0.0, -0.13], color: 'suitDark' });
    add({ bone: 'chest', geom: box(0.34, 0.05, 0.26), at: [0, -0.06, 0], color: 'white' });
    add({ bone: 'chest', geom: box(0.05, 0.36, 0.3), at: [-0.1, 0.02, 0], rot: [0, 0, -12], color: 'strap' });
    add({ bone: 'spine', geom: capsule(0.14, 0.24, d), at: [0, 0.02, 0], scale: [1.15, 1, 0.85], color: 'suit' });
    add({ bone: 'hips', geom: capsule(0.15, 0.26, d), at: [0, -0.04, 0], scale: [1.2, 1, 0.9], color: 'suit' });
    add({ bone: 'hips', geom: box(0.36, 0.05, 0.26), at: [0, 0.06, 0], color: 'strap' });
    add({ bone: 'hips', geom: box(0.07, 0.06, 0.03), at: [0.08, 0.06, -0.135], color: 'metal', lod: 0 });
    // Arms: team sleeves, bare forearms, gloves.
    for (const side of ['L', 'R'] as const) {
        const s = side === 'L' ? -1 : 1;
        add({ bone: `shoulder${side}`, geom: sphere(0.075, 8), at: [0.01 * s, 0, 0], color: 'teamDark' });
        add({ bone: `upperArm${side}`, geom: capsule(0.058, 0.26, 8), at: [0, -0.11, 0], color: 'team' });
        add({ bone: `foreArm${side}`, geom: capsule(0.048, 0.24, 8), at: [0, -0.11, 0], color: 'skin' });
        add({ bone: `foreArm${side}`, geom: cyl(0.055, 0.05, 8), at: [0, -0.19, 0], color: 'teamDark' });
        add({ bone: `hand${side}`, geom: sphere(0.055, 7), at: [0, -0.04, 0], scale: [0.85, 1.1, 1], color: 'glove' });
        // Legs: cargo trousers, knee pads, chunky boots.
        add({ bone: `thigh${side}`, geom: capsule(0.08, 0.36, 8), at: [0, -0.16, 0], color: 'suit' });
        add({ bone: `thigh${side}`, geom: box(0.05, 0.1, 0.08), at: [0.075 * s, -0.17, 0], color: 'suitDark', lod: 0 });
        add({ bone: `shin${side}`, geom: capsule(0.065, 0.32, 8), at: [0, -0.15, 0], color: 'suit' });
        add({ bone: `shin${side}`, geom: box(0.1, 0.1, 0.05), at: [0, -0.02, -0.06], color: 'team' });
        add({ bone: `foot${side}`, geom: box(0.12, 0.09, 0.25), at: [0, 0.035, -0.045], color: 'boot' });
        add({ bone: `foot${side}`, geom: box(0.13, 0.03, 0.27), at: [0, -0.005, -0.045], color: 'sole' });
        add({ bone: `foot${side}`, geom: box(0.125, 0.03, 0.08), at: [0, 0.07, -0.13], color: 'team', lod: 0 });
    }
    // Paint tank on the back: glass, liquid (scaled with ammo), caps, straps, hose.
    add({ bone: 'chest', geom: cyl(0.097, 0.34, d), at: [0, -0.02, 0.19], color: 'strap' });
    // Open metal cage so the team-coloured paint (= ammo level) is visible from outside.
    for (const y of [-0.13, 0.0, 0.12])
        add({ bone: 'chest', geom: cyl(0.112, 0.022, d), at: [0, y, 0.19], color: 'metal' });
    for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.4;
        add({
            bone: 'chest',
            geom: box(0.018, 0.36, 0.018),
            at: [Math.cos(a) * 0.108, -0.02, 0.19 + Math.sin(a) * 0.108],
            color: 'metal',
            lod: 0
        });
    }
    add({ bone: 'liquid', geom: cyl(0.1, 0.33, d), at: [0, 0.165, 0], color: 'liquid' });
    add({ bone: 'chest', geom: cyl(0.125, 0.05, d), at: [0, 0.18, 0.19], color: 'metal' });
    add({ bone: 'chest', geom: cyl(0.125, 0.05, d), at: [0, -0.21, 0.19], color: 'metal' });
    add({ bone: 'chest', geom: box(0.3, 0.04, 0.03), at: [0, 0.1, 0.13], color: 'strap' });
    for (let i = 0; i < 6; i++) {
        const t = i / 5;
        add({
            bone: 'chest',
            geom: sphere(0.028, 6),
            at: [0.08 + t * 0.12, -0.2 + Math.sin(t * Math.PI) * -0.06, 0.16 - t * 0.2],
            color: 'strap',
            lod: 0
        });
    }
    // Paint rifle (gun bone: grip at origin, barrel along -Z).
    add({ bone: 'gun', geom: box(0.09, 0.12, 0.44), at: [0, 0.02, -0.18], color: 'gunBody' });
    add({ bone: 'gun', geom: box(0.07, 0.04, 0.3), at: [0, 0.095, -0.2], color: 'teamDark' });
    add({ bone: 'gun', geom: cyl(0.045, 0.16, 10), at: [0, 0.11, -0.12], rot: [90, 0, 0], color: 'liquid' });
    add({ bone: 'gun', geom: cyl(0.026, 0.22, 8), at: [0, 0.03, -0.48], rot: [90, 0, 0], color: 'metal' });
    add({ bone: 'gun', geom: cone(0.05, 0.03, 0.08, 8), at: [0, 0.03, -0.6], rot: [-90, 0, 0], color: 'team' });
    add({ bone: 'gun', geom: box(0.05, 0.13, 0.06), at: [0, -0.07, 0], rot: [15, 0, 0], color: 'strap' });
    add({ bone: 'gun', geom: box(0.06, 0.08, 0.16), at: [0, 0.0, 0.1], color: 'suitDark' });
    add({ bone: 'gun', geom: box(0.04, 0.04, 0.04), at: [0, 0.065, -0.34], color: 'led', lod: 0 });
    return P.filter((p) => detail === 0 || p.lod === undefined);
}

export type RigPose = {
    x: number;
    y: number;
    z: number;
    /** Aim yaw/pitch (radians, PlayerInput convention). */
    yaw: number;
    pitch: number;
    /** Horizontal velocity (world). */
    vx: number;
    vz: number;
    vy: number;
    grounded: boolean;
    aiming: boolean;
    dashing: boolean;
    /** 0..1 progress while reloading, else -1. */
    reload: number;
    /** 0..1 magazine fraction (paint tank level). */
    ammo: number;
    alive: boolean;
};

const DOWN = new Vec3(0, -1, 0);

/**
 * Procedural, rigidly skinned character with code-driven animation (idle, walk, run, dash, jump,
 * land, aim, fire recoil, reload, hit flinch, splat/respawn, victory). One draw call for the body
 * and one for the glossy/emissive layer per character; a reduced mesh is used at distance.
 */
export class CharacterRig {
    readonly root: Entity;
    private readonly bones: Entity[] = [];
    private readonly meshes: { layers: { mesh: Mesh; parts: Part[] }[]; instances: MeshInstance[] }[] = [];
    private readonly bodyMat: StandardMaterial;
    private readonly glossMat: StandardMaterial;
    private team: TeamId;
    private readonly skin: [number, number, number];
    private readonly hairStyle: number;
    private skinInstance: SkinInstance | null = null;
    private lod: 0 | 1 = 0;
    private lodApplied = false;

    // Animation state.
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

    constructor(app: AppBase, team: TeamId, seed: number) {
        this.team = team;
        this.skin = SKIN_TONES[seed % SKIN_TONES.length];
        this.hairStyle = seed;
        this.root = new Entity('character');
        // Bones in rest pose.
        for (const [name, parent, x, y, z] of BONES) {
            const e = new Entity(name);
            e.setLocalPosition(x, y, z);
            (parent < 0 ? this.root : this.bones[parent]).addChild(e);
            this.bones.push(e);
        }
        this.bodyMat = new StandardMaterial();
        this.bodyMat.diffuseVertexColor = true;
        this.bodyMat.useMetalness = true;
        this.bodyMat.metalness = 0;
        this.bodyMat.gloss = 0.42;
        this.bodyMat.update();
        this.glossMat = new StandardMaterial();
        this.glossMat.diffuseVertexColor = true;
        this.glossMat.useMetalness = true;
        this.glossMat.metalness = 0;
        this.glossMat.gloss = 0.93;
        this.glossMat.emissive = new Color(1, 1, 1);
        this.glossMat.emissiveVertexColor = true;
        // Emission = vertex colour * strength stored in vertex alpha (LEDs, paint liquid, lenses).
        this.glossMat.getShaderChunks(SHADERLANGUAGE_GLSL).set(
            'emissivePS',
            `
uniform float material_emissiveIntensity;
void getEmission() { dEmission = vVertexColor.rgb * vVertexColor.a * material_emissiveIntensity; }
`
        );
        this.glossMat.shaderChunksVersion = '2.23';
        this.glossMat.emissiveIntensity = 1;
        this.glossMat.update();

        for (const detail of [0, 1] as const) {
            const parts = buildParts(detail, this.hairStyle);
            const built = this.buildMesh(app, parts);
            this.meshes.push(built);
        }
        app.root.addChild(this.root);
        this.setLod(0);
    }

    private restWorld(): Mat4[] {
        // World matrices of the bones with the root at the origin (bind pose).
        this.root.setPosition(0, 0, 0);
        this.root.setRotation(Quat.IDENTITY);
        return this.bones.map((b) => b.getWorldTransform().clone());
    }

    /** Bake parts (rigid, one bone each) into skinned meshes: body layer and glossy layer. */
    private buildLayer(app: AppBase, parts: Part[], rest: Mat4[]): Mesh {
        const positions: number[] = [];
        const normals: number[] = [];
        const indices: number[] = [];
        const colors: number[] = [];
        const boneIdx: number[] = [];
        const weights: number[] = [];
        const local = new Mat4();
        const full = new Mat4();
        const q = new Quat();
        const v = new Vec3();
        const pal = palette(this.team, this.skin);
        for (const p of parts) {
            const bi = BONE_INDEX[p.bone];
            q.setFromEulerAngles(p.rot?.[0] ?? 0, p.rot?.[1] ?? 0, p.rot?.[2] ?? 0);
            local.setTRS(new Vec3(...p.at), q, new Vec3(...(p.scale ?? [1, 1, 1])));
            full.mul2(rest[bi], local);
            const g = p.geom;
            const pos = g.positions!;
            const nor = g.normals!;
            const base = positions.length / 3;
            const c = pal[p.color];
            const glow = GLOSS[p.color] ?? 0;
            for (let i = 0; i < pos.length; i += 3) {
                v.set(pos[i], pos[i + 1], pos[i + 2]);
                full.transformPoint(v, v);
                positions.push(v.x, v.y, v.z);
                v.set(nor[i], nor[i + 1], nor[i + 2]);
                full.transformVector(v, v).normalize();
                normals.push(v.x, v.y, v.z);
                colors.push(c[0], c[1], c[2], glow);
                boneIdx.push(bi, 0, 0, 0);
                weights.push(1, 0, 0, 0);
            }
            for (const i of g.indices!) indices.push(base + i);
        }
        const mesh = new Mesh(app.graphicsDevice);
        mesh.setPositions(positions);
        mesh.setNormals(normals);
        mesh.setColors(colors, 4);
        mesh.setVertexStream(SEMANTIC_BLENDINDICES, boneIdx, 4, undefined, TYPE_UINT8);
        mesh.setVertexStream(SEMANTIC_BLENDWEIGHT, weights, 4, undefined, TYPE_FLOAT32, false);
        mesh.setIndices(positions.length / 3 > 65535 ? new Uint32Array(indices) : new Uint16Array(indices));
        mesh.update();
        return mesh;
    }

    private buildMesh(app: AppBase, parts: Part[]) {
        const rest = this.restWorld();
        const isGloss = (p: Part) => GLOSS[p.color] !== undefined;
        const layers = [parts.filter((p) => !isGloss(p)), parts.filter(isGloss)].map((ps) => ({
            mesh: this.buildLayer(app, ps, rest),
            parts: ps
        }));
        // One skin and one skin instance per character, shared by every layer and LOD, so the
        // bone palette is computed and uploaded once per frame instead of once per mesh.
        if (!this.skinInstance) {
            const ibp = rest.map((m) => m.clone().invert());
            const skin = new Skin(
                app.graphicsDevice,
                ibp,
                BONES.map((b) => b[0])
            );
            this.skinInstance = new SkinInstance(skin);
            this.skinInstance.bones = this.bones;
            this.skinInstance.rootBone = this.root;
        }
        const skinInstance = this.skinInstance;
        const instances = layers.map(({ mesh }, i) => {
            mesh.skin = skinInstance.skin;
            const mi = new MeshInstance(mesh, i === 0 ? this.bodyMat : this.glossMat);
            mi.skinInstance = skinInstance;
            return mi;
        });
        const entity = new Entity(`character-mesh-${parts.length}`);
        entity.addComponent('render', { meshInstances: instances, castShadows: true, receiveShadows: true });
        this.root.addChild(entity);
        return { layers, instances };
    }

    setTeam(team: TeamId) {
        if (team === this.team) return;
        this.team = team;
        const pal = palette(team, this.skin);
        for (const { layers } of this.meshes) {
            for (const { mesh, parts } of layers) {
                const colors: number[] = [];
                for (const p of parts) {
                    const c = pal[p.color];
                    const glow = GLOSS[p.color] ?? 0;
                    for (let i = 0; i < p.geom.positions!.length; i += 3) colors.push(c[0], c[1], c[2], glow);
                }
                mesh.setColors(colors, 4);
                mesh.update(undefined, false);
            }
        }
    }

    setLod(lod: 0 | 1) {
        if (lod === this.lod && this.lodApplied) return;
        this.lod = lod;
        this.lodApplied = true;
        this.meshes.forEach((m, i) => {
            for (const mi of m.instances) {
                mi.visible = i === lod;
                // Distant characters skip the shadow passes entirely.
                mi.castShadow = i === 0 && lod === 0;
            }
        });
    }

    get currentLod() {
        return this.lod;
    }

    setVisible(v: boolean) {
        this.root.enabled = v;
    }

    /** World position of the rifle nozzle (for muzzle effects). */
    muzzle(out: Vec3): Vec3 {
        const gun = this.bones[BONE_INDEX.gun];
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

    private bone(name: BoneName) {
        return this.bones[BONE_INDEX[name]];
    }

    /** Two-bone IK: point upper arm and forearm so the hand reaches `target` (world). */
    private reach(side: 'L' | 'R', target: Vec3, pole: Vec3) {
        const upper = this.bone(side === 'L' ? 'upperArmL' : 'upperArmR');
        const fore = this.bone(side === 'L' ? 'foreArmL' : 'foreArmR');
        const hand = this.bone(side === 'L' ? 'handL' : 'handR');
        const s = upper.getPosition().clone();
        const a = 0.24;
        const b = 0.22;
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
        const hand3 = new Vec3().copy(s).add(u.clone().mulScalar(dist));
        upper.setRotation(this.tmpQ.setFromDirections(DOWN, new Vec3().sub2(elbow, s).normalize()));
        fore.setRotation(new Quat().setFromDirections(DOWN, new Vec3().sub2(hand3, elbow).normalize()));
        hand.setLocalEulerAngles(0, 0, 0);
    }

    update(dt: number, pose: RigPose, cameraDistance: number, lodDistance: number) {
        this.time += dt;
        this.setLod(cameraDistance > lodDistance ? 1 : 0);
        const far = cameraDistance > lodDistance * 1.6;

        const speed = Math.hypot(pose.vx, pose.vz);
        const yawDeg = (pose.yaw * 180) / Math.PI;
        this.spawnScale = Math.min(1, this.spawnScale + dt * 3.5);
        const sc = 0.2 + 0.8 * (1 - Math.pow(1 - this.spawnScale, 3));
        this.root.setPosition(pose.x, pose.y, pose.z);
        this.root.setEulerAngles(0, yawDeg, 0);
        this.root.setLocalScale(sc, sc * (1 + (1 - this.spawnScale) * 0.3), sc);

        // Movement relative to facing: forward/right components.
        const fx = -Math.sin(pose.yaw),
            fz = -Math.cos(pose.yaw);
        const rx = Math.cos(pose.yaw),
            rz = -Math.sin(pose.yaw);
        const fwd = pose.vx * fx + pose.vz * fz;
        const side = pose.vx * rx + pose.vz * rz;

        if (pose.grounded && !this.wasGrounded) this.landSquash = 1;
        this.wasGrounded = pose.grounded;
        this.landSquash = Math.max(0, this.landSquash - dt * 5);
        this.recoil = Math.max(0, this.recoil - dt * 12);
        this.flinch = Math.max(0, this.flinch - dt * 4);
        if (this.victory > 0) this.victory += dt;

        // Stride: one cycle per ~1.25 m travelled keeps feet from sliding.
        const run = Math.min(1, speed / 8);
        if (pose.grounded) this.phase += (speed / 1.25) * Math.PI * dt;
        const swing = Math.sin(this.phase);
        const swing2 = Math.sin(this.phase * 2);
        const moving = Math.min(1, speed / 2);
        const back = fwd < -0.5 ? -1 : 1;

        // Hips: bob, landing squash, twist toward strafe direction.
        const targetTwist = speed > 1 ? Math.atan2(side, Math.abs(fwd) + 0.01) * 0.55 * back : 0;
        this.hipTwist += (targetTwist - this.hipTwist) * Math.min(1, dt * 10);
        const bob = pose.grounded ? -Math.abs(swing2) * 0.035 * moving - this.landSquash * 0.09 : 0;
        const breathe = Math.sin(this.time * 2.2) * 0.006 * (1 - moving);
        this.bone('hips').setLocalPosition(0, 0.72 + bob + breathe, 0);
        this.bone('hips').setLocalEulerAngles(0, (this.hipTwist * 180) / Math.PI, swing * 3 * moving);

        // Lean into motion; dash leans hard.
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

        // Paint tank level.
        const lvl = Math.max(0.02, pose.ammo);
        this.bone('liquid').setLocalScale(1, lvl, 1);

        // Legs.
        const legAmp = pose.dashing ? 55 : 22 + 18 * run;
        for (const s of ['L', 'R'] as const) {
            const sgn = s === 'L' ? 1 : -1;
            const thigh = this.bone(s === 'L' ? 'thighL' : 'thighR');
            const shin = this.bone(s === 'L' ? 'shinL' : 'shinR');
            const foot = this.bone(s === 'L' ? 'footL' : 'footR');
            let hip: number;
            let knee: number;
            if (!pose.grounded) {
                // Airborne: tuck while rising, reach down while falling.
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
            thigh.setLocalEulerAngles(hip - this.lean * 0.3 + this.landSquash * -30, 0, sgn * 3);
            shin.setLocalEulerAngles(knee, 0, 0);
            foot.setLocalEulerAngles(-(hip + knee) * 0.35, 0, 0);
        }

        // Rifle: aligned with the aim, held at the chest, with recoil and reload tilt.
        const gun = this.bone('gun');
        const reloading = pose.reload >= 0;
        const rl = reloading ? Math.sin(Math.min(1, pose.reload) * Math.PI) : 0;
        gun.setLocalPosition(
            0.19 - (pose.aiming ? 0.04 : 0),
            0.15 + (pose.aiming ? 0.03 : 0),
            -0.06 + this.recoil * 0.07 - (pose.aiming ? 0.05 : 0)
        );
        const victoryUp = this.victory > 0 ? 70 : 0;
        this.tmpQ.setFromEulerAngles(aimPitch + this.recoil * 7 - rl * 35 + victoryUp, yawDeg + rl * 25, rl * 20);
        gun.setRotation(this.tmpQ);

        if (!far) {
            // Hands on the grip and the fore-end; elbows pushed out and down.
            const gm = gun.getWorldTransform();
            const grip = gm.transformPoint(new Vec3(0, -0.08, 0.02), new Vec3());
            const fore = gm.transformPoint(new Vec3(0, -0.03, -0.3), new Vec3());
            const poleR = new Vec3(rx * 0.8, -1, rz * 0.8).normalize();
            const poleL = new Vec3(-rx * 0.8, -1, -rz * 0.8).normalize();
            this.reach('R', grip, poleR);
            if (reloading) {
                // Left hand reaches back to the tank and returns.
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
        }

        // Victory hop.
        if (this.victory > 0) {
            const hop = Math.abs(Math.sin(this.victory * 5)) * 0.25;
            this.root.setPosition(pose.x, pose.y + hop, pose.z);
        }
    }
}
