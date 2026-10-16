import { CULLFACE_NONE, Color, StandardMaterial } from 'playcanvas';
import type { GraphicsDevice, Texture } from 'playcanvas';

import {
    concreteDeck,
    corrugated,
    facade,
    hazardStripes,
    metalCladding,
    treadPlate,
    waterRipples
} from './ProceduralTextures.ts';
import type { TextureSet } from './ProceduralTextures.ts';

export type SurfaceKind = 'deck' | 'cladding' | 'facade' | 'corrugated' | 'tread' | 'hazard' | 'water' | 'plain';

type PbrOptions = {
    set?: TextureSet;
    color?: [number, number, number];
    metalness?: number;
    gloss?: number;
    bumpiness?: number;
    emissive?: number;
    vertexColor?: boolean;
};

function pbr(name: string, o: PbrOptions): StandardMaterial {
    const m = new StandardMaterial();
    m.name = name;
    const c = o.color ?? [1, 1, 1];
    m.diffuse = new Color(c[0], c[1], c[2]);
    m.useMetalness = true;
    m.metalness = o.metalness ?? 0;
    m.gloss = o.gloss ?? 1;
    if (o.set) {
        m.diffuseMap = o.set.albedo;
        m.glossMap = o.set.albedo;
        m.glossMapChannel = 'a';
        m.normalMap = o.set.normal;
        m.bumpiness = o.bumpiness ?? 1;
        if (o.set.emissive && o.emissive) {
            m.emissiveMap = o.set.emissive;
            m.emissive = new Color(1, 1, 1);
            m.emissiveIntensity = o.emissive;
        }
    }
    if (o.vertexColor) {
        m.diffuseVertexColor = true;
        m.diffuseVertexColorChannel = 'rgb';
    }
    m.update();
    return m;
}

export function glowMaterial(name: string, color: Color, intensity: number, doubleSided = false): StandardMaterial {
    const m = new StandardMaterial();
    m.name = name;
    m.diffuse = new Color(0, 0, 0);
    m.emissive = color.clone();
    m.emissiveIntensity = intensity;
    m.useLighting = false;
    if (doubleSided) m.cull = CULLFACE_NONE;
    m.update();
    return m;
}

/**
 * Shared material library for level geometry and decor. Texture resolution follows the quality
 * preset (generated once at load).
 */
export class MaterialLibrary {
    readonly floor: StandardMaterial;
    readonly platformTop: StandardMaterial;
    readonly wall: StandardMaterial;
    readonly boundary: StandardMaterial;
    readonly facade: StandardMaterial;
    readonly roof: StandardMaterial;
    readonly container: StandardMaterial;
    readonly barrier: StandardMaterial;
    readonly tread: StandardMaterial;
    readonly hazard: StandardMaterial;
    readonly painted: StandardMaterial;
    readonly darkMetal: StandardMaterial;
    readonly water: StandardMaterial;
    readonly apron: StandardMaterial;
    readonly skyline: StandardMaterial;
    readonly marking: StandardMaterial;
    readonly neonBlue: StandardMaterial;
    readonly neonOrange: StandardMaterial;
    readonly neonWhite: StandardMaterial;
    readonly beacon: StandardMaterial;
    readonly lamp: StandardMaterial;
    private readonly textures: Texture[] = [];

    constructor(device: GraphicsDevice, textureSize: number) {
        const keep = (s: TextureSet) => {
            this.textures.push(s.albedo, s.normal);
            if (s.emissive) this.textures.push(s.emissive);
            return s;
        };
        const deck = keep(concreteDeck(device, textureSize));
        const cladding = keep(metalCladding(device, textureSize));
        const ribs = keep(corrugated(device, textureSize));
        const plate = keep(treadPlate(device, textureSize));
        const front = keep(facade(device, textureSize));
        const stripes = keep(hazardStripes(device, Math.min(256, textureSize)));
        const ripples = keep(waterRipples(device, Math.min(256, textureSize)));

        this.floor = pbr('floor', { set: deck, color: [0.92, 0.93, 0.95] });
        this.platformTop = pbr('platform-top', { set: deck, color: [1.05, 1.03, 1.0] });
        this.apron = pbr('apron', { set: deck, color: [0.7, 0.7, 0.72] });
        this.wall = pbr('wall', { set: cladding, color: [0.82, 0.86, 0.9], metalness: 0.35 });
        this.boundary = pbr('boundary', { set: cladding, color: [0.48, 0.52, 0.58], metalness: 0.4 });
        this.roof = pbr('roof', { set: cladding, color: [0.55, 0.57, 0.6], metalness: 0.3 });
        this.facade = pbr('facade', { set: front, color: [0.9, 0.92, 0.95], metalness: 0.2, emissive: 2.2 });
        this.skyline = pbr('skyline', {
            set: front,
            color: [0.34, 0.38, 0.46],
            metalness: 0.3,
            emissive: 2.6,
            bumpiness: 0.4
        });
        this.container = pbr('container', { set: ribs, metalness: 0.45, vertexColor: true });
        this.barrier = pbr('barrier', { set: deck, color: [1.4, 1.38, 1.34] });
        this.tread = pbr('tread', { set: plate, color: [0.95, 0.95, 0.95], metalness: 0.7 });
        this.hazard = pbr('hazard', { set: stripes });
        this.painted = pbr('painted-metal', { set: cladding, metalness: 0.5, vertexColor: true });
        this.darkMetal = pbr('dark-metal', { set: cladding, color: [0.25, 0.26, 0.28], metalness: 0.7 });
        this.water = pbr('water', { set: ripples, metalness: 0, bumpiness: 0.35 });
        this.marking = pbr('marking', { color: [1, 1, 1], gloss: 0.35, vertexColor: true });

        this.neonBlue = glowMaterial('neon-blue', new Color(0.25, 0.6, 1), 3.2);
        this.neonOrange = glowMaterial('neon-orange', new Color(1, 0.52, 0.15), 3.2);
        this.neonWhite = glowMaterial('neon-white', new Color(0.85, 0.95, 1), 2.4);
        this.beacon = glowMaterial('beacon', new Color(1, 0.12, 0.08), 5);
        this.lamp = glowMaterial('lamp', new Color(1, 0.85, 0.6), 4);
    }

    destroy() {
        for (const t of this.textures) t.destroy();
    }
}
