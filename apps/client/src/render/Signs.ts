import type { DecorSign, PaintScore, SignStyle } from '@colorfront/shared';
import { paintPercent } from '@colorfront/shared';
import {
    ADDRESS_CLAMP_TO_EDGE,
    BLEND_ADDITIVE,
    Color,
    Entity,
    FILTER_LINEAR,
    FILTER_LINEAR_MIPMAP_LINEAR,
    Mesh,
    MeshInstance,
    PIXELFORMAT_SRGBA8,
    StandardMaterial,
    Texture
} from 'playcanvas';
import type { AppBase } from 'playcanvas';

const STYLE: Record<SignStyle, { fg: string; bg: string; edge: string }> = {
    blue: { fg: '#5fb2ff', bg: '#0b1626', edge: '#2a7bff' },
    orange: { fg: '#ffae5c', bg: '#22140a', edge: '#ff8019' },
    neutral: { fg: '#e8f3ff', bg: '#111820', edge: '#7fe8ff' },
    warning: { fg: '#ffd23a', bg: '#1a1606', edge: '#ffd23a' },
    holo: { fg: '#9ff3ff', bg: 'rgba(0,0,0,0)', edge: '#4fe0ff' }
};

const CELL_WIDTH = 512;
const FONT = '"Segoe UI", "Malgun Gothic", system-ui, sans-serif';

function drawSign(
    ctx: CanvasRenderingContext2D,
    s: DecorSign,
    x: number,
    y: number,
    w: number,
    h: number,
    extra?: string
) {
    const st = STYLE[s.style];
    ctx.save();
    ctx.translate(x, y);
    ctx.clearRect(0, 0, w, h);
    if (s.style !== 'holo') {
        ctx.fillStyle = st.bg;
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = st.edge;
        ctx.lineWidth = Math.max(3, h * 0.05);
        ctx.strokeRect(ctx.lineWidth, ctx.lineWidth, w - ctx.lineWidth * 2, h - ctx.lineWidth * 2);
    } else {
        // Scanlines and a soft frame for the hologram.
        ctx.fillStyle = 'rgba(80,220,255,0.10)';
        for (let i = 0; i < h; i += 4) ctx.fillRect(0, i, w, 1);
        ctx.strokeStyle = 'rgba(120,235,255,0.7)';
        ctx.lineWidth = 3;
        ctx.strokeRect(4, 4, w - 8, h - 8);
    }
    const mainSize = s.sub ? h * 0.48 : h * 0.62;
    ctx.fillStyle = st.fg;
    ctx.shadowColor = st.edge;
    ctx.shadowBlur = h * 0.08;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `800 ${Math.round(mainSize)}px ${FONT}`;
    const fit = (text: string, size: number, weight: number) => {
        ctx.font = `${weight} ${Math.round(size)}px ${FONT}`;
        const scale = Math.min(1, (w * 0.88) / Math.max(1, ctx.measureText(text).width));
        ctx.font = `${weight} ${Math.round(size * scale)}px ${FONT}`;
    };
    fit(s.text, mainSize, 800);
    ctx.fillText(s.text, w / 2, s.sub ? h * 0.38 : h * 0.52);
    const sub = extra ?? s.sub;
    if (sub) {
        fit(sub, h * 0.24, 600);
        ctx.globalAlpha = 0.85;
        ctx.fillText(sub, w / 2, h * 0.76);
    }
    ctx.restore();
}

