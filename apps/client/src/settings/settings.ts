export type GraphicsQuality = 'low' | 'medium' | 'high';
export type RenderScale = 0.5 | 0.75 | 1;

export type GameSettings = {
    quality: GraphicsQuality;
    renderScale: RenderScale;
    /** Multiplier on the base mouse sensitivity. */
    sensitivity: number;
    invertY: boolean;
    /** Vertical field of view in degrees (hip fire). */
    fov: number;
    showFps: boolean;
    /** Recoil camera kick and impact shake (GDD 5.1 accessibility: can be turned off). */
    cameraShake: boolean;
};

export const DEFAULT_SETTINGS: GameSettings = {
    quality: 'medium',
    renderScale: 1,
    sensitivity: 1,
    invertY: false,
    fov: 70,
    showFps: true,
    cameraShake: true
};

export type QualityProfile = {
    shadows: boolean;
    shadowResolution: number;
    shadowDistance: number;
    cascades: number;
    /** Cap on devicePixelRatio before render scale is applied. */
    maxPixelRatio: number;
    fog: boolean;
    /** none: direct render; standard: HDR + bloom + grading + 2x MSAA; full: + SSAO, 4x MSAA. */
    post: 'none' | 'standard' | 'full';
    /** Paint shader detail: 0 flat edges only, 1 + liquid relief, 2 + fine ripples. */
    paintDetail: 0 | 1 | 2;
    /** Pooled splash droplets alive at once (all shooters share the pool). */
    particleBudget: number;
    /** Decorative props and skyline density, 0..1. */
    decorDensity: number;
    /** Beyond this distance (m) other characters use the cheap pose path and hide small parts. */
    characterLodDistance: number;
};

export const QUALITY_PROFILES: Readonly<Record<GraphicsQuality, QualityProfile>> = {
    low: {
        shadows: false,
        shadowResolution: 512,
        shadowDistance: 0,
        cascades: 1,
        maxPixelRatio: 1,
        fog: false,
        post: 'none',
        paintDetail: 0,
        particleBudget: 48,
        decorDensity: 0.35,
        characterLodDistance: 14
    },
    medium: {
        shadows: true,
        shadowResolution: 1024,
        shadowDistance: 60,
        cascades: 1,
        maxPixelRatio: 1.5,
        fog: true,
        post: 'standard',
        paintDetail: 1,
        particleBudget: 160,
        decorDensity: 0.75,
        characterLodDistance: 24
    },
    high: {
        shadows: true,
        shadowResolution: 2048,
        shadowDistance: 110,
        cascades: 2,
        maxPixelRatio: 2,
        fog: true,
        post: 'full',
        paintDetail: 2,
        particleBudget: 320,
        decorDensity: 1,
        characterLodDistance: 40
    }
};

const STORAGE_KEY = 'colorfront.settings.v1';

const isQuality = (v: unknown): v is GraphicsQuality => v === 'low' || v === 'medium' || v === 'high';
const isScale = (v: unknown): v is RenderScale => v === 0.5 || v === 0.75 || v === 1;
const num = (v: unknown, min: number, max: number, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

/** Merge untrusted stored data over defaults, dropping anything invalid. */
export function normaliseSettings(raw: unknown): GameSettings {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
        quality: isQuality(r.quality) ? r.quality : DEFAULT_SETTINGS.quality,
        renderScale: isScale(r.renderScale) ? r.renderScale : DEFAULT_SETTINGS.renderScale,
        sensitivity: num(r.sensitivity, 0.1, 3, DEFAULT_SETTINGS.sensitivity),
        invertY: typeof r.invertY === 'boolean' ? r.invertY : DEFAULT_SETTINGS.invertY,
        fov: num(r.fov, 55, 100, DEFAULT_SETTINGS.fov),
        showFps: typeof r.showFps === 'boolean' ? r.showFps : DEFAULT_SETTINGS.showFps,
        cameraShake: typeof r.cameraShake === 'boolean' ? r.cameraShake : DEFAULT_SETTINGS.cameraShake
    };
}

export function loadSettings(): GameSettings {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        return normaliseSettings(stored ? JSON.parse(stored) : null);
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

export function saveSettings(settings: GameSettings): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
        // Storage can be unavailable (private mode, blocked site data); settings then last for the session.
    }
}
