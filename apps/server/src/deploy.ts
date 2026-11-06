import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (apps/server/src -> ../../..): relative STATIC_DIR is resolved from here. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Deployment settings read from the environment (see .env.example). Everything defaults to the
 * safe local-development behaviour: bind to localhost, accept any Origin, no static files.
 */
export type DeployConfig = {
    /** Allowed browser origins for the WebSocket upgrade (exact match). Empty = allow all (dev). */
    allowedOrigins: string[];
    /** Directory with the built client (apps/client/dist) to serve from the same origin, or null. */
    staticDir: string | null;
    /** Token required by /metrics (`?token=` or `Authorization: Bearer`). Null = open in dev, closed in production. */
    metricsToken: string | null;
    production: boolean;
};

export function readDeployConfig(env: NodeJS.ProcessEnv = process.env): DeployConfig {
    const production = env.NODE_ENV === 'production';
    const allowedOrigins = (env.ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((s) => s.trim().replace(/\/+$/, ''))
        .filter(Boolean);
    let staticDir: string | null = null;
    if (env.STATIC_DIR) {
        const dir = isAbsolute(env.STATIC_DIR) ? env.STATIC_DIR : resolve(REPO_ROOT, env.STATIC_DIR);
        if (existsSync(resolve(dir, 'index.html'))) staticDir = dir;
        else console.warn(`[colorfront] STATIC_DIR ${dir} has no index.html — not serving the client`);
    }
    return { allowedOrigins, staticDir, metricsToken: env.METRICS_TOKEN || null, production };
}

/**
 * Origin check for the WebSocket upgrade. Browsers always send Origin; a missing Origin means a
 * non-browser client (load tests, tools), which is allowed only when no allowlist is configured.
 * `selfHost` (the request's Host header) is always allowed so the same-origin client works even
 * if ALLOWED_ORIGINS is not set to the final URL yet.
 */
export function originAllowed(origin: string | undefined, allowed: string[], selfHost?: string): boolean {
    if (allowed.length === 0) return true;
    if (!origin) return false;
    const o = origin.replace(/\/+$/, '');
    if (allowed.includes(o)) return true;
    if (selfHost) {
        try {
            if (new URL(o).host === selfHost) return true;
        } catch {
            return false;
        }
    }
    return false;
}

export function metricsAllowed(cfg: DeployConfig, auth: string | undefined, queryToken: unknown): boolean {
    if (!cfg.metricsToken) return !cfg.production;
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    return bearer === cfg.metricsToken || queryToken === cfg.metricsToken;
}
