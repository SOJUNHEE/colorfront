import type { PaintGrid } from './PaintGrid.ts';

/**
 * Binary paint replication (GDD 6.3).
 *
 * Snapshot (new client / reconnect / resync):
 *   u8 kind=1 | u32 seq | u16 surfaceCount | per surface: u16 cols, u16 rows, u32 rleBytes, RLE
 *   RLE = repeated [u8 owner, varint runLength].
 * Delta (every few ticks while something changed):
 *   u8 kind=2 | u32 seq | u32 tick | u16 rectCount | per rect: u8 surface, u16 c0, u16 r0, u16 w,
 *   u16 h, RLE of the w*h owner bytes (row-major). Rects come from 8×8-cell dirty tiles.
 * `seq` increases by one per delta, so a client detects any gap and asks for a resync. The client
 * never computes ownership itself; it only copies these bytes into its PaintGrid.
 */
export const PAINT_SNAPSHOT = 1;
export const PAINT_DELTA = 2;

class Writer {
    private buf: Uint8Array;
    private view: DataView;
    length = 0;

    constructor(capacity = 256) {
        this.buf = new Uint8Array(capacity);
        this.view = new DataView(this.buf.buffer);
    }

    private ensure(n: number) {
        if (this.length + n <= this.buf.length) return;
        let cap = this.buf.length * 2;
        while (cap < this.length + n) cap *= 2;
        const next = new Uint8Array(cap);
        next.set(this.buf.subarray(0, this.length));
        this.buf = next;
        this.view = new DataView(next.buffer);
    }

    u8(v: number) {
        this.ensure(1);
        this.buf[this.length++] = v;
    }

    u16(v: number) {
        this.ensure(2);
        this.view.setUint16(this.length, v, true);
        this.length += 2;
    }

    u32(v: number) {
        this.ensure(4);
        this.view.setUint32(this.length, v >>> 0, true);
        this.length += 4;
    }

    varint(v: number) {
        while (v >= 0x80) {
            this.u8((v & 0x7f) | 0x80);
            v = Math.floor(v / 128);
        }
        this.u8(v);
    }

    bytes(src: Uint8Array) {
        this.ensure(src.length);
        this.buf.set(src, this.length);
        this.length += src.length;
    }

    patchU32(at: number, v: number) {
        this.view.setUint32(at, v >>> 0, true);
    }

    finish(): Uint8Array {
        return this.buf.slice(0, this.length);
    }
}

class Reader {
    private readonly view: DataView;
    pos = 0;
    readonly bytes: Uint8Array;

    constructor(bytes: Uint8Array) {
        this.bytes = bytes;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }

    private need(n: number) {
        if (this.pos + n > this.bytes.length) throw new RangeError('truncated paint message');
    }

    u8() {
        this.need(1);
        return this.bytes[this.pos++];
    }

    u16() {
        this.need(2);
        const v = this.view.getUint16(this.pos, true);
        this.pos += 2;
        return v;
    }

    u32() {
        this.need(4);
        const v = this.view.getUint32(this.pos, true);
        this.pos += 4;
        return v;
    }

    varint() {
        let v = 0;
        let scale = 1;
        for (let i = 0; i < 5; i++) {
            const b = this.u8();
            v += (b & 0x7f) * scale;
            if (b < 0x80) return v;
            scale *= 128;
        }
        throw new RangeError('bad varint');
    }
}

export function encodePaintSnapshot(paint: PaintGrid, seq: number): Uint8Array {
    const w = new Writer(4096);
    w.u8(PAINT_SNAPSHOT);
    w.u32(seq);
    w.u16(paint.surfaces.length);
    for (const s of paint.surfaces) {
        w.u16(s.cols);
        w.u16(s.rows);
        const lenAt = w.length;
        w.u32(0);
        const start = w.length;
        const owners = paint.owners[s.index];
        let i = 0;
        while (i < owners.length) {
            const v = owners[i];
            let run = 1;
            while (i + run < owners.length && owners[i + run] === v) run++;
            w.u8(v);
            w.varint(run);
            i += run;
        }
        w.patchU32(lenAt, w.length - start);
    }
    return w.finish();
}

/**
 * Collect every surface's changed rectangle since the last call into one delta, or null when
 * nothing changed. Consumes the grid's dirty rects (the server's grid feeds only the network).
 */
