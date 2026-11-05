import type { MapDefinition, SolidTag } from '../map/types.ts';
import { type CollisionWorld, type CompiledSolid, raycast, surfaceTopAt } from '../simulation/collision.ts';
import type { Vec3 } from '../types/math.ts';
import type { TeamId } from '../types/player.ts';

/** GDD 6.1: 0.5 m cells. */
export const PAINT_CELL_SIZE = 0.5;
/** Dirty-tile edge in cells (4 m). Network deltas send whole changed tiles, not one bounding box. */
export const PAINT_DIRTY_TILE = 8;

/** Cell owner values. Every paintable cell holds exactly one of these. */
export const PaintOwner = {
    None: 0,
    Blue: 1,
    Orange: 2
} as const;
export type PaintOwner = (typeof PaintOwner)[keyof typeof PaintOwner];

export const teamOwner = (team: TeamId): PaintOwner => (team === 'blue' ? PaintOwner.Blue : PaintOwner.Orange);

/** Walkable top surfaces that count toward the score. Walls and cover are never scored. */
export const PAINTABLE_TAGS: readonly SolidTag[] = ['floor', 'platform', 'ramp', 'bridge'];

/** Height tolerance used when matching a world point to a surface or deciding occlusion. */
const SURFACE_EPSILON = 0.01;
/** How far above the surface the paint line-of-sight test aims, and how far off the hit face it starts. */
const LOS_OFFSET = 0.05;

/**
 * One independent paint layer: the top of a single paintable solid, rasterised on an XZ grid
 * (ramps are projected onto XZ, so one cell is always 0.25 m² of map footprint and scores 1).
 */
export interface PaintSurface {
    index: number;
    solid: CompiledSolid;
    minX: number;
    minZ: number;
    cols: number;
    rows: number;
    cellSize: number;
}

export interface PaintScore {
    paintable: number;
    blue: number;
    orange: number;
    unpainted: number;
}

function occludes(other: CompiledSolid, x: number, z: number, height: number): boolean {
    if (x <= other.minX || x >= other.maxX || z <= other.minZ || z >= other.maxZ) return false;
    return other.minY <= height + SURFACE_EPSILON && surfaceTopAt(other, x, z) > height + SURFACE_EPSILON;
}

/**
 * Authoritative paint ownership for a map. Pure data + math so the future server can run the
 * same code; the client renders directly from `owners`, so what is drawn is what is scored.
 */
export class PaintGrid {
    readonly surfaces: PaintSurface[] = [];
    /** owners[surface][row * cols + col] */
    readonly owners: Uint8Array[] = [];
    /** 1 = paintable, 0 = covered by geometry or inside a spawn zone. */
    readonly masks: Uint8Array[] = [];
    /** Bumped whenever a surface changes; renderers/network compare against their last copy. */
    readonly surfaceRevisions: Uint32Array;
    /**
     * Changed cell rectangle per surface since the last `takeDirty` (minCol, minRow, maxCol,
     * maxRow; empty when minCol > maxCol). Lets renderers and network deltas touch only what changed.
     */
    private readonly dirty: Int32Array;
    /** Per surface: 1 per changed PAINT_DIRTY_TILE² tile, for compact network deltas. */
    private readonly dirtyTiles: Uint8Array[] = [];
    private readonly tileCols: number[] = [];
    revision = 0;
    paintableCount = 0;
    blueCount = 0;
    orangeCount = 0;

    private readonly world: CollisionWorld;

