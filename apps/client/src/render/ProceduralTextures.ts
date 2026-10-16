import {
    ADDRESS_REPEAT,
    FILTER_LINEAR,
    FILTER_LINEAR_MIPMAP_LINEAR,
    PIXELFORMAT_RGBA8,
    PIXELFORMAT_SRGBA8,
    Texture
} from 'playcanvas';
import type { GraphicsDevice } from 'playcanvas';

/**
 * Procedurally generated PBR texture sets (albedo + gloss in alpha, tangent-space normal, optional
 * emissive). Everything is original and generated at load time, so there are no third-party
 * texture licences and nothing to download.
 */
export type TextureSet = {
    /** sRGB albedo, gloss in the alpha channel. */
    albedo: Texture;
    normal: Texture;
    emissive?: Texture;
};

type Field = Float32Array;

/** Deterministic PRNG so every load generates identical textures. */
function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Tileable value noise on an n x n lattice. */
function tileNoise(size: number, cells: number, seed: number): Field {
    const r = rng(seed);
    const lattice = new Float32Array(cells * cells).map(() => r());
    const out = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
        const fy = (y / size) * cells;
        const y0 = Math.floor(fy);
        const ty = fy - y0;
        const sy = ty * ty * (3 - 2 * ty);
        for (let x = 0; x < size; x++) {
            const fx = (x / size) * cells;
            const x0 = Math.floor(fx);
            const tx = fx - x0;
            const sx = tx * tx * (3 - 2 * tx);
            const a = lattice[(y0 % cells) * cells + (x0 % cells)];
            const b = lattice[(y0 % cells) * cells + ((x0 + 1) % cells)];
            const c = lattice[((y0 + 1) % cells) * cells + (x0 % cells)];
            const d = lattice[((y0 + 1) % cells) * cells + ((x0 + 1) % cells)];
            out[y * size + x] = a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
        }
    }
    return out;
}

function fbmField(size: number, base: number, octaves: number, seed: number): Field {
    const out = new Float32Array(size * size);
    let amp = 0.5;
    let total = 0;
    for (let o = 0; o < octaves; o++) {
        const n = tileNoise(size, base << o, seed + o * 101);
        for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
        total += amp;
        amp *= 0.5;
    }
    for (let i = 0; i < out.length; i++) out[i] /= total;
    return out;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const toSrgb = (v: number) => Math.round(Math.pow(clamp01(v), 1 / 2.2) * 255);

function makeTexture(
    device: GraphicsDevice,
    name: string,
    size: number,
    pixels: Uint8ClampedArray,
    srgb: boolean
): Texture {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const img = new ImageData(pixels as unknown as Uint8ClampedArray<ArrayBuffer>, size, size);
    ctx.putImageData(img, 0, 0);
    const tex = new Texture(device, {
        name,
        width: size,
        height: size,
        format: srgb ? PIXELFORMAT_SRGBA8 : PIXELFORMAT_RGBA8,
        mipmaps: true,
        minFilter: FILTER_LINEAR_MIPMAP_LINEAR,
        magFilter: FILTER_LINEAR,
        addressU: ADDRESS_REPEAT,
        addressV: ADDRESS_REPEAT,
        anisotropy: 8
    });
    tex.setSource(canvas);
    return tex;
}

/** Tangent-space normal map from a tileable height field. */
function normalFromHeight(size: number, height: Field, strength: number): Uint8ClampedArray {
    const out = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const l = height[y * size + ((x - 1 + size) % size)];
            const r = height[y * size + ((x + 1) % size)];
            const u = height[((y - 1 + size) % size) * size + x];
            const d = height[((y + 1) % size) * size + x];
            let nx = (l - r) * strength;
            let ny = (u - d) * strength;
            let nz = 1;
            const len = Math.hypot(nx, ny, nz);
            nx /= len;
            ny /= len;
            nz /= len;
            const i = (y * size + x) * 4;
            out[i] = (nx * 0.5 + 0.5) * 255;
            out[i + 1] = (ny * 0.5 + 0.5) * 255;
            out[i + 2] = (nz * 0.5 + 0.5) * 255;
            out[i + 3] = 255;
        }
    }
    return out;
}

type Shader = (
    x: number,
    y: number,
    i: number
) => { h: number; r: number; g: number; b: number; gloss: number; e?: [number, number, number] };

