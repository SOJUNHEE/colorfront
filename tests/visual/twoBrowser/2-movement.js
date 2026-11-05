// Stage 2: movement / jump / dash replicate from A's real inputs to B's screen (WAITING warm-up).
async (page) => {
    const T = page.context().__tb;
    const { A, B } = T;
    const out = {};
    const aId = (await T.net(A)).sessionId;
    const viewOf = async (p, id) => (await T.net(p)).players.find((x) => x.id === id);

    // Walk out of the blue spawn along the open z = 13 lane.
    const start = await viewOf(B, aId);
    const pos = await T.walkTo(A, -50, 13);
    await A.waitForTimeout(400);
    const own = (await T.net(A)).position;
    const seenByB = await viewOf(B, aId);
    out.walk = {
        from: { x: start.x, z: start.z },
        aOwn: { x: +own.x.toFixed(2), z: +own.z.toFixed(2) },
        bSeesA: { x: seenByB.x, z: seenByB.z },
        error: +Math.hypot(own.x - seenByB.x, own.z - seenByB.z).toFixed(3),
        reached: pos.d < 1.5
    };

    // Jump: B must see A leave the ground.
    let maxY = 0;
    await A.keyboard.press('Space');
    const t0 = Date.now();
    while (Date.now() - t0 < 1500) {
        const v = await viewOf(B, aId);
        maxY = Math.max(maxY, v.y);
        await B.waitForTimeout(30);
    }
    out.jump = { maxYSeenByB: maxY };

    // Dash (Q, 4 m) facing +x.
    await T.look(A, -Math.PI / 2, 0);
    await A.waitForTimeout(200);
    const before = await viewOf(B, aId);
    let sawDash = false;
    await A.keyboard.press('KeyQ');
    const t1 = Date.now();
    while (Date.now() - t1 < 1200) {
        const v = await viewOf(B, aId);
        if (v.dash > 0) sawDash = true;
        await B.waitForTimeout(25);
    }
    const after = await viewOf(B, aId);
    out.dash = { sawDashFlag: sawDash, distanceSeenByB: +Math.hypot(after.x - before.x, after.z - before.z).toFixed(2) };

    // B also walks out (toward the plaza) so both stand in the arena.
    await T.walkTo(B, 50, 13);
    const nA = await T.net(A);
    const nB = await T.net(B);
    out.correctionsA = { corrections: nA.corrections, snaps: nA.snaps, pending: nA.pendingInputs };
    out.rtt = { A: nA.rttMs, B: nB.rttMs };
    await T.shot(B, 'B-sees-A-moved');
    return out;
}