    constructor(world: CollisionWorld, map: MapDefinition) {
        this.world = world;
        const cs = PAINT_CELL_SIZE;
        for (const solid of world.solids) {
            if (!PAINTABLE_TAGS.includes(solid.source.tag)) continue;
            const minX = Math.floor(solid.minX / cs) * cs;
            const minZ = Math.floor(solid.minZ / cs) * cs;
            const cols = Math.ceil((solid.maxX - minX) / cs - 1e-9);
            const rows = Math.ceil((solid.maxZ - minZ) / cs - 1e-9);
            const surface: PaintSurface = { index: this.surfaces.length, solid, minX, minZ, cols, rows, cellSize: cs };
            const mask = new Uint8Array(cols * rows);
            for (let row = 0; row < rows; row++) {
                const z = minZ + (row + 0.5) * cs;
                for (let col = 0; col < cols; col++) {
                    const x = minX + (col + 0.5) * cs;
                    if (x <= solid.minX || x >= solid.maxX || z <= solid.minZ || z >= solid.maxZ) continue;
                    if (map.spawnZones.some((s) => x > s.min.x && x < s.max.x && z > s.min.z && z < s.max.z)) continue;
                    const h = surfaceTopAt(solid, x, z);
                    if (world.solids.some((o) => o !== solid && occludes(o, x, z, h))) continue;
                    mask[row * cols + col] = 1;
                    this.paintableCount++;
                }
            }
            this.surfaces.push(surface);
            this.masks.push(mask);
            this.owners.push(new Uint8Array(cols * rows));
            const tc = Math.ceil(cols / PAINT_DIRTY_TILE);
            this.tileCols.push(tc);
            this.dirtyTiles.push(new Uint8Array(tc * Math.ceil(rows / PAINT_DIRTY_TILE)));
        }
        this.surfaceRevisions = new Uint32Array(this.surfaces.length);
        this.dirty = new Int32Array(this.surfaces.length * 4);
        for (let i = 0; i < this.surfaces.length; i++) this.resetDirty(i);
    }

    private resetDirty(i: number) {
        this.dirty[i * 4] = this.dirty[i * 4 + 1] = 0x7fffffff;
        this.dirty[i * 4 + 2] = this.dirty[i * 4 + 3] = -1;
        this.dirtyTiles[i]?.fill(0);
    }

    private markDirty(i: number, c0: number, r0: number, c1: number, r1: number) {
        const d = this.dirty;
        const k = i * 4;
        if (c0 < d[k]) d[k] = c0;
        if (r0 < d[k + 1]) d[k + 1] = r0;
        if (c1 > d[k + 2]) d[k + 2] = c1;
        if (r1 > d[k + 3]) d[k + 3] = r1;
        const tiles = this.dirtyTiles[i];
        const tc = this.tileCols[i];
        const T = PAINT_DIRTY_TILE;
        for (let ty = Math.floor(r0 / T); ty <= Math.floor(r1 / T); ty++) {
            for (let tx = Math.floor(c0 / T); tx <= Math.floor(c1 / T); tx++) tiles[ty * tc + tx] = 1;
        }
    }

    /**
     * Return and clear the changed area of a surface as a few rectangles [c0, r0, w, h] built from
     * dirty tiles (horizontal runs, merged downwards when they line up). Also clears `takeDirty`.
     */
    takeDirtyRects(surfaceIndex: number): [number, number, number, number][] {
        const k = surfaceIndex * 4;
        if (this.dirty[k] > this.dirty[k + 2]) return [];
        const s = this.surfaces[surfaceIndex];
        const tiles = this.dirtyTiles[surfaceIndex];
        const tc = this.tileCols[surfaceIndex];
        const tr = tiles.length / tc;
        const T = PAINT_DIRTY_TILE;
        const rects: [number, number, number, number][] = [];
        // Rect still open per column span from the previous tile row, so equal spans grow downwards.
        let open = new Map<number, [number, number, number, number]>();
        for (let ty = 0; ty < tr; ty++) {
            const next = new Map<number, [number, number, number, number]>();
            let tx = 0;
            while (tx < tc) {
                if (!tiles[ty * tc + tx]) {
                    tx++;
                    continue;
                }
                const start = tx;
                while (tx < tc && tiles[ty * tc + tx]) tx++;
                const key = start * 65536 + tx;
                const r0 = ty * T;
                const h = Math.min(s.rows, r0 + T) - r0;
                const prev = open.get(key);
                if (prev) {
                    prev[3] += h;
                    next.set(key, prev);
                } else {
                    const c0 = start * T;
                    const rect: [number, number, number, number] = [c0, r0, Math.min(s.cols, tx * T) - c0, h];
                    rects.push(rect);
                    next.set(key, rect);
                }
            }
            open = next;
        }
        this.resetDirty(surfaceIndex);
        return rects;
    }

