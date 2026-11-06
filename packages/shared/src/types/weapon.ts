/** Playable weapons. The order of PLAYABLE_WEAPONS (rules/weapons.ts) is the 1–4 key order. */
export type WeaponId = 'paint-rifle' | 'splash-shotgun' | 'spray-smg' | 'long-sniper';

export interface WeaponDefinition {
    id: WeaponId;
    displayName: string;
    /** Korean UI label. */
    label: string;
    /** One-line role description (Korean UI). */
    role: string;
    /** Trigger pulls per second. */
    fireRate: number;
    /** Paint radius of each pellet, metres. */
    paintRadius: number;
    /** Maximum range in metres. */
    range: number;
    /** HP per pellet that hits. */
    damage: number;
    /** Pellets per trigger pull (shotgun > 1). */
    pellets: number;
    /** Half-angle of the deterministic spread pattern, radians (0 = perfectly accurate). */
    spreadRad: number;
    magazineSize: number;
    reloadSeconds: number;
    /** Camera FOV multiplier while aiming (visual only; < 1 zooms in). */
    aimZoom: number;
}
