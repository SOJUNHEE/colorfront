import { PaintOwner, surfaceTopAt } from '@colorfront/shared';
import type { PaintGrid, PaintSurface } from '@colorfront/shared';
import {
    ADDRESS_CLAMP_TO_EDGE,
    Color,
    Entity,
    FILTER_LINEAR,
    Mesh,
    MeshInstance,
    PIXELFORMAT_RGBA8,
    SHADERLANGUAGE_GLSL,
    StandardMaterial,
    Texture
} from 'playcanvas';
import type { AppBase } from 'playcanvas';

/** Lift above the surface to avoid z-fighting with the level geometry. */
const OVERLAY_LIFT = 0.03;

/** Linear-space paint colours (saturated, slightly deeper than the HUD so highlights read). */
export const PAINT_LINEAR = {
    blue: [0.03, 0.2, 1.0] as const,
    orange: [1.0, 0.27, 0.02] as const
};

/**
 * Paint surface shader, replacing four standard-material chunks.
 *
 * Data contract: the field texture has one texel per scored cell (R = blue, G = orange) and is
 * sampled bilinearly, so at every cell centre the field equals that cell's owner exactly. All
 * noise perturbations are bounded (|edge noise| ≤ 0.42 against the 0.5 threshold, |team noise|
 * ≤ 0.8 against a ±1 difference), which guarantees that the colour drawn at every cell centre is
 * the authoritative owner. Only the shape *between* cell centres is decorative.
 */
function paintChunks(detail: 0 | 1 | 2) {
    const opacity = /* glsl */ `
uniform sampler2D paintField;
uniform vec3 paintBlue;
uniform vec3 paintOrange;
uniform float paintTime;

float gPaintEdge;
float gPaintBlue;
float gPaintTotal;

float pcHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float pcNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(pcHash(i), pcHash(i + vec2(1.0, 0.0)), u.x), mix(pcHash(i + vec2(0.0, 1.0)), pcHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float pcFbm(vec2 p) {
    float s = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) { s += a * pcNoise(p); p = p * 2.07 + vec2(7.1, 3.7); a *= 0.5; }
    return s / 0.9375;
}

void getOpacity() {
    vec4 f = texture2D(paintField, vUv0);
    gPaintTotal = f.r + f.g;
    vec2 wp = vPositionW.xz;
    // Splat-like irregular rims: lobes + fine ripples, bounded to +-0.42 in total (< 0.5).
    float n = (pcFbm(wp * 1.4) - 0.5) * 0.6 + (pcNoise(wp * 5.5) - 0.5) * 0.24;
    gPaintEdge = gPaintTotal + n;
    // Organic border between the two teams, bounded to +-0.8 against a +-1 difference.
    float m = (pcFbm(wp * 1.8 + 19.0) - 0.5) * 1.6;
    gPaintBlue = step(0.0, (f.r - f.g) + m);
    dAlpha = smoothstep(0.44, 0.56, gPaintEdge);
}
`;
    const diffuse = /* glsl */ `
void getAlbedo() {
    vec3 base = mix(paintOrange, paintBlue, gPaintBlue);
    float thick = smoothstep(0.5, 1.15, gPaintEdge);
    // Thin rims are lighter, the pooled centre deeper and more saturated.
    dAlbedo = base * mix(1.25, 0.82, thick);
}
`;
    const normal =
        detail === 0
            ? /* glsl */ `
void getNormal() { dNormalW = normalize(dVertexNormalW); }
`
            : /* glsl */ `
void getNormal() {
    vec3 N = normalize(dVertexNormalW);
    // Paint thickness profile: a rounded rim rising to a flat pool (metres).
    float h = smoothstep(0.42, 1.05, gPaintEdge) * 0.05;
    ${detail === 2 ? 'h += (pcNoise(vPositionW.xz * 3.1 + vec2(paintTime * 0.05, 0.0)) - 0.5) * 0.004 + (pcNoise(vPositionW.xz * 11.0) - 0.5) * 0.0015;' : ''}
    // Bump from screen-space derivatives (Mikkelsen surface gradient), no tangents needed.
    vec3 dpdx = dFdx(vPositionW);
    vec3 dpdy = dFdy(vPositionW);
    float dhdx = dFdx(h);
    float dhdy = dFdy(h);
    vec3 r1 = cross(dpdy, N);
    vec3 r2 = cross(N, dpdx);
    float det = dot(dpdx, r1);
    vec3 grad = sign(det) * (dhdx * r1 + dhdy * r2);
    dNormalW = normalize(abs(det) * N - grad);
}
`;
    const gloss = /* glsl */ `
void getGlossiness() {
    dGlossiness = mix(0.8, 0.95, smoothstep(0.5, 1.0, gPaintEdge)) + 0.0000001;
}
`;
    const emissive = /* glsl */ `
void getEmission() {
    // A little self-illumination keeps paint readable in shadow without blooming.
    dEmission = dAlbedo * 0.1;
}
`;
    return { opacityPS: opacity, diffusePS: diffuse, normalMapPS: normal, glossPS: gloss, emissivePS: emissive };
}

