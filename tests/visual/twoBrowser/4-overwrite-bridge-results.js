// Stage 4: B overwrites A's blue cells (aimed at their centroid), then the bridge deck / floor
// below independence test. (The round result is checked in stage 5.)
async (page) => {
    const T = page.context().__tb;
    const { A, B } = T;
    const out = {};
    const serverRoom = async () => (await (await fetch('http://127.0.0.1:2567/metrics')).json()).rooms[0];
    const threeWay = async () => {
        await A.waitForTimeout(600);
        const [a, b, s] = [await T.net(A), await T.net(B), await serverRoom()];
        return { A: a.clientGrid, B: b.clientGrid, serverHash: s.paintHash, allEqual: a.clientGrid.hash === b.clientGrid.hash && b.clientGrid.hash === s.paintHash, score: a.score };
    };
    const surfaceCounts = (p) =>
        p.evaluate(() => {
            const g = window.__colorfront.game.debugPaint;
            const count = (id, box) => {
                const s = g.surfaces.find((x) => x.solid.source.id === id);
                const o = g.owners[s.index];
                const r = { blue: 0, orange: 0 };
                for (let row = 0; row < s.rows; row++)
                    for (let col = 0; col < s.cols; col++) {
                        const v = o[row * s.cols + col];
                        if (!v) continue;
                        const x = s.minX + (col + 0.5) * s.cellSize;
                        const z = s.minZ + (row + 0.5) * s.cellSize;
                        if (box && (x < box[0] || x > box[1] || z < box[2] || z > box[3])) continue;
                        if (v === 1) r.blue++;
                        else r.orange++;
                    }
                return r;
            };
            return { bridge: count('bridge'), floorUnderBridge: count('floor', [-12, 12, -52, -40]) };
        });

    // ── overwrite ─────────────────────────────────────────────────────────────
    const blueCentroid = await A.evaluate(() => {
        const g = window.__colorfront.game.debugPaint;
        const s = g.surfaces.find((x) => x.solid.source.id === 'floor');
        const o = g.owners[s.index];
        let sx = 0;
        let sz = 0;
        let n = 0;
        for (let row = 0; row < s.rows; row++)
            for (let col = 0; col < s.cols; col++) {
                const x = s.minX + (col + 0.5) * s.cellSize;
                if (o[row * s.cols + col] === 1 && x < -15) {
                    sx += x;
                    sz += s.minZ + (row + 0.5) * s.cellSize;
                    n++;
                }
            }
        return { x: sx / n, z: sz / n, n };
    });
    out.blueTarget = blueCentroid;
    out.beforeOverwrite = await threeWay();
    await T.walkTo(B, 50, 13);
    await T.walkTo(B, -9, 13);
    await T.aimAt(B, blueCentroid.x, 0, blueCentroid.z);
    await T.fire(B, 1800);
    out.afterOverwrite = await threeWay();
    out.overwrite = {
        blueLost: out.beforeOverwrite.score.blue - out.afterOverwrite.score.blue,
        orangeGained: out.afterOverwrite.score.orange - out.beforeOverwrite.score.orange
    };
    await T.shot(A, 'A-after-overwrite');

    // ── bridge above / floor below ───────────────────────────────────────────
    await Promise.all([
        (async () => {
            await T.walkTo(A, -20, -18);
            await T.walkTo(A, -20, -35);
            await T.walkTo(A, -6, -46);
        })(),
        (async () => {
            await B.keyboard.press('KeyR');
            await T.walkTo(B, 6, 13);
            await T.walkTo(B, 6, -20);
            await T.walkTo(B, 4, -46);
        })()
    ]);
    const posA = (await T.net(A)).position;
    const posB = (await T.net(B)).position;
    out.bridgePositions = { A: posA, B: posB };
    out.bridgeBefore = { A: await surfaceCounts(A), B: await surfaceCounts(B) };
    await Promise.all([
        (async () => {
            await T.look(A, -Math.PI / 2, -1.2);
            await T.fire(A, 1200);
        })(),
        (async () => {
            await T.look(B, Math.PI / 2, -1.2);
            await T.fire(B, 1200);
        })()
    ]);
    out.bridgeAfter = { A: await surfaceCounts(A), B: await surfaceCounts(B), sync: await threeWay() };
    await T.shot(B, 'B-under-bridge');
    await T.shot(A, 'A-on-bridge');

    return out;
}
