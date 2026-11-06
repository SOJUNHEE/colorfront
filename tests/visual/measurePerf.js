// Render-cost benchmark for the Playwright MCP `browser_run_code_unsafe` tool (filename mode).
// Usage: navigate to `about:blank#<label>` (optionally `#<label>:bots`) first, then run this file.
// Measures synchronous frame cost (update + render + gl.finish, so the GPU work is included and
// browser rAF throttling cannot skew it), draw calls, primitives and VRAM for each quality preset
// from the same camera position over the same paint layout.
async (page) => {
    // `#label[:bots][?avatar=legacy]`
    const [head, query] = (decodeURIComponent(new URL(page.url()).hash.slice(1)) || 'perf').split('?');
    const [label, mode] = head.split(':');
    page.setDefaultTimeout(120000);
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('http://localhost:5173/' + (query ? '?' + query : ''));
    await page.waitForFunction(() => window.__colorfront && window.__colorfront.game);
    // Phase 6: wait until GLB avatars are loaded (or the legacy fallback has settled).
    await page.waitForFunction(() => { const av = window.__colorfront.game.debugAvatars; return !av || av.status !== 'loading'; });
    await page.waitForTimeout(1500);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    const result = await page.evaluate(async (mode) => {
        const { app, game: g } = window.__colorfront;
        g.input.destroy();
        g.input.locked = true;
        document.querySelector('.menu-backdrop')?.classList.add('hidden');
        const device = app.graphicsDevice;
        const gl = device.gl;
        const p = g.debugPaint;
        p.clear();
        const blob = (x, y, z, team, n, spread) => { for (let i = 0; i < n; i++) { const a = i * 2.39996; const r = spread * Math.sqrt(i / n); p.paintSphere({ x: x + Math.cos(a) * r, y, z: z + Math.sin(a) * r }, 1.2, team); } };
        blob(-6, 0, 6, 'blue', 40, 6);
        blob(8, 0, -4, 'orange', 40, 6);
        blob(-40, 0, 2, 'blue', 30, 8);
        if (mode === 'bots' && g.debugSpawnBots) g.debugSpawnBots(29);
        // Phase 6 Gate 3: bots wear random outfits; measure only once every outfit is on.
        for (let i = 0; i < 200 && g.debugAvatars && g.debugAvatars.outfitPending > 0; i++) await new Promise((r) => setTimeout(r, 50));
        const outfitsPendingAtStart = g.debugAvatars ? g.debugAvatars.outfitPending : null;

        const s = g.debugState;
        s.position.x = -28; s.position.y = 0; s.position.z = 4; g.copyPrevious();
        g.input.yaw = -Math.PI / 2 + 0.15; g.input.pitch = -0.12;

        const vram = () => { const v = device._vram; return Math.round((v.tex + v.vb + v.ib + (v.ub || 0) + (v.sb || 0)) / 1048576); };
        const frame = () => { g.update(1 / 60); device._drawCallsPerFrame = 0; device._primitiveCount = 0; app.render(); };
        const out = { mode: mode || 'solo', size: [device.width, device.height], presets: {} };
        for (const quality of ['low', 'medium', 'high']) {
            g.settings = { ...g.settings, quality, renderScale: 1 };
            g.applySettings();
            for (let i = 0; i < 40; i++) frame();
            gl.finish();
            const samples = [];
            let draws = 0;
            let prims = 0;
            for (let i = 0; i < 90; i++) {
                const t0 = performance.now();
                frame();
                gl.finish();
                samples.push(performance.now() - t0);
                draws = device._drawCallsPerFrame;
                prims = device._primitiveCount ?? 0;
            }
            samples.sort((a, b) => a - b);
            const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
            out.presets[quality] = {
                avgMs: +avg.toFixed(2),
                p95Ms: +samples[Math.floor(samples.length * 0.95)].toFixed(2),
                estFps: Math.round(1000 / avg),
                drawCalls: draws,
                primitives: prims,
                vramMB: vram()
            };
        }
        out.outfitsPendingAtStart = outfitsPendingAtStart;
        out.jsHeapMB = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
        out.renderer = (() => { const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'n/a'; })();
        return out;
    }, mode);
    return { label, ...result, errors: errors.slice(0, 5) };
}
