export type WeaponId = 'paint-rifle' | 'splash-shotgun' | 'charge-cannon' | 'paint-roller';

export interface WeaponDefinition {
    id: WeaponId;
    displayName: string;
    /** Shots per second. null for continuous weapons (roller). */
    fireRate: number | null;
    /** Paint radius in metres (roller: half of its 2 m width). */
    paintRadius: number;
    /** Maximum range in metres. */
    range: number;
    /** HP per hit (max HP for falloff/charged weapons). null = not yet defined in the GDD. */
    damage: number | null;
    /** null = no magazine or not yet defined. */
    magazineSize: number | null;
    /** null = not yet defined in the GDD. */
    reloadSeconds: number | null;
    continuous: boolean;
    /** GDD 4.2 "초기 구현": only 'mvp' weapons are playable before Phase 4+. */
    availability: 'mvp' | 'later';
}
