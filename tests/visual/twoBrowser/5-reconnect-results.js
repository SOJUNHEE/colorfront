// Stage 5: a new round. During PLAYING, B's socket drops (network failure, SDK auto-reconnect) while
// A keeps painting; then B reloads the page (reconnection token, same seat). B must come back as the
// same player with the same team and the full current paint. Finally both result screens.
async (page) => {
    const T = page.context().__tb;
    const { A, B } = T;
    const out = {};
    const serverRoom = async () => (await (await fetch('http://127.0.0.1:2567/metrics')).json()).rooms[0];
    const hashes = async () => {
        await A.waitForTimeout(700);
        const [a, b, s] = [await T.net(A), await T.net(B), await serverRoom()];
        return { A: a.clientGrid, B: b.clientGrid, server: s.paintHash, allEqual: a.clientGrid.hash === b.clientGrid.hash && a.clientGrid.hash === s.paintHash };
    };

    // Wait for the previous round (stage 3/4) to finish.
    await T.waitNet(A, (n) => n.phase === 'WAITING', 150000, 'waiting for next round');
    await A.keyboard.press('KeyG');
    await B.keyboard.press('KeyG');
    await T.waitNet(A, (n) => n.phase === 'PLAYING', 15000, 'playing');
    const bBefore = await T.net(B);
    const bId = bBefore.sessionId;
    await T.walkTo(A, -50, 13);

    // 1) Network drop.
    await B.evaluate(() => window.__colorfront.game.debugDrop());
    const aSawDrop = await T.waitNet(A, (n) => n.players.find((p) => p.id === bId)?.connected === false, 5000, 'A sees B disconnected')
        .then(() => true)
        .catch(() => false);
    await T.look(A, -Math.PI / 2, -1.15);
    await T.fire(A, 1200); // paint while B is away
    const bBack = await T.waitNet(B, (n) => n.status === 'connected' && n.sessionId === bId, 15000, 'B reconnected');
    const aSawBack = await T.waitNet(A, (n) => n.players.find((p) => p.id === bId)?.connected === true, 5000, 'A sees B back')
        .then(() => true)
        .catch(() => false);
    out.drop = {
        aSawDisconnected: aSawDrop,
        aSawReconnected: aSawBack,
        sameSession: bBack.sessionId === bId,
        team: bBack.team,
        snapshotsBefore: bBefore.snapshots,
        snapshotsAfter: bBack.snapshots,
        paint: await hashes()
    };

    // 2) Page reload: the token in sessionStorage takes the same seat back.
    await B.reload();
    const bReload = await T.waitNet(B, (n) => n.status === 'connected' && n.players.length === 2, 20000, 'B after reload');
    await T.lock(B);
    out.reload = {
        sameSession: bReload.sessionId === bId,
        team: bReload.team,
        phase: bReload.phase,
        snapshots: bReload.snapshots,
        reconnectError: bReload.reconnectError,
        paint: await hashes()
    };

    // 3) Results on both screens.
    const left = (await T.net(A)).ticksLeft / 30;
    out.secondsUntilResults = +left.toFixed(1);
    const ra = await T.waitNet(A, (n) => n.phase === 'RESULTS' && n.result?.round === 2, (left + 8) * 1000, 'results A');
    const rb = await T.waitNet(B, (n) => n.phase === 'RESULTS' && n.result?.round === 2, 5000, 'results B');
    await A.waitForTimeout(800);
    await T.shot(A, 'A-results');
    await T.shot(B, 'B-results');
    const s = await serverRoom();
    out.results = {
        identical: JSON.stringify(ra.result) === JSON.stringify(rb.result),
        result: ra.result,
        hashMatchesGridA: ra.result.hash === ra.clientGrid.hash,
        hashMatchesGridB: rb.result.hash === rb.clientGrid.hash,
        hashMatchesServer: ra.result.hash === s.paintHash
    };
    const [na, nb] = [await T.net(A), await T.net(B)];
    out.metrics = {
        server: s,
        A: { fps: na.fps, frameP95Ms: na.frameP95Ms, rttMs: na.rttMs, bytesIn: na.bytesIn, bytesOut: na.bytesOut, paintDelayMs: na.paintDelayMs, corrections: na.corrections, snaps: na.snaps, gaps: na.gaps, hashChecks: na.hashChecks, mismatches: na.hashMismatches },
        B: { fps: nb.fps, frameP95Ms: nb.frameP95Ms, rttMs: nb.rttMs, bytesIn: nb.bytesIn, paintDelayMs: nb.paintDelayMs, gaps: nb.gaps, hashChecks: nb.hashChecks, mismatches: nb.hashMismatches }
    };
    return out;
}
