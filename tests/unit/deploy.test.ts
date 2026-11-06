import { describe, expect, it } from 'vitest';

import { metricsAllowed, originAllowed, readDeployConfig } from '../../apps/server/src/deploy.ts';

describe('deployment settings', () => {
    it('defaults to open local development', () => {
        const cfg = readDeployConfig({});
        expect(cfg).toEqual({ allowedOrigins: [], staticDir: null, metricsToken: null, production: false });
        expect(originAllowed(undefined, cfg.allowedOrigins)).toBe(true);
        expect(originAllowed('http://evil.example', cfg.allowedOrigins)).toBe(true);
        expect(metricsAllowed(cfg, undefined, undefined)).toBe(true);
    });

    it('parses the origin allowlist (trims spaces and trailing slashes)', () => {
        const cfg = readDeployConfig({ ALLOWED_ORIGINS: ' https://a.example/ , https://b.example ,' });
        expect(cfg.allowedOrigins).toEqual(['https://a.example', 'https://b.example']);
    });

    it('with an allowlist: exact origins and the own host pass, others and origin-less clients fail', () => {
        const allowed = ['https://colorfront.example'];
        expect(originAllowed('https://colorfront.example', allowed)).toBe(true);
        expect(originAllowed('https://colorfront.example/', allowed)).toBe(true);
        expect(originAllowed('https://colorfront.example.evil.io', allowed)).toBe(false);
        expect(originAllowed('http://colorfront.example', allowed)).toBe(false);
        expect(originAllowed(undefined, allowed)).toBe(false);
        expect(originAllowed('null', allowed)).toBe(false);
        // Same-origin page served by this server.
        expect(originAllowed('https://cf.onrender.com', allowed, 'cf.onrender.com')).toBe(true);
        expect(originAllowed('https://other.onrender.com', allowed, 'cf.onrender.com')).toBe(false);
        expect(originAllowed('not a url', allowed, 'cf.onrender.com')).toBe(false);
    });

    it('closes /metrics in production unless the token matches', () => {
        const closed = readDeployConfig({ NODE_ENV: 'production' });
        expect(metricsAllowed(closed, undefined, undefined)).toBe(false);
        const tok = readDeployConfig({ NODE_ENV: 'production', METRICS_TOKEN: 's3cret' });
        expect(metricsAllowed(tok, undefined, undefined)).toBe(false);
        expect(metricsAllowed(tok, 'Bearer wrong', undefined)).toBe(false);
        expect(metricsAllowed(tok, 'Bearer s3cret', undefined)).toBe(true);
        expect(metricsAllowed(tok, undefined, 's3cret')).toBe(true);
        expect(metricsAllowed(tok, undefined, ['s3cret'])).toBe(false);
    });

    it('ignores a STATIC_DIR without index.html', () => {
        expect(readDeployConfig({ STATIC_DIR: 'definitely/not/here' }).staticDir).toBeNull();
    });
});
