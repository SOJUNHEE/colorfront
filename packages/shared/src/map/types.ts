import type { Vec2, Vec3 } from '../types/math.ts';
import type { TeamId } from '../types/player.ts';

/** Visual/semantic role of a solid. Paint rules (Phase 2) will key off this. */
export type SolidTag = 'floor' | 'boundary' | 'building' | 'platform' | 'ramp' | 'bridge' | 'cover' | 'spawn-wall';

/** Axis-aligned box. */
export interface BoxSolid {
    kind: 'box';
    id: string;
    tag: SolidTag;
    min: Vec3;
    max: Vec3;
}

/**
 * Axis-aligned wedge. Its walking surface rises linearly from min.y at the low end to max.y
 * at the high end along `axis`; `ascending` +1 means the high end is at the max side of the axis.
 */
export interface RampSolid {
    kind: 'ramp';
    id: string;
    tag: SolidTag;
    min: Vec3;
    max: Vec3;
    axis: 'x' | 'z';
    ascending: 1 | -1;
}

export type Solid = BoxSolid | RampSolid;

export interface SpawnZone {
    team: TeamId;
    min: Vec2;
    max: Vec2;
    /** Facing yaw for players spawning here (radians, PlayerInput convention). */
    yaw: number;
    points: Vec3[];
}

export interface MapRegion {
    id: string;
    label: string;
    min: Vec2;
    max: Vec2;
}

export interface MapDefinition {
    id: string;
    name: string;
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
    solids: Solid[];
    spawnZones: SpawnZone[];
    /** Named areas for docs/tests (plaza, routes). Not used by collision. */
    regions: MapRegion[];
}
