// Animation sheet for the Playwright MCP `browser_run_code_unsafe` tool (filename mode).
// Spawns local bot rigs, freezes the simulation and drives each rig into one animation state,
// then captures two labelled rows to colorfront/docs/screenshots/<label>/anim-*.png.
async (page) => {
    const label = new URL(page.url()).hash.slice(1) || 'anim';
    const dir = `colorfront/docs/screenshots/${label}`;
    page.setDefaultTimeout(60000);
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('http://localhost:5173/');
    await page.waitForFunction(() => window.__colorfront && window.__colorfront.game);
    await page.waitForTimeout(1500);
    const rows = [
        ['idle', 'walk', 'run', 'dash', 'jump', 'land'],
        ['aim', 'fire', 'reload', 'hit', 'respawn', 'victory']
    ];
    const shots = [];
    for (let r = 0; r < rows.length; r++) {
        await page.evaluate(({ names, row }) => {
            const { app, game: g } = window.__colorfront;
            if (!window.__animSetup) {
                window.__animSetup = true;
                g.input.destroy();
                document.querySelector('.menu-backdrop')?.classList.add('hidden');
                document.getElementById('ui-root').style.visibility = 'hidden';
                document.querySelector('.inspector-hint')?.remove();
                g.debugSpawnBots(12);
                // Detach the game loop so nothing overrides the posed rigs or the camera.
                app.off('update', Object.getPrototypeOf(g).update, g);
            }
            const actors = [...g.actors.values()].filter((a) => a.state.id !== 'local');
            for (const a of g.actors.values()) a.rig.setVisible(false);
            const cam = app.root.findByName('camera');
            const z = 13;
            const spacing = 1.7;
            const x0 = -3 - ((names.length - 1) * spacing) / 2;
            cam.setPosition(-3 + 1.2, 1.7, z + 6.2);
            cam.lookAt(-3, 0.95, z);
            cam.camera.fov = 52;
            const labels = document.getElementById('anim-labels') ?? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'anim-labels' }));
            labels.innerHTML = '';
            names.forEach((name, i) => {
                const a = actors[row * 6 + i];
                const rig = a.rig;
                rig.setVisible(true);
                rig.setTeam(i % 2 ? 'orange' : 'blue');
                const x = x0 + i * spacing;
                const base = { x, y: 0, z, yaw: Math.PI + 0.35, pitch: 0, vx: 0, vz: 0, vy: 0, grounded: true, aiming: false, dashing: false, reload: -1, ammo: 0.7, alive: true };
                const run = (pose, seconds) => {
                    for (let t = 0; t < seconds; t += 1 / 60) rig.update(1 / 60, pose, 6, 30);
                };
                rig.celebrate(false);
                const fwd = (s) => ({ vx: -Math.sin(base.yaw) * s, vz: -Math.cos(base.yaw) * s });
                switch (name) {
                    case 'idle': run(base, 1.0); break;
                    case 'walk': run({ ...base, ...fwd(6) }, 0.43); break;
                    case 'run': run({ ...base, ...fwd(8) }, 0.37); break;
                    case 'dash': run({ ...base, ...fwd(24), dashing: true }, 0.12); break;
                    case 'jump': run(base, 0.3); run({ ...base, grounded: false, vy: 4, y: 0.6 }, 0.15); break;
                    case 'land': run({ ...base, grounded: false, vy: -6, y: 0.4 }, 0.2); run(base, 0.05); break;
                    case 'aim': run({ ...base, aiming: true, pitch: 0.15 }, 0.6); break;
                    case 'fire': run({ ...base, aiming: true, pitch: 0.05 }, 0.4); rig.fired(); run({ ...base, aiming: true, pitch: 0.05 }, 0.02); break;
                    case 'reload': run({ ...base, reload: 0.5, ammo: 0.05 }, 0.2); break;
                    case 'hit': run(base, 0.3); rig.hit(); run(base, 0.06); break;
                    case 'respawn': rig.respawned(); run(base, 0.12); break;
                    case 'victory': rig.celebrate(true); run(base, 0.32); break;
                }
                const sp = cam.camera.worldToScreen(new (cam.getPosition().constructor)(x, 2.05, z));
                const el = document.createElement('div');
                el.textContent = name.toUpperCase();
                Object.assign(el.style, { position: 'fixed', left: `${sp.x}px`, top: `${sp.y}px`, transform: 'translate(-50%, -100%)', font: '700 14px system-ui', color: '#fff', background: 'rgba(0,0,0,.55)', padding: '2px 8px', borderRadius: '4px', zIndex: 50 });
                labels.appendChild(el);
            });
        }, { names: rows[r], row: r });
        await page.waitForTimeout(300);
        const name = `anim-${r + 1}-${rows[r].join('-')}.png`;
        await page.screenshot({ path: `${dir}/${name}` });
        shots.push(name);
    }
    return { dir, shots };
}
