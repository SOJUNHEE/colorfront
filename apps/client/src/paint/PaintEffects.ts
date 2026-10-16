import type { ShotTrace, TeamId, Vec3 } from '@colorfront/shared';
import {
    ADDRESS_CLAMP_TO_EDGE,
    BLEND_NORMAL,
    BUFFER_DYNAMIC,
    Color,
    Entity,
    FILTER_LINEAR_MIPMAP_LINEAR,
    Mat4,
    Mesh,
    MeshInstance,
    PIXELFORMAT_SRGBA8,
    Quat,
    SphereGeometry,
    StandardMaterial,
    Texture,
    Vec3 as PcVec3,
    VertexBuffer,
    VertexFormat
} from 'playcanvas';
import type { AppBase } from 'playcanvas';

import { PAINT_LINEAR } from './PaintRenderer.ts';

const GRAVITY = 16;
/** Visual projectile speed (m/s). The hit itself is resolved instantly by the shared hitscan. */
export const PROJECTILE_SPEED = 85;

type Droplet = {
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    size: number;
    age: number;
    life: number;
    stretch: number;
};

type Projectile = {
    team: TeamId;
    from: Vec3;
    to: Vec3;
    impact: Vec3 | null;
    normal: Vec3 | null;
    dir: Vec3;
    duration: number;
    dropDuration: number;
    age: number;
    radius: number;
    dropped: boolean;
    slug: Entity;
};

type Splat = { entity: Entity; age: number; life: number; size: number; active: boolean };

function paintMaterial(team: TeamId, emissive: number): StandardMaterial {
    const c = PAINT_LINEAR[team];
    const m = new StandardMaterial();
    m.diffuse = new Color(c[0], c[1], c[2]);
    m.emissive = new Color(c[0], c[1], c[2]);
    m.emissiveIntensity = emissive;
    m.useMetalness = true;
    m.metalness = 0;
    m.gloss = 0.92;
    m.update();
    return m;
}

/** Splat silhouette: a disc with irregular lobes and flung droplets, drawn once per team. */
function splatTexture(app: AppBase, team: TeamId): Texture {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const c = PAINT_LINEAR[team];
    const css = `rgb(${Math.round(Math.pow(c[0], 1 / 2.2) * 255)},${Math.round(Math.pow(c[1], 1 / 2.2) * 255)},${Math.round(Math.pow(c[2], 1 / 2.2) * 255)})`;
    ctx.fillStyle = css;
    ctx.translate(size / 2, size / 2);
    ctx.beginPath();
    const lobes = 11;
    for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        const r = 62 + 14 * Math.sin(a * lobes) + 9 * Math.sin(a * 5 + 1.3) + 6 * Math.sin(a * 17);
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.fill();
    // Spikes and satellite drops.
    for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2 + Math.sin(i * 12.9) * 0.2;
        const len = 80 + ((i * 37) % 40);
        ctx.beginPath();
        ctx.moveTo(Math.cos(a - 0.08) * 60, Math.sin(a - 0.08) * 60);
        ctx.lineTo(Math.cos(a) * len, Math.sin(a) * len);
        ctx.lineTo(Math.cos(a + 0.08) * 60, Math.sin(a + 0.08) * 60);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(Math.cos(a) * (len + 10), Math.sin(a) * (len + 10), 4 + (i % 4) * 2, 0, Math.PI * 2);
        ctx.fill();
    }
    const tex = new Texture(app.graphicsDevice, {
        name: `splat-${team}`,
        width: size,
        height: size,
        format: PIXELFORMAT_SRGBA8,
        mipmaps: true,
        minFilter: FILTER_LINEAR_MIPMAP_LINEAR,
        addressU: ADDRESS_CLAMP_TO_EDGE,
        addressV: ADDRESS_CLAMP_TO_EDGE
    });
    tex.setSource(canvas);
    return tex;
}

/** Hardware-instanced droplet cloud: one draw call per team regardless of droplet count. */
class DropletCloud {
    readonly droplets: Droplet[] = [];
    private readonly buffer: VertexBuffer;
    private readonly data: Float32Array;
    private readonly meshInstance: MeshInstance;
    private readonly capacity: number;
    private readonly m = new Mat4();
    private readonly q = new Quat();
    private readonly p = new PcVec3();
    private readonly s = new PcVec3();
    private readonly up = new PcVec3(0, 1, 0);
    private readonly dir = new PcVec3();