type SurfaceView = {
    surface: PaintSurface;
    texture: Texture;
    meshInstance: MeshInstance;
    uploadedRevision: number;
    /** Do not reveal changes before this time (projectile still in flight). */
    holdUntil: number;
};

/**
 * Draws the authoritative PaintGrid as glossy liquid paint. Each surface keeps a one-texel-per-cell
 * field texture that is re-uploaded only when that surface's revision changes.
 */
export class PaintRenderer {
    private readonly views: SurfaceView[] = [];
    private readonly paint: PaintGrid;
    private readonly app: AppBase;
    private material: StandardMaterial | null = null;
    private time = 0;
    uploadsThisFrame = 0;

    constructor(app: AppBase, paint: PaintGrid, detail: 0 | 1 | 2) {
        this.app = app;
        this.paint = paint;
        const root = new Entity('paint');
        for (const surface of paint.surfaces) {
            const texture = new Texture(app.graphicsDevice, {
                name: `paint-${surface.solid.source.id}`,
                width: surface.cols,
                height: surface.rows,
                format: PIXELFORMAT_RGBA8,
                mipmaps: false,
                minFilter: FILTER_LINEAR,
                magFilter: FILTER_LINEAR,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE
            });
            const meshInstance = new MeshInstance(this.buildMesh(surface), new StandardMaterial());
            meshInstance.setParameter('paintField', texture);
            const entity = new Entity(`paint-${surface.solid.source.id}`);
            entity.addComponent('render', { meshInstances: [meshInstance], castShadows: false, receiveShadows: true });
            root.addChild(entity);
            const view = { surface, texture, meshInstance, uploadedRevision: -1, holdUntil: 0 };
            this.upload(view);
            this.views.push(view);
        }
        app.root.addChild(root);
        this.setDetail(detail, false);
    }

    /** Rebuild the shared paint material for a quality level. */
    setDetail(detail: 0 | 1 | 2, alphaToCoverage: boolean) {
        const m = new StandardMaterial();
        m.name = `paint-detail-${detail}`;
        m.useMetalness = true;
        m.metalness = 0;
        m.alphaTest = 0.5;
        m.alphaToCoverage = alphaToCoverage;
        // Opacity/diffuse/normal/gloss chunks only run when the matching features are enabled.
        m.opacity = 1;
        m.opacityMap = this.views[0]?.texture ?? null;
        m.opacityMapChannel = 'r';
        m.diffuse = new Color(1, 1, 1);
        m.gloss = 0.9;
        m.emissive = new Color(0.01, 0.01, 0.01);
        const chunks = m.getShaderChunks(SHADERLANGUAGE_GLSL);
        for (const [name, code] of Object.entries(paintChunks(detail))) chunks.set(name, code);
        m.shaderChunksVersion = '2.23';
        m.setParameter('paintBlue', [...PAINT_LINEAR.blue]);
        m.setParameter('paintOrange', [...PAINT_LINEAR.orange]);
        m.setParameter('paintTime', 0);
        m.update();
        this.material?.destroy();
        this.material = m;
        for (const v of this.views) v.meshInstance.material = m;
    }

