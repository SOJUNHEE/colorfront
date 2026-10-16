// Rendered-paint vs authoritative-grid check for the Playwright MCP `browser_run_code_unsafe` tool.
// For every cell centre in a few regions (floor, bridge deck, ramp), project the centre to the
// screen, read the rendered pixel and classify it (blue / orange / unpainted). The paint shader
// guarantees the owner colour at cell centres, so every visible centre must agree with the grid.
// Runs each region twice: after painting, and after an enemy overwrite (tests partial uploads).
async (page) => {
    page.setDefaultTimeout(120000);
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('http://localhost:5173/');
    await page.waitForFunction(() => window.__colorfront && window.__colorfront.game);
    await page.waitForTimeout(1500);
    return await page.evaluate(() => {
        const { app, game: g } = window.__colorfront;
        g.input.destroy();
        g.input.locked = true;
        document.getElementById('ui-root').style.visibility = 'hidden';
        for (const a of g.actors.values()) a.rig.root.enabled = false;
        const cam = app.root.findByName('camera');
        const V = cam.getPosition().constructor;
        const device = app.graphicsDevice;
        const gl = device.gl;
        const p = g.debugPaint;
        p.clear();
        let pose = null;
        const follow = g.followCamera.update.bind(g.followCamera);
        g.followCamera.update = (dt, t) => {
            if (!pose) return follow(dt, t);
            cam.setPosition(...pose[0]);
            cam.lookAt(...pose[1]);
            cam.camera.fov = 55;
        };
        const settle = () => {
            for (let i = 0; i < 4; i++) g.update(1 / 60);
            g.paintRenderer.flush();
            app.render();
        };
        // Render each view with and without the paint layer; a centre counts as painted when the
        // paint layer changes the pixel, and its team is the dominant channel of the change.
        // This is independent of sunlight tint, bloom and grading.
        const paintRoot = app.root.findByName('paint');
        const classify = (on, off) => {
            const dr = on[0] - off[0];
            const db = on[2] - off[2];
            const diff = Math.abs(on[0] - off[0]) + Math.abs(on[1] - off[1]) + Math.abs(on[2] - off[2]);
            if (diff < 30) return 0;
            return db > dr ? 1 : 2;
        };
        // Skip centres hidden behind level geometry (same half-space test as the shared raycast).
        const solids = g.debugSim.world.solids;
        const occluded = (from, to) => {
            const dx = to[0] - from.x, dy = to[1] - from.y, dz = to[2] - from.z;
            const len = Math.hypot(dx, dy, dz);
            const d = [dx / len, dy / len, dz / len];
            for (const sol of solids) {
                let t0 = -Infinity, t1 = Infinity, miss = false;
                for (const pl of sol.planes) {
                    const den = pl.nx * d[0] + pl.ny * d[1] + pl.nz * d[2];
                    const dist = pl.d - (pl.nx * from.x + pl.ny * from.y + pl.nz * from.z);
                    if (den === 0) { if (dist < 0) { miss = true; break; } continue; }
                    const t = dist / den;
                    if (den < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
                    if (t0 > t1) { miss = true; break; }
                }
                if (!miss && t1 >= 0 && Math.max(0, t0) < len - 0.08) return true;
            }
            return false;
        };
        const check = (surfaceId, region, y) => {
            const s = p.surfaces.find((x) => x.solid.source.id === surfaceId);
            const cells = [];
            for (let row = 0; row < s.rows; row++) {
                for (let col = 0; col < s.cols; col++) {
                    const x = s.minX + (col + 0.5) * s.cellSize;
                    const z = s.minZ + (row + 0.5) * s.cellSize;
                    if (x < region[0] || x > region[1] || z < region[2] || z > region[3]) continue;
                    if (!p.masks[s.index][row * s.cols + col]) continue;
                    cells.push([x, y(x, z), z, p.owners[s.index][row * s.cols + col]]);
                }
            }
            const sx = device.width / device.canvas.clientWidth;
            const eye = cam.getPosition().clone();
            const hidden = cells.map(([x, cy, z]) => occluded(eye, [x, cy + 0.03, z]));
            const sample = () => {
                app.render();
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                const buf = new Uint8Array(4);
                return cells.map(([x, cy, z]) => {
                    const sp = cam.camera.worldToScreen(new V(x, cy + 0.03, z));
                    if (sp.z <= 0 || sp.x < 2 || sp.y < 2 || sp.x > device.canvas.clientWidth - 2 || sp.y > device.canvas.clientHeight - 2) return null;
                    gl.readPixels(Math.round(sp.x * sx), Math.round(device.height - sp.y * sx), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
                    return [buf[0], buf[1], buf[2]];
                });
            };
            paintRoot.enabled = false;
            const off = sample();
            paintRoot.enabled = true;
            const on = sample();
            let agree = 0;
            let checked = 0;
            let painted = 0;
            const bad = [];
            cells.forEach(([x, , z, owner], i) => {
                if (!on[i] || !off[i] || hidden[i]) return;
                checked++;
                if (owner) painted++;
                const seen = classify(on[i], off[i]);
                if (seen === owner) agree++;
                else if (bad.length < 5) bad.push({ x: +x.toFixed(2), z: +z.toFixed(2), owner, seen, on: on[i], off: off[i] });
            });
            return { checked, painted, agree, bad };
        };
        const blob = (x, y, z, team, n, spread) => {
            for (let i = 0; i < n; i++) {
                const a = i * 2.39996;
                const r = spread * Math.sqrt(i / n);
                p.paintSphere({ x: x + Math.cos(a) * r, y, z: z + Math.sin(a) * r }, 1.2, team);
            }
        };
        const out = { quality: g.settings.quality };
        // Floor, viewed from above at an angle.
        pose = [[-10, 9, 14], [-10, 0, 4]];
        blob(-12, 0, 4, 'blue', 18, 3);
        blob(-8, 0, 3, 'orange', 10, 2.5);
        settle();
        out.floor = check('floor', [-17, -3, -1, 9], () => 0);
        blob(-12, 0, 4, 'orange', 6, 1.5); // overwrite part of the blue
        settle();
        out.floorAfterOverwrite = check('floor', [-17, -3, -1, 9], () => 0);
        // Bridge deck (y = 7) and the floor beneath it, from above the deck.
        pose = [[0, 15, -36], [0, 6, -46]];
        blob(0, 7, -46, 'orange', 12, 3);
        blob(0, 0, -46, 'blue', 12, 3);
        settle();
        out.bridgeDeck = check('bridge', [-6, 6, -51, -41], () => 7);
        // Spawn-side ramp (slope), viewed from the side.
        pose = [[-49, 7, -24], [-56, 3, -26]];
        blob(-56, 3.5, -26, 'blue', 8, 2);
        settle();
        const ramp = p.surfaces.find((x) => x.solid.source.id === 'ramp-spawn-w').solid;
        out.ramp = check('ramp-spawn-w', [-60, -52, -32, -20], (x, z) => 7 * ((-20 - z) / 12));
        void ramp;
        return out;
    });
}
