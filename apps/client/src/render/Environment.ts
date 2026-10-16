import {
    Color,
    Entity,
    EnvLighting,
    FOG_LINEAR,
    FOG_NONE,
    PIXELFORMAT_SRGBA8,
    SHADOW_PCF3,
    SHADOW_PCF5,
    Texture
} from 'playcanvas';
import type { AppBase, Vec3 } from 'playcanvas';

import type { QualityProfile } from '../settings/settings.ts';

/** Linear-space sky palette: late-afternoon haze over an industrial port. */
const ZENITH = [0.2, 0.33, 0.55];
const UPPER = [0.42, 0.55, 0.72];
const HORIZON = [0.96, 0.78, 0.62];
const GROUND = [0.16, 0.15, 0.16];
const SUN_COLOR = [1.0, 0.86, 0.68];

/** sRGB haze colour, a little cooler than the horizon so distant blocks recede. */
export const FOG_COLOR = new Color(0.78, 0.77, 0.8);

const smooth = (e0: number, e1: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
};
const mix3 = (a: number[], b: number[], t: number) => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t
];

/** Cheap deterministic value noise for clouds. */
function hash(x: number, y: number) {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
}
function valueNoise(x: number, y: number) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi);
    const b = hash(xi + 1, yi);
    const c = hash(xi, yi + 1);
    const d = hash(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x: number, y: number) {
    let sum = 0;
    let amp = 0.5;
    for (let i = 0; i < 5; i++) {
        sum += valueNoise(x, y) * amp;
        x *= 2.03;
        y *= 2.03;
        amp *= 0.5;
    }
    return sum;
}

function skyColor(dx: number, dy: number, dz: number, sun: Vec3): number[] {
    let col: number[];
    if (dy >= 0) {
        const t = Math.pow(dy, 0.5);
        col = mix3(HORIZON, UPPER, smooth(0, 0.35, t));
        col = mix3(col, ZENITH, smooth(0.35, 1, t));
        // Clouds: soft fbm sheets projected onto a dome, lit warm toward the sun.
        const k = 1 / (dy + 0.12);
        const c = smooth(0.48, 0.78, fbm(dx * k * 1.6 + 7.3, dz * k * 1.6 - 2.1));
        const sunSide = Math.max(0, dx * sun.x + dz * sun.z);
        const cloud = mix3([0.78, 0.76, 0.78], [1.15, 0.92, 0.75], sunSide);
        col = mix3(col, cloud, c * smooth(0.0, 0.25, dy) * 0.75);
    } else {
        col = mix3(HORIZON, GROUND, smooth(0, 0.25, -dy));
    }
    // Sun disc and glow (values above 1 survive into the HDR lighting source).
    const cosSun = Math.max(0, dx * sun.x + dy * sun.y + dz * sun.z);
    const glow = Math.pow(cosSun, 8) * 0.35 + Math.pow(cosSun, 64) * 0.6 + (cosSun > 0.9993 ? 6 : 0);
    return [col[0] + SUN_COLOR[0] * glow, col[1] + SUN_COLOR[1] * glow, col[2] + SUN_COLOR[2] * glow];
}

/** Face directions in the WebGL cubemap convention (+X, -X, +Y, -Y, +Z, -Z). */
function faceDirection(face: number, s: number, t: number): [number, number, number] {
    switch (face) {
        case 0:
            return [1, -t, -s];
        case 1:
            return [-1, -t, s];
        case 2:
            return [s, 1, t];
        case 3:
            return [s, -1, -t];
        case 4:
            return [s, -t, 1];
        default:
            return [-s, -t, -1];
    }
}

function buildSkyCubemap(app: AppBase, sun: Vec3, size = 256): Texture {
    const faces: HTMLCanvasElement[] = [];
    for (let f = 0; f < 6; f++) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d')!;
        const img = ctx.createImageData(size, size);
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const [ax, ay, az] = faceDirection(f, (2 * (x + 0.5)) / size - 1, (2 * (y + 0.5)) / size - 1);
                const len = Math.hypot(ax, ay, az);
                const c = skyColor(ax / len, ay / len, az / len, sun);
                const i = (y * size + x) * 4;
                // Linear -> sRGB bytes; the sun core clips, its glow is carried by the ambient atlas.
                img.data[i] = Math.min(255, Math.pow(Math.min(1, c[0]), 1 / 2.2) * 255);
                img.data[i + 1] = Math.min(255, Math.pow(Math.min(1, c[1]), 1 / 2.2) * 255);
                img.data[i + 2] = Math.min(255, Math.pow(Math.min(1, c[2]), 1 / 2.2) * 255);
                img.data[i + 3] = 255;
            }
        }
        ctx.putImageData(img, 0, 0);
        faces.push(canvas);
    }
    const cubemap = new Texture(app.graphicsDevice, {
        name: 'sky-cubemap',
        cubemap: true,
        width: size,
        height: size,
        format: PIXELFORMAT_SRGBA8,
        mipmaps: true
    });
    cubemap.setSource(faces);
    return cubemap;
}

/**
 * Sky, image-based lighting, sun and atmospheric fog. The sky is generated procedurally (no
 * external HDRI), then pre-filtered by the engine into an environment atlas so PBR materials and
 * the glossy paint get matching reflections and ambient light.
 */
export class SceneEnvironment {
    readonly sun: Entity;
    private readonly app: AppBase;

    constructor(app: AppBase) {
        this.app = app;
        this.sun = new Entity('sun');
        this.sun.addComponent('light', {
            type: 'directional',
            color: new Color(SUN_COLOR[0], SUN_COLOR[1], SUN_COLOR[2]),
            intensity: 2.1,
            shadowType: SHADOW_PCF3,
            shadowBias: 0.25,
            normalOffsetBias: 0.06,
            cascadeDistribution: 0.6
        });
        // Late-afternoon sun ~32° above the horizon, from the south-west.
        this.sun.setEulerAngles(58, -38, 0);
        app.root.addChild(this.sun);

        const up = this.sun.up.clone().normalize();
        const sky = buildSkyCubemap(app, up);
        const lighting = EnvLighting.generateLightingSource(sky, { size: 128 });
        const atlas = EnvLighting.generateAtlas(lighting, { size: 512 });
        lighting.destroy();
        app.scene.envAtlas = atlas;
        app.scene.skybox = sky;
        app.scene.skyboxIntensity = 1.0;
        app.scene.skyboxMip = 0;
        app.scene.ambientLight = new Color(0, 0, 0);
        app.scene.exposure = 1.0;

        app.scene.fog.color = FOG_COLOR;
        app.scene.fog.start = 140;
        app.scene.fog.end = 900;
    }

    apply(profile: QualityProfile) {
        const light = this.sun.light!;
        light.castShadows = profile.shadows;
        light.shadowType = profile.shadowResolution >= 2048 ? SHADOW_PCF5 : SHADOW_PCF3;
        if (profile.shadows) {
            light.shadowResolution = profile.shadowResolution;
            light.shadowDistance = profile.shadowDistance;
            light.numCascades = profile.cascades;
        }
        this.app.scene.fog.type = profile.fog ? FOG_LINEAR : FOG_NONE;
    }
}