/** Corners of a sign quad (centre, size, facing) in world space, plus its outward normal. */
function signQuad(s: DecorSign) {
    const { x, y, z } = s.center;
    const hw = s.width / 2;
    const hh = s.height / 2;
    // Corners: bottom-left, bottom-right, top-right, top-left as seen from the front.
    switch (s.facing) {
        case 'x+':
            return {
                n: [1, 0, 0],
                c: [
                    [x, y - hh, z + hw],
                    [x, y - hh, z - hw],
                    [x, y + hh, z - hw],
                    [x, y + hh, z + hw]
                ]
            };
        case 'x-':
            return {
                n: [-1, 0, 0],
                c: [
                    [x, y - hh, z - hw],
                    [x, y - hh, z + hw],
                    [x, y + hh, z + hw],
                    [x, y + hh, z - hw]
                ]
            };
        case 'z+':
            return {
                n: [0, 0, 1],
                c: [
                    [x - hw, y - hh, z],
                    [x + hw, y - hh, z],
                    [x + hw, y + hh, z],
                    [x - hw, y + hh, z]
                ]
            };
        case 'z-':
            return {
                n: [0, 0, -1],
                c: [
                    [x + hw, y - hh, z],
                    [x - hw, y - hh, z],
                    [x - hw, y + hh, z],
                    [x + hw, y + hh, z]
                ]
            };
        default:
            return {
                n: [0, 1, 0],
                c: [
                    [x - hw, y, z + hh],
                    [x + hw, y, z + hh],
                    [x + hw, y, z - hh],
                    [x - hw, y, z - hh]
                ]
            };
    }
}

/**
 * Wall signs packed into one emissive atlas (one draw call), plus a spinning plaza hologram that
 * shows the live turf score.
 */
export class SignRenderer {
    private holo: Entity | null = null;
    private holoCanvas: HTMLCanvasElement | null = null;
    private holoTexture: Texture | null = null;
    private holoSign: DecorSign | null = null;
    private lastScoreKey = '';
    private time = 0;
    private readonly owned: { destroy(): void }[] = [];

    constructor(app: AppBase, signs: DecorSign[]) {
        const device = app.graphicsDevice;
        const wall = signs.filter((s) => s.style !== 'holo');
        const heights = wall.map((s) => Math.max(64, Math.round(CELL_WIDTH / (s.width / s.height))));
        const total = heights.reduce((a, b) => a + b + 4, 0);
        const atlasH = 1 << Math.ceil(Math.log2(Math.max(64, total)));
        const canvas = document.createElement('canvas');
        canvas.width = CELL_WIDTH;
        canvas.height = atlasH;
        const ctx = canvas.getContext('2d')!;
        const positions: number[] = [];
        const normals: number[] = [];
        const uvs: number[] = [];
        const indices: number[] = [];
        let cursor = 0;
        wall.forEach((s, i) => {
            const h = heights[i];
            drawSign(ctx, s, 0, cursor, CELL_WIDTH, h);
            // Canvas rows upload top-first (no flip): canvas y maps directly to v.
            const v0 = (cursor + h) / atlasH;
            const v1 = cursor / atlasH;
            const q = signQuad(s);
            const base = positions.length / 3;
            const cornerUv = [
                [0, v0],
                [1, v0],
                [1, v1],
                [0, v1]
            ];
            q.c.forEach((p, k) => {
                positions.push(p[0], p[1], p[2]);
                normals.push(q.n[0], q.n[1], q.n[2]);
                uvs.push(cornerUv[k][0], cornerUv[k][1]);
            });
            indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
            cursor += h + 4;
        });

        const atlas = new Texture(device, {
            name: 'sign-atlas',
            width: CELL_WIDTH,
            height: atlasH,
            format: PIXELFORMAT_SRGBA8,
            mipmaps: true,
            minFilter: FILTER_LINEAR_MIPMAP_LINEAR,
            magFilter: FILTER_LINEAR,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE,
            anisotropy: 8
        });
        atlas.setSource(canvas);
        const material = new StandardMaterial();
        material.diffuse = new Color(0.05, 0.05, 0.06);
        material.emissive = new Color(1, 1, 1);
        material.emissiveMap = atlas;
        material.emissiveIntensity = 1.8;
        material.useMetalness = true;
        material.gloss = 0.6;
        material.update();

        const mesh = new Mesh(device);
        mesh.setPositions(positions);
        mesh.setNormals(normals);
        mesh.setUvs(0, uvs);
        mesh.setIndices(indices);
        mesh.update();
        const entity = new Entity('signs');
        entity.addComponent('render', { meshInstances: [new MeshInstance(mesh, material)], castShadows: false });
        app.root.addChild(entity);
        this.owned.push(entity, atlas, material);

        const holo = signs.find((s) => s.style === 'holo');
        if (holo) this.buildHologram(app, holo);
    }

