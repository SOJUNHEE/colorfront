import { PaintOwner, type PaintGrid, teamOwner } from '../paint/PaintGrid.ts';
import type { PlayerState } from '../types/player.ts';

/** GDD 2.2: ground speed on paint. Applied once (never stacked), only to grounded walk/sprint. */
export const PAINT_SPEED = {
    ally: 1.15,
    enemy: 0.8
} as const;

/** Speed multiplier for the paint under a grounded player's feet; 1 when airborne or unpainted. */
export function paintSpeedMultiplier(paint: PaintGrid, state: PlayerState): number {
    if (!state.grounded) return 1;
    const owner = paint.ownerAt(state.position.x, state.position.y, state.position.z);
    if (owner === null || owner === PaintOwner.None) return 1;
    return owner === teamOwner(state.team) ? PAINT_SPEED.ally : PAINT_SPEED.enemy;
}