    constructor(app: AppBase, material: StandardMaterial, capacity: number, mesh: Mesh) {
        this.capacity = capacity;
        this.data = new Float32Array(capacity * 16);
        this.buffer = new VertexBuffer(
            app.graphicsDevice,
            VertexFormat.getDefaultInstancingFormat(app.graphicsDevice),
            capacity,
            { usage: BUFFER_DYNAMIC }
        );
        this.meshInstance = new MeshInstance(mesh, material);
        this.meshInstance.setInstancing(this.buffer);
        this.meshInstance.instancingCount = 0;
        const entity = new Entity('droplets');
        entity.addComponent('render', {
            meshInstances: [this.meshInstance],
            castShadows: false,
            receiveShadows: false
        });
        app.root.addChild(entity);
    }

    spawn(d: Droplet) {
        if (this.droplets.length >= this.capacity) this.droplets.shift();
        this.droplets.push(d);
    }

    update(dt: number) {
        let n = 0;
        for (let i = this.droplets.length - 1; i >= 0; i--) {
            const d = this.droplets[i];
            d.age += dt;
            if (d.age >= d.life || d.y < -2) {
                this.droplets.splice(i, 1);
                continue;
            }
            d.vy -= GRAVITY * dt;
            d.x += d.vx * dt;
            d.y += d.vy * dt;
            d.z += d.vz * dt;
        }
        for (const d of this.droplets) {
            const speed = Math.hypot(d.vx, d.vy, d.vz);
            const shrink = 1 - Math.pow(d.age / d.life, 3);
            const r = d.size * shrink;
            if (speed > 0.01) {
                this.dir.set(d.vx / speed, d.vy / speed, d.vz / speed);
                this.q.setFromDirections(this.up, this.dir);
            } else this.q.set(0, 0, 0, 1);
            this.p.set(d.x, d.y, d.z);
            // Stretch along the motion for a liquid streak.
            this.s.set(r, r * (1 + Math.min(3, speed * d.stretch)), r);
            this.m.setTRS(this.p, this.q, this.s);
            this.data.set(this.m.data, n * 16);
            n++;
        }
        this.buffer.setData(this.data);
        this.meshInstance.instancingCount = n;
    }
}

/**
 * Shot visuals: a glossy paint slug flying from the muzzle (with trailing drops), then a
 * directional splash, a radial splat that spreads to the paint radius, and flung droplets.
 * Purely cosmetic; the scored paint is drawn by PaintRenderer from the grid.
 */
export class PaintEffects {
    private readonly projectiles: Projectile[] = [];
    private readonly clouds: Record<TeamId, DropletCloud>;
    private readonly slugs: Record<TeamId, Entity[]>;
    private readonly splats: Record<TeamId, Splat[]>;
    private readonly flash: Entity[] = [];
    private readonly flashAge: number[] = [];
    private readonly tmpQ = new Quat();
    private readonly tmpN = new PcVec3();
    private readonly up = new PcVec3(0, 1, 0);
    budget: number;

    constructor(app: AppBase, budget: number) {
        this.budget = budget;
        const sphere = Mesh.fromGeometry(
            app.graphicsDevice,
            new SphereGeometry({ radius: 0.5, latitudeBands: 8, longitudeBands: 10 })
        );
        const capacity = 400;
        this.clouds = {
            blue: new DropletCloud(app, paintMaterial('blue', 0.35), capacity, sphere),
            orange: new DropletCloud(app, paintMaterial('orange', 0.35), capacity, sphere)
        };
        const slugMat = { blue: paintMaterial('blue', 1.6), orange: paintMaterial('orange', 1.6) };
        const make = (team: TeamId) => {
            const e = new Entity(`slug-${team}`);
            e.addComponent('render', { type: 'sphere', material: slugMat[team], castShadows: false });
            e.enabled = false;
            app.root.addChild(e);
            return e;
        };
        this.slugs = {
            blue: Array.from({ length: 24 }, () => make('blue')),
            orange: Array.from({ length: 24 }, () => make('orange'))
        };
        const splatMat = (team: TeamId) => {
            const tex = splatTexture(app, team);
            const m = new StandardMaterial();
            m.diffuse = new Color(1, 1, 1);
            m.diffuseMap = tex;
            m.opacityMap = tex;
            m.opacityMapChannel = 'a';
            m.blendType = BLEND_NORMAL;
            m.depthWrite = false;
            m.emissive = new Color(1, 1, 1);
            m.emissiveMap = tex;
            m.emissiveIntensity = 0.6;
            m.gloss = 0.9;
            m.useMetalness = true;
            m.update();
            return m;
        };
        const splatPool = (team: TeamId) => {
            const material = splatMat(team);
            return Array.from({ length: 12 }, () => {
                const e = new Entity(`splat-${team}`);
                e.addComponent('render', { type: 'plane', material, castShadows: false, receiveShadows: false });
                e.enabled = false;
                app.root.addChild(e);
                return { entity: e, age: 0, life: 0.35, size: 1, active: false };
            });
        };
        this.splats = { blue: splatPool('blue'), orange: splatPool('orange') };
        const flashMat = new StandardMaterial();
        flashMat.diffuse = new Color(0, 0, 0);
        flashMat.emissive = new Color(1, 0.95, 0.85);
        flashMat.emissiveIntensity = 6;
        flashMat.useLighting = false;
        flashMat.update();
        for (let i = 0; i < 8; i++) {
            const e = new Entity('muzzle-flash');
            e.addComponent('render', { type: 'sphere', material: flashMat, castShadows: false });
            e.enabled = false;
            app.root.addChild(e);
            this.flash.push(e);
            this.flashAge.push(1);
        }
    }