    private buildHologram(app: AppBase, s: DecorSign) {
        this.holoSign = s;
        this.holoCanvas = document.createElement('canvas');
        this.holoCanvas.width = 1024;
        this.holoCanvas.height = Math.round(1024 / (s.width / s.height));
        this.holoTexture = new Texture(app.graphicsDevice, {
            name: 'hologram',
            width: this.holoCanvas.width,
            height: this.holoCanvas.height,
            format: PIXELFORMAT_SRGBA8,
            mipmaps: true,
            minFilter: FILTER_LINEAR_MIPMAP_LINEAR,
            magFilter: FILTER_LINEAR
        });
        this.drawHolo(null);
        const material = new StandardMaterial();
        material.diffuse = new Color(0, 0, 0);
        material.emissive = new Color(1, 1, 1);
        material.emissiveMap = this.holoTexture;
        material.emissiveIntensity = 2.4;
        material.useLighting = false;
        material.blendType = BLEND_ADDITIVE;
        material.depthWrite = false;
        material.update();
        // Parent spins around Y; two back-to-back quads keep the text readable from both sides.
        this.holo = new Entity('hologram');
        const positions: number[] = [];
        const normals: number[] = [];
        const uvs: number[] = [];
        const indices: number[] = [];
        for (const facing of ['z+', 'z-'] as const) {
            const q = signQuad({ ...s, center: { x: 0, y: 0, z: facing === 'z+' ? 0.01 : -0.01 }, facing });
            const base = positions.length / 3;
            const cornerUv = [
                [0, 1],
                [1, 1],
                [1, 0],
                [0, 0]
            ];
            q.c.forEach((p, k) => {
                positions.push(p[0], p[1], p[2]);
                normals.push(q.n[0], q.n[1], q.n[2]);
                uvs.push(cornerUv[k][0], cornerUv[k][1]);
            });
            indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
        const mesh = new Mesh(app.graphicsDevice);
        mesh.setPositions(positions);
        mesh.setNormals(normals);
        mesh.setUvs(0, uvs);
        mesh.setIndices(indices);
        mesh.update();
        this.holo.addComponent('render', { meshInstances: [new MeshInstance(mesh, material)], castShadows: false });
        this.holo.setPosition(s.center.x, s.center.y, s.center.z);
        app.root.addChild(this.holo);
        this.owned.push(this.holo, this.holoTexture, material);
    }

    private drawHolo(score: PaintScore | null) {
        const s = this.holoSign!;
        const canvas = this.holoCanvas!;
        const ctx = canvas.getContext('2d')!;
        const sub = score
            ? `▲ ${paintPercent(score.blue, score.paintable).toFixed(1)}%   ·   ${paintPercent(score.orange, score.paintable).toFixed(1)}% ■`
            : s.sub;
        drawSign(ctx, s, 0, 0, canvas.width, canvas.height, sub);
        this.holoTexture!.setSource(canvas);
    }

    destroy() {
        for (const o of this.owned) o.destroy();
        this.owned.length = 0;
        this.holo = null;
    }

    update(dt: number, score: PaintScore) {
        if (!this.holo) return;
        this.time += dt;
        // Spin slowly with a gentle bob.
        this.holo.setEulerAngles(0, this.time * 18, 0);
        this.holo.setPosition(
            this.holoSign!.center.x,
            this.holoSign!.center.y + Math.sin(this.time * 1.3) * 0.25,
            this.holoSign!.center.z
        );
        const key = `${((score.blue * 1000) / Math.max(1, score.paintable)) | 0}/${((score.orange * 1000) / Math.max(1, score.paintable)) | 0}`;
        if (key !== this.lastScoreKey) {
            this.lastScoreKey = key;
            this.drawHolo(score);
        }
    }
}
