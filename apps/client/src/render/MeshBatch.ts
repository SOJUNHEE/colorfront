import { Mesh, SEMANTIC_TANGENT, calculateTangents } from 'playcanvas';
import type { GraphicsDevice } from 'playcanvas';

type V3 = [number, number, number];
export type Tint = [number, number, number];

/**
 * How a quad gets its UVs:
 * - `world`: planar projection on the dominant axis, `metres` per texture repeat (seamless
 *   across neighbouring boxes, so batched geometry never shows texture jumps);
 * - `facade`: v runs 0..1 over [y0, y1] (one storey layout per building), u along the face.
 */
export type UvMode = { kind: 'world'; metres: number } | { kind: 'facade'; y0: number; y1: number; uMetres: number };

const WHITE: Tint = [1, 1, 1];

/**
 * Accumulates static geometry (with per-vertex tint) into one mesh, so a whole category of level
 * geometry costs a single draw call. Tangents are generated for normal mapping.
 */
export class MeshBatch {
    readonly positions: number[] = [];
    readonly normals: number[] = [];
    readonly uvs: number[] = [];
    readonly colors: number[] = [];
    readonly indices: number[] = [];

    get vertexCount() {
        return this.positions.length / 3;
    }

    /** Quad a-b-c-d; winding is flipped so the front face points along `outward`. */
    quad(a: V3, b: V3, c: V3, d: V3, outward: V3, uv: UvMode, tint: Tint = WHITE) {
        const ux = b[0] - a[0],
            uy = b[1] - a[1],
            uz = b[2] - a[2];
        const vx = c[0] - a[0],
            vy = c[1] - a[1],
            vz = c[2] - a[2];
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz);
        if (len < 1e-9) return;
        nx /= len;
        ny /= len;
        nz /= len;
        let corners = [a, b, c, d];
        if (nx * outward[0] + ny * outward[1] + nz * outward[2] < 0) {
            corners = [a, d, c, b];
            nx = -nx;
            ny = -ny;
            nz = -nz;
        }
        const base = this.vertexCount;
        const ax = Math.abs(nx),
            ay = Math.abs(ny),
            az = Math.abs(nz);
        for (const p of corners) {
            this.positions.push(p[0], p[1], p[2]);
            this.normals.push(nx, ny, nz);
            this.colors.push(tint[0], tint[1], tint[2], 1);
            if (uv.kind === 'world') {
                const m = uv.metres;
                if (ay >= ax && ay >= az) this.uvs.push(p[0] / m, p[2] / m);
                else if (ax >= az) this.uvs.push(p[2] / m, p[1] / m);
                else this.uvs.push(p[0] / m, p[1] / m);
            } else {
                const along = ax >= az ? p[2] : p[0];
                this.uvs.push(along / uv.uMetres, (p[1] - uv.y0) / (uv.y1 - uv.y0));
            }
        }
        this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }

    /** Axis-aligned box. `faces` limits which sides are emitted (default: all). */
    box(min: V3, max: V3, uv: UvMode, tint: Tint = WHITE, faces = 'xXyYzZ') {
        const [x0, y0, z0] = min;
        const [x1, y1, z1] = max;
        if (faces.includes('Y')) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], uv, tint);
        if (faces.includes('y'))
            this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], uv, tint);
        if (faces.includes('X')) this.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0], uv, tint);
        if (faces.includes('x'))
            this.quad([x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0], [-1, 0, 0], uv, tint);
        if (faces.includes('Z')) this.quad([x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1], [0, 0, 1], uv, tint);
        if (faces.includes('z'))
            this.quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [0, 0, -1], uv, tint);
    }

    /** Vertical cylinder with a top cap. */
    cylinder(
        base: V3,
        radius: number,
        height: number,
        segments: number,
        uvMetres: number,
        tint: Tint = WHITE,
        bottomCap = false
    ) {
        const [cx, cy, cz] = base;
        const circumference = Math.PI * 2 * radius;
        const start = this.vertexCount;
        for (let i = 0; i <= segments; i++) {
            const a = (i / segments) * Math.PI * 2;
            const nx = Math.cos(a);
            const nz = Math.sin(a);
            const u = ((i / segments) * circumference) / uvMetres;
            for (const [y, v] of [
                [cy, 0],
                [cy + height, height / uvMetres]
            ] as const) {
                this.positions.push(cx + nx * radius, y, cz + nz * radius);
                this.normals.push(nx, 0, nz);
                this.uvs.push(u, v);
                this.colors.push(tint[0], tint[1], tint[2], 1);
            }
        }
        for (let i = 0; i < segments; i++) {
            const a = start + i * 2;
            this.indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
        }
        const caps: [number, number][] = [[cy + height, 1]];
        if (bottomCap) caps.push([cy, -1]);
        for (const [y, ny] of caps) {
            const centre = this.vertexCount;
            this.positions.push(cx, y, cz);
            this.normals.push(0, ny, 0);
            this.uvs.push(cx / uvMetres, cz / uvMetres);
            this.colors.push(tint[0], tint[1], tint[2], 1);
            for (let i = 0; i <= segments; i++) {
                const a = (i / segments) * Math.PI * 2;
                const px = cx + Math.cos(a) * radius;
                const pz = cz + Math.sin(a) * radius;
                this.positions.push(px, y, pz);
                this.normals.push(0, ny, 0);
                this.uvs.push(px / uvMetres, pz / uvMetres);
                this.colors.push(tint[0], tint[1], tint[2], 1);
            }
            for (let i = 0; i < segments; i++) {
                if (ny > 0) this.indices.push(centre, centre + i + 2, centre + i + 1);
                else this.indices.push(centre, centre + i + 1, centre + i + 2);
            }
        }
    }

    toMesh(device: GraphicsDevice): Mesh | null {
        if (this.indices.length === 0) return null;
        const mesh = new Mesh(device);
        mesh.setPositions(this.positions);
        mesh.setNormals(this.normals);
        mesh.setUvs(0, this.uvs);
        mesh.setColors(this.colors, 4);
        mesh.setVertexStream(
            SEMANTIC_TANGENT,
            calculateTangents(this.positions, this.normals, this.uvs, this.indices),
            4
        );
        mesh.setIndices(this.vertexCount > 65535 ? new Uint32Array(this.indices) : new Uint16Array(this.indices));
        mesh.update();
        return mesh;
    }
}