    /** Start a shot's visuals. Returns the time (s) until the slug lands, for paint reveal. */
    fire(shot: ShotTrace, team: TeamId, paintRadius: number): number {
        const from = shot.origin;
        const to = shot.flightEnd;
        const dx = to.x - from.x,
            dy = to.y - from.y,
            dz = to.z - from.z;
        const len = Math.max(0.001, Math.hypot(dx, dy, dz));
        const duration = len / PROJECTILE_SPEED;
        const dropDuration =
            shot.dropped && shot.impact ? Math.sqrt((2 * Math.max(0, to.y - shot.impact.y)) / GRAVITY) : 0;
        const pool = this.slugs[team];
        const busy = new Set(this.projectiles.map((q) => q.slug));
        const slug = pool.find((e) => !busy.has(e)) ?? this.projectiles.find((q) => q.team === team)!.slug;
        this.projectiles.push({
            team,
            from,
            to,
            impact: shot.impact,
            normal: shot.normal,
            dir: { x: dx / len, y: dy / len, z: dz / len },
            duration,
            dropDuration,
            age: 0,
            radius: paintRadius,
            dropped: shot.dropped,
            slug
        });
        // Muzzle flash.
        const i = this.flashAge.indexOf(Math.max(...this.flashAge));
        this.flash[i].enabled = true;
        this.flash[i].setPosition(from.x, from.y, from.z);
        this.flashAge[i] = 0;
        // Small spray leaving the muzzle.
        for (let k = 0; k < 3; k++)
            this.drop(
                team,
                from,
                {
                    x: (dx / len) * 9 + (Math.random() - 0.5) * 2,
                    y: (dy / len) * 9 + Math.random() * 1.5,
                    z: (dz / len) * 9 + (Math.random() - 0.5) * 2
                },
                0.05,
                0.25
            );
        return duration + dropDuration;
    }

    /** Paint explosion when a player is splatted. */
    burst(team: TeamId, at: Vec3) {
        for (let k = 0; k < 46; k++) {
            const a = Math.random() * Math.PI * 2;
            const up = Math.random();
            const s = 3 + Math.random() * 7;
            this.drop(
                team,
                { x: at.x, y: at.y + 1, z: at.z },
                { x: Math.cos(a) * s * (1 - up * 0.5), y: 2 + up * 7, z: Math.sin(a) * s * (1 - up * 0.5) },
                0.08 + Math.random() * 0.14,
                0.9
            );
        }
        this.splat(team, { x: at.x, y: at.y + 0.04, z: at.z }, { x: 0, y: 1, z: 0 }, 3.2, 0.55);
    }

    /** Small hit splash on a character. */
    hitSpray(team: TeamId, at: Vec3, dir: Vec3) {
        for (let k = 0; k < 8; k++) {
            this.drop(
                team,
                at,
                {
                    x: -dir.x * 2 + (Math.random() - 0.5) * 4,
                    y: 1 + Math.random() * 3,
                    z: -dir.z * 2 + (Math.random() - 0.5) * 4
                },
                0.05 + Math.random() * 0.05,
                0.45
            );
        }
    }

    get dropletCount() {
        return this.clouds.blue.droplets.length + this.clouds.orange.droplets.length;
    }