    /** Return and clear the changed rectangle of a surface, or null if nothing changed. */
    takeDirty(surfaceIndex: number): [number, number, number, number] | null {
        const k = surfaceIndex * 4;
        const d = this.dirty;
        if (d[k] > d[k + 2]) return null;
        const rect: [number, number, number, number] = [d[k], d[k + 1], d[k + 2], d[k + 3]];
        this.resetDirty(surfaceIndex);
        return rect;
    }

    /** Forget all pending dirty rectangles (e.g. after a full snapshot replaced them). */
    discardDirty(): void {
        for (let i = 0; i < this.surfaces.length; i++) this.resetDirty(i);
    }

    /** Reset every cell to unpainted. */
    clear(): void {
        for (let i = 0; i < this.owners.length; i++) {
            this.owners[i].fill(PaintOwner.None);
            this.surfaceRevisions[i]++;
            this.markDirty(i, 0, 0, this.surfaces[i].cols - 1, this.surfaces[i].rows - 1);
        }
        this.blueCount = 0;
        this.orangeCount = 0;
        this.revision++;
    }

    /**
     * Paint every paintable cell whose surface point lies within `radius` (3D) of `center` and is
     * visible from it. `normal` is the face normal at the impact; it is used to start the
     * visibility test just outside the surface that was hit, so paint never leaks through walls,
     * the bridge deck or cover. Repainting your own colour changes nothing (idempotent).
     * @returns number of cells whose owner changed.
     */
    paintSphere(center: Vec3, radius: number, team: TeamId, normal: Vec3 = { x: 0, y: 1, z: 0 }): number {
        const owner = teamOwner(team);
        const r2 = radius * radius;
        // Start just outside the hit face; starting exactly on it would count as being inside the solid.
        const from = { x: center.x + normal.x * LOS_OFFSET, y: center.y + normal.y * LOS_OFFSET, z: center.z + normal.z * LOS_OFFSET };
        let changed = 0;

        for (const surface of this.surfaces) {
            const s = surface.solid;
            const topMin = s.source.kind === 'ramp' ? s.minY : s.maxY;
            if (center.y - radius > s.maxY || center.y + radius < topMin) continue;
            if (center.x + radius < s.minX || center.x - radius > s.maxX) continue;
            if (center.z + radius < s.minZ || center.z - radius > s.maxZ) continue;

            const cs = surface.cellSize;
            const col0 = Math.max(0, Math.floor((center.x - radius - surface.minX) / cs));
            const col1 = Math.min(surface.cols - 1, Math.floor((center.x + radius - surface.minX) / cs));
            const row0 = Math.max(0, Math.floor((center.z - radius - surface.minZ) / cs));
            const row1 = Math.min(surface.rows - 1, Math.floor((center.z + radius - surface.minZ) / cs));
            const owners = this.owners[surface.index];
            const mask = this.masks[surface.index];
            let surfaceChanged = false;

            for (let row = row0; row <= row1; row++) {
                const z = surface.minZ + (row + 0.5) * cs;
                for (let col = col0; col <= col1; col++) {
                    const i = row * surface.cols + col;
                    if (!mask[i] || owners[i] === owner) continue;
                    const x = surface.minX + (col + 0.5) * cs;
                    const y = surfaceTopAt(s, x, z);
                    const dx = x - center.x;
                    const dy = y - center.y;
                    const dz = z - center.z;
                    if (dx * dx + dy * dy + dz * dz > r2) continue;
                    if (!this.visible(from, x, y + LOS_OFFSET, z)) continue;

                    const previous = owners[i];
                    if (previous === PaintOwner.Blue) this.blueCount--;
                    else if (previous === PaintOwner.Orange) this.orangeCount--;
                    if (owner === PaintOwner.Blue) this.blueCount++;
                    else this.orangeCount++;
                    owners[i] = owner;
                    changed++;
                    surfaceChanged = true;
                }
            }
            if (surfaceChanged) {
                this.surfaceRevisions[surface.index]++;
                this.markDirty(surface.index, col0, row0, col1, row1);
            }
        }
        if (changed > 0) this.revision++;
        return changed;
    }

