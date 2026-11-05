// Stage 3: both press G (ready) → countdown → PLAYING. A paints blue, B overwrites it orange from
// range, A splats B. After each step both screens' grids are compared with each other and with
// the score the server replicates.
async (page) => {
    const T = page.context().__tb;
    const { A, B } = T;
    const out = {};
    const grids = async () => {
        await A.waitForTimeout(600); // let the last delta (every 2 ticks) arrive
        const [a, b] = [await T.net(A), await T.net(B)];
        return {
            sameHash: a.clientGrid.hash === b.clientGrid.hash,
            A: a.clientGrid,
            B: b.clientGrid,
            serverScoreSeenByA: a.score,
            serverScoreSeenByB: b.score,
            gridMatchesServer: a.clientGrid.blue === a.score.blue && a.clientGrid.orange === a.score.orange && b.clientGrid.blue === b.score.blue && b.clientGrid.orange === b.score.orange,
            pctA: [(100 * a.score.blue) / a.score.paintable, (100 * a.score.orange) / a.score.paintable].map((v) => +v.toFixed(3)),
            pctB: [(100 * b.score.blue) / b.score.paintable, (100 * b.score.orange) / b.score.paintable].map((v) => +v.toFixed(3))
        };
    };

    // Ready up with the real key.
    await A.keyboard.press('KeyG');
    await B.keyboard.press('KeyG');
    await T.waitNet(A, (n) => n.phase === 'COUNTDOWN', 5000, 'countdown');
    await T.shot(A, 'A-countdown');
    await T.waitNet(A, (n) => n.phase === 'PLAYING', 10000, 'playing');
    await T.waitNet(B, (n) => n.phase === 'PLAYING', 3000, 'B playing');
    out.afterReset = await grids();

    // A into the arena, paints the floor in front of it.
    await Promise.all([
        (async () => {
            await T.walkTo(A, -40, 13);
            await T.walkTo(A, -20, 13);
        })(),
        (async () => {
            await T.walkTo(B, 50, 13);
            await T.walkTo(B, 2, 13);
        })()
    ]);
    await T.look(A, -Math.PI / 2, -1.15);
    await T.fire(A, 1500);
    out.afterBlue = await grids();
    await T.shot(B, 'B-sees-blue-paint');

    // B overwrites A's paint from ~18 m away.
    await T.aimAt(B, -16.5, 0, 13);
    await T.fire(B, 2000);
    out.afterOrange = await grids();
    await T.shot(A, 'A-sees-orange-overwrite');
    await T.shot(B, 'B-orange-overwrite');

    // A shoots B until the server reports the splat.
    const bId = (await T.net(B)).sessionId;
    const aId = (await T.net(A)).sessionId;
    await A.keyboard.press('KeyR');
    await A.waitForTimeout(2000);
    const box = await A.locator('canvas').boundingBox();
    await A.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await A.mouse.down();
    const t0 = Date.now();
    let killed = false;
    while (Date.now() - t0 < 6000) {
        const bView = (await T.net(A)).players.find((p) => p.id === bId);
        if (!bView.alive) {
            killed = true;
            break;
        }
        await T.aimAt(A, bView.x, bView.y + 1.0, bView.z);
        await A.waitForTimeout(40);
    }
    await A.mouse.up();
    await A.waitForTimeout(500);
    const [na, nb] = [await T.net(A), await T.net(B)];
    const hitsOnA = na.events.filter((e) => e.startsWith('{"t":"h"') && e.includes(bId)).length;
    const hitsOnB = nb.events.filter((e) => e.startsWith('{"t":"h"') && e.includes(bId)).length;
    const killA = na.events.find((e) => e.startsWith('{"t":"k"'));
    const killB = nb.events.find((e) => e.startsWith('{"t":"k"'));
    out.combat = {
        killed,
        hitEventsSeenByA: hitsOnA,
        hitEventsSeenByB: hitsOnB,
        killEventA: killA,
        killEventB: killB,
        sameKillEvent: killA === killB,
        aliveB_onB: nb.alive,
        hpB_onB: nb.hp,
        statsSeenByA: na.players.map((p) => `${p.name} K${p.kills}/D${p.deaths}`),
        statsSeenByB: nb.players.map((p) => `${p.name} K${p.kills}/D${p.deaths}`),
        // B saw A's shots as remote shot events (drives A's firing animation on B's screen).
        remoteShotsOfA_onB: nb.events.filter((e) => e.startsWith(`s:${aId}`)).length
    };
    await T.shot(B, 'B-splatted');
    await T.shot(A, 'A-splatted-B');
    const respawned = await T.waitNet(B, (n) => n.alive === true, 8000, 'B respawn').then(() => true).catch(() => false);
    out.combat.respawnedOnB = respawned;
    out.phase = (await T.net(A)).phase;
    out.ticksLeft = (await T.net(A)).ticksLeft;
    return out;
}
