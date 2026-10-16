// Visual comparison capture for the Playwright MCP `browser_run_code_unsafe` tool (filename mode).
// Usage: navigate to `about:blank#<label>` first, then run this file. Screenshots are written to
// colorfront/docs/screenshots/<label>/. Every shot uses the same player placement, paint layout and
// camera pose, so "before" and "after" captures are directly comparable.
// Requires the dev server (window.__colorfront debug hooks).
async (page) => {
    const label = new URL(page.url()).hash.slice(1) || 'capture';
    const dir = `colorfront/docs/screenshots/${label}`;
    page.setDefaultTimeout(30000);
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('http://localhost:5173/');
    await page.waitForFunction(() => window.__colorfront && window.__colorfront.game);
    await page.waitForTimeout(1500);

    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    // Detach real input (so a user typing elsewhere cannot disturb the capture) and fix the camera.
    await page.evaluate(() => {
        const { app, game: g } = window.__colorfront;
        g.input.destroy();
        g.input.locked = true;
        g.input.sensitivity = 0;
        document.querySelector('.menu-backdrop')?.classList.add('hidden');
        document.getElementById('ui-root').style.visibility = 'hidden';
        document.querySelector('.inspector-hint')?.remove();
        const cam = app.root.findByName('camera');
        window.__pose = null;
        const follow = g.followCamera.update.bind(g.followCamera);
        g.followCamera.update = (dt, t) => {
            if (!window.__pose) return follow(dt, t);
            const [p, q, fov] = window.__pose;
            cam.setPosition(p[0], p[1], p[2]);
            cam.lookAt(q[0], q[1], q[2]);
            if (fov) cam.camera.fov = fov;
        };
        window.__place = (x, y, z, yaw, pitch = 0) => {
            const s = g.debugState;
            s.position.x = x; s.position.y = y; s.position.z = z;
            s.velocity.x = s.velocity.y = s.velocity.z = 0;
            g.copyPrevious();
            g.input.yaw = yaw; g.input.pitch = pitch;
        };
        window.__step = (sec, dt = 1 / 60) => { for (let i = 0; i < Math.round(sec / dt); i++) g.update(dt); };
        window.__freeze = (on) => { app.timeScale = on ? 0 : 1; };
        // Deterministic paint layout shared by all shots.
        const p = g.debugPaint;
        p.clear();
        const blob = (x, y, z, team, n = 1, spread = 0) => { for (let i = 0; i < n; i++) { const a = i * 2.39996; const r = spread * Math.sqrt(i / Math.max(1, n)); p.paintSphere({ x: x + Math.cos(a) * r, y, z: z + Math.sin(a) * r }, 1.2, team); } };
        blob(-6, 0, 6, 'blue', 40, 6);      // plaza west, blue
        blob(8, 0, -4, 'orange', 40, 6);    // plaza east, orange
        blob(1, 0, 1.5, 'orange', 12, 3);   // contested middle: orange over blue
        blob(-30, 7, -40, 'blue', 25, 5);   // west high ground
        blob(0, 7, -46, 'orange', 10, 4);   // bridge deck
        blob(0, 0, -46, 'blue', 10, 4);     // floor under the bridge
        blob(-20, 3.5, -26, 'blue', 6, 1.5); // plaza ramp (approx surface height)
        blob(-40, 0, 2, 'blue', 30, 8);     // centre lane
    });

    const shots = [
        { name: '01-character-front', place: [-30, 0, 2, -Math.PI / 2], pose: [[-26.6, 1.5, 2.6], [-30, 1.05, 2], 45] },
        { name: '02-character-back', place: [-30, 0, 2, -Math.PI / 2], pose: [[-33.4, 1.6, 1.3], [-30, 1.05, 2], 45] },
        { name: '03-map-overview', place: [-70, 0, 0, -Math.PI / 2], pose: [[0, 95, 105], [0, 0, -5], 55] },
        { name: '04-central-plaza', place: [-22, 0, 14, -2.2], pose: [[-24, 5.5, 20], [2, 0.5, -2], 60] },
        { name: '05-large-paint-area', place: [-70, 0, 0, -Math.PI / 2], pose: [[-12, 14, 22], [0, 0, 0], 60] },
        { name: '06-bridge-and-highground', place: [-70, 0, 0, -Math.PI / 2], pose: [[-18, 9, -24], [0, 4, -46], 60] },
        { name: '07-firing', place: [-30, 0, 2, -Math.PI / 2 + 0.25, -0.16], fire: 1, pose: null },
        { name: '08-impact-closeup', place: [-30, 0, 2, -Math.PI / 2 + 0.25, -0.16], fire: 1, impactCam: true },
        // Local bots (only in builds that have them). Not networked players.
        { name: '09-two-player-duel', place: [-14, 0, 12, -Math.PI / 2 + 0.05, -0.05], bots: 1, run: 1.6, pose: null },
        { name: '10-thirty-players-load', place: [-24, 0, 18, -2.4, -0.1], bots: 29, run: 9, pose: [[-34, 24, 34], [0, 0, 0], 60] }
    ];

    const results = [];
    for (const shot of shots) {
        if (shot.bots && !(await page.evaluate(() => typeof window.__colorfront.game.debugSpawnBots === 'function'))) continue;
        await page.evaluate((shot) => {
            const g = window.__colorfront.game;
            window.__freeze(false);
            window.__pose = shot.pose;
            window.__place(...shot.place);
            window.__step(0.5);
            if (shot.bots) {
                g.debugSpawnBots(shot.bots);
                const sim = g.debugSim;
                if (shot.bots === 1) {
                    // Put the bot in the open, facing the local player, then let them fight.
                    const bot = sim.players.find((p) => p.id !== 'local');
                    Object.assign(bot.position, { x: 2, y: 0, z: 12.6 });
                    bot.yaw = Math.PI / 2;
                }
                g.copyPrevious();
                // Keep the local player steady and firing at the bot during the duel.
                if (shot.bots === 1) g.input.heldButtons |= 8;
                window.__step(shot.run);
                g.input.heldButtons &= ~8;
            }
            if (shot.fire) {
                g.debugState.fireCooldownTicks = 0;
                g.input.heldButtons |= 8; // InputButton.Fire
                window.__step(1 / 30 + 0.001, 1 / 30 + 0.001);
                g.input.heldButtons &= ~8;
                window.__step(0.06);
                if (shot.impactCam) {
                    const sh = g.debugLastShot;
                    const i = sh && sh.impact;
                    if (i) window.__pose = [[i.x - 2.6, i.y + 1.6, i.z + 1.4], [i.x, i.y + 0.2, i.z], 50];
                    window.__step(1 / 60);
                }
            }
            window.__freeze(true);
            window.__step(1 / 60);
        }, shot);
        await page.waitForTimeout(250);
        await page.screenshot({ path: `${dir}/${shot.name}.png` });
        results.push(shot.name);
    }
    const stats = await page.evaluate(() => {
        const { app, game: g } = window.__colorfront;
        const s = app.stats;
        return { score: g.debugPaint.score(), drawCalls: s?.drawCalls?.total ?? null };
    });
    return { label, dir, results, stats, errors: errors.slice(0, 5) };
}