    update(dt: number) {
        // Flight.
        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            const p = this.projectiles[i];
            p.age += dt;
            if (p.age < p.duration + p.dropDuration) {
                let x: number, y: number, z: number;
                if (p.age < p.duration) {
                    const t = p.age / p.duration;
                    x = p.from.x + (p.to.x - p.from.x) * t;
                    y = p.from.y + (p.to.y - p.from.y) * t;
                    z = p.from.z + (p.to.z - p.from.z) * t;
                } else {
                    const t = p.age - p.duration;
                    x = p.to.x;
                    z = p.to.z;
                    y = p.to.y - 0.5 * GRAVITY * t * t;
                }
                // Occasional trailing drop.
                if (Math.random() < dt * 40)
                    this.drop(
                        p.team,
                        { x, y, z },
                        { x: p.dir.x * 3, y: p.dir.y * 3 + 0.5, z: p.dir.z * 3 },
                        0.035 + Math.random() * 0.03,
                        0.3
                    );
                const slug = p.slug;
                slug.enabled = true;
                slug.setPosition(x, y, z);
                this.tmpN.set(p.dir.x, p.dir.y, p.dir.z);
                this.tmpQ.setFromDirections(this.up, this.tmpN);
                slug.setRotation(this.tmpQ);
                slug.setLocalScale(0.16, 0.55, 0.16);
                continue;
            }
            if (!this.projectiles.some((q) => q !== p && q.slug === p.slug)) p.slug.enabled = false;
            this.projectiles.splice(i, 1);
            if (p.impact && p.normal) this.impact(p);
        }
        for (let i = 0; i < this.flash.length; i++) {
            this.flashAge[i] += dt;
            const a = this.flashAge[i];
            if (a > 0.06) this.flash[i].enabled = false;
            else this.flash[i].setLocalScale(0.25 - a * 2, 0.25 - a * 2, 0.25 - a * 2);
        }
        for (const team of ['blue', 'orange'] as const) {
            for (const s of this.splats[team]) {
                if (!s.active) continue;
                s.age += dt;
                if (s.age >= s.life) {
                    s.active = false;
                    s.entity.enabled = false;
                    continue;
                }
                // Fast radial spread to full size, then shrink away as the real paint takes over.
                const grow = Math.min(1, s.age / 0.09);
                const fade = s.age < 0.15 ? 1 : 1 - (s.age - 0.15) / (s.life - 0.15);
                const d = s.size * (0.3 + 0.7 * grow) * (0.6 + 0.4 * fade);
                s.entity.setLocalScale(d, 1, d);
            }
            this.clouds[team].update(dt);
        }
    }

    private impact(p: Projectile) {
        const n = p.normal!;
        const at = p.impact!;
        // Reflect the incoming direction about the surface for a directional splash.
        const d = p.dropped ? { x: 0, y: -1, z: 0 } : p.dir;
        const dot = d.x * n.x + d.y * n.y + d.z * n.z;
        const rx = d.x - 2 * dot * n.x,
            ry = d.y - 2 * dot * n.y,
            rz = d.z - 2 * dot * n.z;
        const count = Math.max(4, Math.min(14, Math.round(this.budget / 22)));
        for (let k = 0; k < count; k++) {
            const spread = 0.9;
            let vx = rx * 5 + (Math.random() - 0.5) * 6 * spread;
            let vy = ry * 5 + Math.random() * 4;
            let vz = rz * 5 + (Math.random() - 0.5) * 6 * spread;
            // Keep droplets above the surface.
            const vn = vx * n.x + vy * n.y + vz * n.z;
            if (vn < 0) {
                vx -= 1.5 * vn * n.x;
                vy -= 1.5 * vn * n.y;
                vz -= 1.5 * vn * n.z;
            }
            this.drop(
                p.team,
                { x: at.x + n.x * 0.08, y: at.y + n.y * 0.08, z: at.z + n.z * 0.08 },
                { x: vx, y: vy, z: vz },
                0.04 + Math.random() * 0.09,
                0.55
            );
        }
        this.splat(
            p.team,
            { x: at.x + n.x * 0.045, y: at.y + n.y * 0.045, z: at.z + n.z * 0.045 },
            n,
            p.radius * 2.2,
            0.32
        );
    }

    private drop(team: TeamId, at: Vec3, v: Vec3, size: number, life: number) {
        if (this.dropletCount >= this.budget) return;
        this.clouds[team].spawn({
            x: at.x,
            y: at.y,
            z: at.z,
            vx: v.x,
            vy: v.y,
            vz: v.z,
            size,
            age: 0,
            life: life * (0.7 + Math.random() * 0.5),
            stretch: 0.08
        });
    }

    private splat(team: TeamId, at: Vec3, n: Vec3, size: number, life: number) {
        const pool = this.splats[team];
        const s = pool.find((x) => !x.active) ?? pool.reduce((a, b) => (a.age > b.age ? a : b));
        s.active = true;
        s.age = 0;
        s.life = life;
        s.size = size;
        s.entity.enabled = true;
        this.tmpN.set(n.x, n.y, n.z);
        this.tmpQ.setFromDirections(this.up, this.tmpN);
        s.entity.setRotation(this.tmpQ);
        s.entity.rotateLocal(0, Math.random() * 360, 0);
        s.entity.setPosition(at.x, at.y, at.z);
        s.entity.setLocalScale(size * 0.3, 1, size * 0.3);
    }
}