function buildSet(device: GraphicsDevice, name: string, size: number, strength: number, shade: Shader): TextureSet {
    const height = new Float32Array(size * size);
    const albedo = new Uint8ClampedArray(size * size * 4);
    let emissive: Uint8ClampedArray | null = null;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = y * size + x;
            const s = shade(x, y, i);
            height[i] = s.h;
            albedo[i * 4] = toSrgb(s.r);
            albedo[i * 4 + 1] = toSrgb(s.g);
            albedo[i * 4 + 2] = toSrgb(s.b);
            albedo[i * 4 + 3] = Math.round(clamp01(s.gloss) * 255);
            if (s.e) {
                emissive ??= new Uint8ClampedArray(size * size * 4);
                emissive[i * 4] = toSrgb(s.e[0]);
                emissive[i * 4 + 1] = toSrgb(s.e[1]);
                emissive[i * 4 + 2] = toSrgb(s.e[2]);
                emissive[i * 4 + 3] = 255;
            }
        }
    }
    const set: TextureSet = {
        albedo: makeTexture(device, `${name}-albedo`, size, albedo, true),
        normal: makeTexture(device, `${name}-normal`, size, normalFromHeight(size, height, strength), false)
    };
    if (emissive) {
        for (let i = 3; i < emissive.length; i += 4) emissive[i] = 255;
        set.emissive = makeTexture(device, `${name}-emissive`, size, emissive, true);
    }
    return set;
}

const groove = (t: number, width: number) => {
    // 0 inside a seam, 1 on the panel; smooth bevel.
    const d = Math.min(t, 1 - t);
    return clamp01(d / width);
};

/** 4 m tile of concrete deck plates: 2 m panels, bevelled seams, bolts, wet patches. */
export function concreteDeck(device: GraphicsDevice, size: number): TextureSet {
    const grain = fbmField(size, 16, 4, 11);
    const blotch = fbmField(size, 4, 3, 23);
    const puddle = fbmField(size, 2, 3, 37);
    return buildSet(device, 'deck', size, 5, (x, y, i) => {
        const u = (x / size) * 2;
        const v = (y / size) * 2;
        const seam = groove(u - Math.floor(u), 0.02) * groove(v - Math.floor(v), 0.02);
        const fu = (u - Math.floor(u)) * 2;
        const fv = (v - Math.floor(v)) * 2;
        const bolt = Math.hypot(Math.abs(fu - 1) - 0.92, Math.abs(fv - 1) - 0.92) < 0.04 ? 1 : 0;
        const g = grain[i];
        const wet = clamp01((puddle[i] - 0.55) * 6);
        const base = 0.17 + g * 0.06 + (blotch[i] - 0.5) * 0.06;
        const tone = base * (0.55 + 0.45 * seam) * (1 - wet * 0.25);
        return {
            h: seam * 0.6 + g * 0.15 + bolt * 0.4,
            r: tone * 1.0,
            g: tone * 0.99,
            b: tone * 1.03,
            gloss: 0.32 + g * 0.08 + wet * 0.5 + bolt * 0.2
        };
    });
}

/** Painted metal cladding: horizontal panel seams every 1 m, rivets, rain streaks. */
export function metalCladding(device: GraphicsDevice, size: number): TextureSet {
    const grain = fbmField(size, 32, 3, 51);
    const streak = tileNoise(size, 24, 61);
    const dirt = fbmField(size, 4, 3, 71);
    return buildSet(device, 'cladding', size, 4, (x, y, i) => {
        const v = (y / size) * 4;
        const u = (x / size) * 2;
        const seam = groove(v - Math.floor(v), 0.025);
        const vseam = groove(u - Math.floor(u), 0.012);
        const rivet = Math.abs(v - Math.floor(v) - 0.08) < 0.02 && Math.abs(((u * 8) % 1) - 0.5) < 0.06 ? 1 : 0;
        // Vertical rain streaks: one noise row stretched over the full height.
        const s = streak[x] * 0.5 + dirt[i] * 0.5;
        const tone = (0.36 + grain[i] * 0.05 - s * 0.12) * (0.6 + 0.4 * seam * vseam);
        return {
            h: seam * vseam * 0.7 + rivet * 0.5 + grain[i] * 0.05,
            r: tone * 0.92,
            g: tone * 0.98,
            b: tone * 1.04,
            gloss: 0.42 + rivet * 0.2 - s * 0.15
        };
    });
}

/** Corrugated container steel (ridges every 0.25 m) with chipped paint; tinted by vertex colour. */
export function corrugated(device: GraphicsDevice, size: number): TextureSet {
    const chips = fbmField(size, 16, 4, 81);
    const rust = fbmField(size, 8, 4, 91);
    return buildSet(device, 'corrugated', size, 7, (x, _y, i) => {
        const u = (x / size) * 16;
        const ridge = 0.5 - 0.5 * Math.cos((u - Math.floor(u)) * Math.PI * 2);
        const chip = chips[i] > 0.68 ? 1 : 0;
        const rs = clamp01((rust[i] - 0.6) * 4);
        const paint = 0.8 + ridge * 0.15;
        // Chipped areas show darker bare metal; rust warms it.
        const r = chip ? 0.25 + rs * 0.2 : paint;
        const g = chip ? 0.24 + rs * 0.08 : paint;
        const b = chip ? 0.25 : paint;
        return { h: ridge * 0.8 - chip * 0.1, r, g, b, gloss: chip ? 0.5 : 0.38 + ridge * 0.08 };
    });
}

