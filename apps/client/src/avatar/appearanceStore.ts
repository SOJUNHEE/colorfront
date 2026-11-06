import { DEFAULT_APPEARANCE, sanitizeAppearance } from '@colorfront/shared';
import type { AvatarAppearance } from '@colorfront/shared';

/** The local player's outfit, remembered on this device only (validated on load). */
const KEY = 'colorfront.appearance';

export function loadAppearance(): AvatarAppearance {
    try {
        const raw = localStorage.getItem(KEY);
        return raw ? sanitizeAppearance(JSON.parse(raw)) : { ...DEFAULT_APPEARANCE };
    } catch {
        return { ...DEFAULT_APPEARANCE };
    }
}

export function saveAppearance(a: AvatarAppearance): boolean {
    try {
        localStorage.setItem(KEY, JSON.stringify(sanitizeAppearance(a)));
        return true;
    } catch {
        return false;
    }
}

/** Small deterministic PRNG (mulberry32) for bot outfits. */
export function seededRandom(seed: number): () => number {
    let t = seed >>> 0;
    return () => {
        t = (t + 0x6d2b79f5) >>> 0;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}