export function encodePaintDelta(paint: PaintGrid, seq: number, tick: number): Uint8Array | null {
    const rects: [number, number, number, number, number][] = [];
    for (const s of paint.surfaces) {
        for (const r of paint.takeDirtyRects(s.index)) rects.push([s.index, r[0], r[1], r[2], r[3]]);
    }
    if (rects.length === 0) return null;
    const w = new Writer(256);
    w.u8(PAINT_DELTA);
    w.u32(seq);
    w.u32(tick);
    w.u16(rects.length);
    for (const [si, c0, r0, rw, rh] of rects) {
        const cols = paint.surfaces[si].cols;
        const owners = paint.owners[si];
        w.u8(si);
        w.u16(c0);
        w.u16(r0);
        w.u16(rw);
        w.u16(rh);
        // RLE across the rect in row-major order.
        let v = owners[r0 * cols + c0];
        let run = 0;
        for (let row = 0; row < rh; row++) {
            const at = (r0 + row) * cols + c0;
            for (let col = 0; col < rw; col++) {
                const o = owners[at + col];
                if (o === v) {
                    run++;
                } else {
                    w.u8(v);
                    w.varint(run);
                    v = o;
                    run = 1;
                }
            }
        }
        w.u8(v);
        w.varint(run);
    }
    return w.finish();
}

export type PaintMessageInfo = { kind: typeof PAINT_SNAPSHOT | typeof PAINT_DELTA; seq: number; changed: number };

/** Read only the kind and sequence number of a paint message. */
export function peekPaintMessage(bytes: Uint8Array): { kind: number; seq: number } {
    const r = new Reader(bytes);
    return { kind: r.u8(), seq: r.u32() };
}

/** Apply a snapshot or delta to a client-side grid. Throws on malformed or mismatched data. */
export function applyPaintMessage(paint: PaintGrid, bytes: Uint8Array): PaintMessageInfo {
    const r = new Reader(bytes);
    const kind = r.u8();
    const seq = r.u32();
    let changed = 0;
    if (kind === PAINT_SNAPSHOT) {
        const count = r.u16();
        if (count !== paint.surfaces.length) throw new RangeError('surface count mismatch');
        for (let si = 0; si < count; si++) {
            const s = paint.surfaces[si];
            const cols = r.u16();
            const rows = r.u16();
            if (cols !== s.cols || rows !== s.rows) throw new RangeError('surface size mismatch');
            const len = r.u32();
            const end = r.pos + len;
            const full = new Uint8Array(cols * rows);
            let i = 0;
            while (r.pos < end) {
                const v = r.u8();
                const run = r.varint();
                if (i + run > full.length) throw new RangeError('rle overflow');
                full.fill(v, i, i + run);
                i += run;
            }
            if (i !== full.length) throw new RangeError('rle underflow');
            changed += paint.applyRect(si, 0, 0, cols, rows, full);
        }
        return { kind: PAINT_SNAPSHOT, seq, changed };
    }
    if (kind === PAINT_DELTA) {
        r.u32(); // server tick (diagnostics)
        const count = r.u16();
        for (let k = 0; k < count; k++) {
            const si = r.u8();
            const c0 = r.u16();
            const r0 = r.u16();
            const w = r.u16();
            const h = r.u16();
            const n = w * h;
            const cells = new Uint8Array(n);
            let i = 0;
            while (i < n) {
                const v = r.u8();
                const run = r.varint();
                if (run === 0 || i + run > n) throw new RangeError('bad paint rect rle');
                cells.fill(v, i, i + run);
                i += run;
            }
            changed += paint.applyRect(si, c0, r0, w, h, cells);
        }
        return { kind: PAINT_DELTA, seq, changed };
    }
    throw new RangeError(`unknown paint message ${kind}`);
}

export type PaintReceiveResult = 'applied' | 'stale' | 'waiting' | 'gap';

/**
 * Client-side ordering for paint messages. Deltas only apply on top of the exact previous
 * sequence; before the first snapshot, or after a gap until the next snapshot, deltas are
 * ignored. On `gap` the caller asks the server for a fresh snapshot (once).
 */
export class PaintReceiver {
    readonly paint: PaintGrid;
    seq = -1;
    resyncing = false;
    snapshots = 0;
    deltas = 0;
    gaps = 0;
    bytes = 0;
    /** Local time (ms) the last applied message arrived; for sync-delay measurement. */
    lastAppliedAt = 0;

    constructor(paint: PaintGrid) {
        this.paint = paint;
    }

    receive(bytes: Uint8Array, now = 0): PaintReceiveResult {
        this.bytes += bytes.length;
        const head = peekPaintMessage(bytes);
        if (head.kind === PAINT_DELTA) {
            if (this.seq < 0) return 'waiting';
            if (this.resyncing) return 'waiting';
            if (head.seq <= this.seq) return 'stale';
            if (head.seq !== this.seq + 1) {
                this.gaps++;
                this.resyncing = true;
                return 'gap';
            }
            applyPaintMessage(this.paint, bytes);
            this.deltas++;
        } else {
            // A snapshot is authoritative regardless of what we had.
            applyPaintMessage(this.paint, bytes);
            this.snapshots++;
            this.resyncing = false;
        }
        this.seq = head.seq;
        this.lastAppliedAt = now;
        return 'applied';
    }
}