/** Diamond tread plate for ramps and the bridge, with hazard-striped edges handled in geometry. */
export function treadPlate(device: GraphicsDevice, size: number): TextureSet {
    const grain = fbmField(size, 32, 3, 101);
    const wear = fbmField(size, 4, 3, 111);
    return buildSet(device, 'tread', size, 6, (x, y, i) => {
        const u = (x / size) * 20;
        const v = (y / size) * 20;
        const cu = u - Math.floor(u) - 0.5;
        const cv = v - Math.floor(v) - 0.5;
        const alt = (Math.floor(u) + Math.floor(v)) % 2 === 0;
        // Elongated diamonds alternating direction.
        const d = alt
            ? Math.abs(cu + cv) * 2.8 + Math.abs(cu - cv) * 0.9
            : Math.abs(cu - cv) * 2.8 + Math.abs(cu + cv) * 0.9;
        const bump = clamp01(1 - d);
        const w = clamp01((wear[i] - 0.45) * 3);
        const tone = 0.42 + grain[i] * 0.06 + bump * 0.06 + w * 0.12;
        return {
            h: bump * 0.6 + grain[i] * 0.1,
            r: tone,
            g: tone * 0.98,
            b: tone * 0.95,
            gloss: 0.45 + bump * 0.2 + w * 0.2
        };
    });
}

/** Diagonal yellow/black hazard stripes. */
export function hazardStripes(device: GraphicsDevice, size: number): TextureSet {
    const grain = fbmField(size, 32, 3, 141);
    return buildSet(device, 'hazard', size, 2, (x, y, i) => {
        const t = ((x + y) / size) * 4;
        const stripe = t - Math.floor(t) < 0.5;
        const g = grain[i];
        return stripe
            ? { h: 0.5 + g * 0.1, r: 0.85 + g * 0.1, g: 0.62 + g * 0.08, b: 0.08, gloss: 0.4 }
            : { h: 0.48 + g * 0.1, r: 0.05, g: 0.05, b: 0.05, gloss: 0.35 };
    });
}

/** Gentle wind ripples for the harbour water. */
export function waterRipples(device: GraphicsDevice, size: number): TextureSet {
    const a = fbmField(size, 8, 4, 151);
    const b = fbmField(size, 16, 3, 161);
    return buildSet(device, 'water', size, 3, (_x, _y, i) => {
        const h = a[i] * 0.7 + b[i] * 0.3;
        return { h, r: 0.08, g: 0.13, b: 0.17, gloss: 0.93 };
    });
}

/**
 * Warehouse facade mapped once over a building's full height (v = 0 ground, 1 roof):
 * shutters at street level, window bands above, some windows lit (emissive).
 */
export function facade(device: GraphicsDevice, size: number): TextureSet {
    const grain = fbmField(size, 32, 3, 121);
    const r = rng(131);
    const lit = Array.from({ length: 64 }, () => r());
    return buildSet(device, 'facade', size, 4, (x, y, i) => {
        const u = x / size;
        const v = y / size; // canvas rows upload top-first: row 0 is v = 0 (the ground)
        const col = Math.floor(u * 8);
        const fu = u * 8 - col;
        let h = 0.5 + grain[i] * 0.05;
        let tone = 0.3 + grain[i] * 0.05;
        let gloss = 0.35;
        let e: [number, number, number] | undefined;
        if (v < 0.32) {
            // Roller shutters with horizontal slats.
            const slat = 0.5 - 0.5 * Math.cos(v * 160);
            const frame = fu < 0.06 || fu > 0.94 || v > 0.3;
            h = frame ? 0.9 : 0.4 + slat * 0.2;
            tone = frame ? 0.22 : 0.42 + slat * 0.06;
        } else {
            const band = Math.floor((v - 0.36) / 0.18);
            const fv = (v - 0.36) / 0.18 - band;
            const inWindow = band >= 0 && band < 3 && fu > 0.15 && fu < 0.85 && fv > 0.2 && fv < 0.75;
            if (inWindow) {
                h = 0.2;
                tone = 0.06;
                gloss = 0.85;
                const on = lit[(band * 8 + col) % 64];
                if (on > 0.55) e = on > 0.85 ? [0.55, 0.85, 1.0] : [1.0, 0.72, 0.42];
            }
            if (Math.abs(fv - 0.85) < 0.03) tone *= 0.7;
        }
        // Thin mullions on the windows.
        if (e && Math.abs(fu - 0.5) < 0.012) e = undefined;
        return { h, r: tone * 0.95, g: tone, b: tone * 1.06, gloss, e };
    });
}