    /**
     * Owner of the paintable cell under a world point standing on a surface (feet position), or
     * null when the point is not on a paintable cell.
     */
    ownerAt(x: number, y: number, z: number, tolerance = 0.15): PaintOwner | null {
        for (const surface of this.surfaces) {
            const s = surface.solid;
            if (x < s.minX || x > s.maxX || z < s.minZ || z > s.maxZ) continue;
            if (Math.abs(surfaceTopAt(s, x, z) - y) > tolerance) continue;
            const i = this.cellIndex(surface, x, z);
            if (i < 0 || !this.masks[surface.index][i]) continue;
            return this.owners[surface.index][i] as PaintOwner;
        }
        return null;
    }

    /** Row-major cell index on a surface for a world XZ, or -1 outside the grid. */
    cellIndex(surface: PaintSurface, x: number, z: number): number {
        const col = Math.floor((x - surface.minX) / surface.cellSize);
        const row = Math.floor((z - surface.minZ) / surface.cellSize);
        if (col < 0 || row < 0 || col >= surface.cols || row >= surface.rows) return -1;
        return row * surface.cols + col;
    }

    score(): PaintScore {
        return {
            paintable: this.paintableCount,
            blue: this.blueCount,
            orange: this.orangeCount,
            unpainted: this.paintableCount - this.blueCount - this.orangeCount
        };
    }

    /**
     * Overwrite a rectangle of a surface with owners received from the authoritative server.
     * Masked cells are forced to None; counts, revision and dirty rect are kept consistent.
     * @returns number of cells whose owner changed.
     */
    applyRect(surfaceIndex: number, c0: number, r0: number, w: number, h: number, data: Uint8Array, offset = 0): number {
        const surface = this.surfaces[surfaceIndex];
        if (!surface || c0 < 0 || r0 < 0 || w <= 0 || h <= 0 || c0 + w > surface.cols || r0 + h > surface.rows) {
            throw new RangeError('paint rect out of range');
        }
        const owners = this.owners[surfaceIndex];
        const mask = this.masks[surfaceIndex];
        let changed = 0;
        for (let row = 0; row < h; row++) {
            let i = (r0 + row) * surface.cols + c0;
            for (let col = 0; col < w; col++, i++) {
                const raw = data[offset + row * w + col];
                const next = mask[i] && (raw === PaintOwner.Blue || raw === PaintOwner.Orange) ? raw : PaintOwner.None;
                const prev = owners[i];
                if (prev === next) continue;
                if (prev === PaintOwner.Blue) this.blueCount--;
                else if (prev === PaintOwner.Orange) this.orangeCount--;
                if (next === PaintOwner.Blue) this.blueCount++;
                else if (next === PaintOwner.Orange) this.orangeCount++;
                owners[i] = next;
                changed++;
            }
        }
        if (changed > 0) {
            this.surfaceRevisions[surfaceIndex]++;
            this.revision++;
            this.markDirty(surfaceIndex, c0, r0, c0 + w - 1, r0 + h - 1);
        }
        return changed;
    }

    /** FNV-1a hash over every surface's owners: equal hashes mean identical paint (practically). */
    hash(): number {
        let h = 0x811c9dc5;
        for (const owners of this.owners) {
            for (let i = 0; i < owners.length; i++) {
                h ^= owners[i];
                h = Math.imul(h, 0x01000193);
            }
        }
        return h >>> 0;
    }

    /** Full scan, used by tests and future resync checks to validate the incremental counters. */
    recount(): PaintScore {
        let paintable = 0;
        let blue = 0;
        let orange = 0;
        for (let s = 0; s < this.surfaces.length; s++) {
            const owners = this.owners[s];
            const mask = this.masks[s];
            for (let i = 0; i < owners.length; i++) {
                if (!mask[i]) continue;
                paintable++;
                if (owners[i] === PaintOwner.Blue) blue++;
                else if (owners[i] === PaintOwner.Orange) orange++;
            }
        }
        return { paintable, blue, orange, unpainted: paintable - blue - orange };
    }

    private visible(from: Vec3, x: number, y: number, z: number): boolean {
        const dx = x - from.x;
        const dy = y - from.y;
        const dz = z - from.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < 1e-4) return true;
        const dir = { x: dx / dist, y: dy / dist, z: dz / dist };
        return raycast(this.world, from, dir, dist - 1e-3) === null;
    }
}

/** Paint percentage for display. Winners are always decided on raw counts, never on this. */
export const paintPercent = (count: number, paintable: number): number => (paintable > 0 ? (count / paintable) * 100 : 0);
