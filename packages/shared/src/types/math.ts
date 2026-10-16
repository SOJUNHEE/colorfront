export interface Vec3 {
    x: number;
    y: number;
    z: number;
}

export interface Vec2 {
    x: number;
    z: number;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