    /** Keep a surface's newest paint hidden until a projectile visually lands on it. */
    hold(surfaceIndex: number, untilTime: number) {
        const v = this.views[surfaceIndex];
        if (v) v.holdUntil = Math.max(v.holdUntil, Math.min(untilTime, this.time + 0.35));
    }

    get now() {
        return this.time;
    }

    update(dt: number): void {
        this.time += dt;
        this.material?.setParameter('paintTime', this.time);
        this.uploadsThisFrame = 0;
        for (const view of this.views) {
            if (view.uploadedRevision === this.paint.surfaceRevisions[view.surface.index]) continue;
            if (view.holdUntil > this.time) continue;
            this.upload(view);
        }
    }

    /** Upload immediately regardless of holds (used by tests and after a reset). */
    flush() {
        for (const view of this.views) {
            view.holdUntil = 0;
            if (view.uploadedRevision !== this.paint.surfaceRevisions[view.surface.index]) this.upload(view);
        }
    }

    /**
     * Write the changed rectangle into the texture's persistent pixel store, then upload. Only the
     * dirty cells are touched on the CPU (a 1.2 m splat is ~25 cells, not the floor's 76,800).
     */
    private upload(view: SurfaceView) {
        const surface = view.surface;
        const owners = this.paint.owners[surface.index];
        const rect =
            view.uploadedRevision < 0
                ? [0, 0, surface.cols - 1, surface.rows - 1]
                : this.paint.takeDirty(surface.index);
        if (view.uploadedRevision < 0) this.paint.takeDirty(surface.index);
        const pixels = view.texture.lock() as Uint8Array;
        if (rect) {
            const [c0, r0, c1, r1] = rect;
            for (let row = r0; row <= r1; row++) {
                let i = row * surface.cols + c0;
                for (let col = c0; col <= c1; col++, i++) {
                    const o = owners[i];
                    const p = i * 4;
                    pixels[p] = o === PaintOwner.Blue ? 255 : 0;
                    pixels[p + 1] = o === PaintOwner.Orange ? 255 : 0;
                    pixels[p + 2] = 0;
                    pixels[p + 3] = 255;
                }
            }
        }
        view.texture.unlock();
        view.uploadedRevision = this.paint.surfaceRevisions[surface.index];
        this.uploadsThisFrame++;
    }

    /** Quad over the grid following the surface; texel centres sit exactly on cell centres. */
    private buildMesh(surface: PaintSurface): Mesh {
        const s = surface.solid;
        const x0 = surface.minX;
        const z0 = surface.minZ;
        const x1 = x0 + surface.cols * surface.cellSize;
        const z1 = z0 + surface.rows * surface.cellSize;
        const y = (x: number, z: number) => surfaceTopAt(s, x, z) + OVERLAY_LIFT;
        const positions = [x0, y(x0, z1), z1, x1, y(x1, z1), z1, x1, y(x1, z0), z0, x0, y(x0, z0), z0];
        const uvs = [0, 1, 1, 1, 1, 0, 0, 0];
        const ux = positions[3] - positions[0],
            uy = positions[4] - positions[1],
            uz = positions[5] - positions[2];
        const vx = positions[6] - positions[0],
            vy = positions[7] - positions[1],
            vz = positions[8] - positions[2];
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz);
        nx /= len;
        ny /= len;
        nz /= len;
        if (ny < 0) {
            nx = -nx;
            ny = -ny;
            nz = -nz;
        }
        const mesh = new Mesh(this.app.graphicsDevice);
        mesh.setPositions(positions);
        mesh.setNormals([nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz]);
        mesh.setUvs(0, uvs);
        mesh.setIndices([0, 1, 2, 0, 2, 3]);
        mesh.update();
        return mesh;
    }
}
