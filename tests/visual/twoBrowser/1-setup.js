// Phase 3 two-browser check, stage 1 (Playwright MCP `browser_run_code_unsafe`, filename mode).
// Browsers A and B are two separately launched headless Chrome processes (own profile, own
// storage, own WebSocket, GPU WebGL), with background throttling off. The MCP page only drives
// them. Both load the real client and join the real Colyseus server;
// nothing is simulated locally. Pointer lock is shimmed (automation cannot grant it) and look
// direction is set through the client's own input object, exactly where mouse movement would
// land; movement/fire/jump/dash use real keyboard and mouse events.
async (page) => {
    page.setDefaultTimeout(60000);
    const URL = 'http://localhost:5173/?mode=online&seconds=100';
    const ctrl = page.context();
    // State shared by later stages lives on the MCP browser context (each run is a fresh scope).
    const T = (ctrl.__tb = ctrl.__tb || {});
    for (const b of [T.browserA, T.browserB]) if (b) await b.close().catch(() => {});

    const browserType = page.context().browser().browserType();
    const launch = () =>
        browserType.launch({
            // Headless Chrome still renders WebGL on the real GPU (ANGLE/D3D11, 60 fps here) and
            // cannot be minimised or covered by other windows, which would throttle it.
            headless: true,
            channel: 'chrome',
            args: ['--disable-renderer-backgrounding', '--disable-background-timer-throttling']
        });
    T.browserA = await launch();
    T.browserB = await launch();
    T.A = await (await T.browserA.newContext({ viewport: { width: 750, height: 500 } })).newPage();
    T.B = await (await T.browserB.newContext({ viewport: { width: 750, height: 500 } })).newPage();
    T.A.setDefaultTimeout(60000);
    T.B.setDefaultTimeout(60000);

    // ── helpers shared by later stages ──────────────────────────────────────────
    T.net = (p) => p.evaluate(() => window.__colorfront.game.debugNet());
    // Park the mouse at the canvas centre while still unlocked: once "locked", any pointer
    // movement turns the camera, so later clicks at the same spot must not move it.
    T.lock = async (p) => {
        const box = await p.locator('canvas').boundingBox();
        await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await p.evaluate(() => {
            const g = window.__colorfront.game;
            g.input.locked = true;
            g.input.onLockChange(true);
        });
    };
    T.waitNet = async (p, predicate, timeout = 15000, label = 'condition') => {
        const t0 = Date.now();
        let last = null;
        while (Date.now() - t0 < timeout) {
            last = await T.net(p);
            if (last && predicate(last)) return last;
            await p.waitForTimeout(100);
        }
        throw new Error(`timeout: ${label} — last ${JSON.stringify(last && { phase: last.phase, status: last.status, players: last.players?.length })}`);
    };
    // Steer toward a waypoint with the client's own look input while W (+Shift) is held.
    T.walkTo = async (p, x, z, { sprint = true, tolerance = 1.2, timeout = 20000 } = {}) => {
        await p.keyboard.down('KeyW');
        if (sprint) await p.keyboard.down('ShiftLeft');
        const t0 = Date.now();
        let pos = null;
        try {
            while (Date.now() - t0 < timeout) {
                pos = await p.evaluate(
                    ([tx, tz]) => {
                        const g = window.__colorfront.game;
                        const s = g.debugState.position;
                        const dx = tx - s.x;
                        const dz = tz - s.z;
                        g.input.yaw = Math.atan2(-dx, -dz);
                        g.input.pitch = 0;
                        return { x: s.x, y: s.y, z: s.z, d: Math.hypot(dx, dz) };
                    },
                    [x, z]
                );
                if (pos.d < tolerance) break;
                await p.waitForTimeout(50);
            }
        } finally {
            await p.keyboard.up('KeyW');
            if (sprint) await p.keyboard.up('ShiftLeft');
        }
        await p.waitForTimeout(250);
        return pos;
    };
    T.look = (p, yaw, pitch) =>
        p.evaluate(([y, pt]) => {
            const g = window.__colorfront.game;
            g.input.yaw = y;
            g.input.pitch = pt;
        }, [yaw, pitch]);
    // Aim from the over-the-shoulder pivot at a world point (same geometry as the shared AIM).
    T.aimAt = (p, tx, ty, tz) =>
        p.evaluate(([x, y, z]) => {
            const g = window.__colorfront.game;
            const s = g.debugState.position;
            let yaw = Math.atan2(-(x - s.x), -(z - s.z));
            let pitch = 0;
            for (let i = 0; i < 4; i++) {
                const px = s.x + Math.cos(yaw) * 0.8;
                const pz = s.z - Math.sin(yaw) * 0.8;
                const py = s.y + 1.55;
                yaw = Math.atan2(-(x - px), -(z - pz));
                pitch = Math.atan2(y - py, Math.hypot(x - px, z - pz));
            }
            g.input.yaw = yaw;
            g.input.pitch = pitch;
            return { yaw, pitch };
        }, [tx, ty, tz]);
    T.fire = async (p, ms) => {
        const box = await p.locator('canvas').boundingBox();
        await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await p.mouse.down({ button: 'left' });
        await p.waitForTimeout(ms);
        await p.mouse.up({ button: 'left' });
    };
    T.shot = async (p, name) => {
        await p.screenshot({ path: `C:/Users/user/Desktop/fps/colorfront/docs/screenshots/phase3/${name}.png` });
        return name;
    };

    // ── join ────────────────────────────────────────────────────────────────────
    await T.A.goto(URL + '&name=Alice');
    await T.waitNet(T.A, (n) => n.status === 'connected' && n.players.length === 1, 20000, 'A connected');
    await T.B.goto(URL + '&name=Bob');
    const a = await T.waitNet(T.A, (n) => n.players.length === 2, 20000, 'A sees 2 players');
    const b = await T.waitNet(T.B, (n) => n.status === 'connected' && n.players.length === 2, 20000, 'B sees 2 players');
    await T.lock(T.A);
    await T.lock(T.B);
    await T.A.waitForTimeout(1500);
    await T.shot(T.A, 'A-joined');
    await T.shot(T.B, 'B-joined');
    return {
        sameRoom: a.roomId === b.roomId,
        roomId: a.roomId,
        A: { sessionId: a.sessionId, team: a.team, players: a.players.map((p) => `${p.name}/${p.team}/${p.visible ? 'visible' : 'hidden'}`) },
        B: { sessionId: b.sessionId, team: b.team, players: b.players.map((p) => `${p.name}/${p.team}/${p.visible ? 'visible' : 'hidden'}`) },
        paint: { A: a.clientGrid, B: b.clientGrid, snapshotsA: a.snapshots, snapshotsB: b.snapshots }
    };
}
