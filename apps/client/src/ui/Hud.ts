import { MOVEMENT, PLAYER_MAX_HP, TICK_RATE, WEAPONS, paintPercent, reloadTicks } from '@colorfront/shared';
import type { PaintScore, PlayerState } from '@colorfront/shared';

export type FrameStats = {
    fps: number;
    frameMs: number;
};

const el = <T extends HTMLElement = HTMLElement>(root: HTMLElement, selector: string) =>
    root.querySelector(selector) as T;

const pct = (count: number, total: number) => `${paintPercent(count, total).toFixed(1)}%`;

/** Plain-DOM heads-up display. Values shown here are read from the local simulation state. */
export class Hud {
    readonly root: HTMLElement;
    private readonly fps: HTMLElement;
    private readonly hpFill: HTMLElement;
    private readonly hpValue: HTMLElement;
    private readonly ammo: HTMLElement;
    private readonly magazine: HTMLElement;
    private readonly weaponName: HTMLElement;
    private readonly team: HTMLElement;
    private readonly reload: HTMLElement;
    private readonly reloadFill: HTMLElement;
    private readonly dash: HTMLElement;
    private readonly crosshair: HTMLElement;
    private readonly toast: HTMLElement;
    private readonly scoreBlue: HTMLElement;
    private readonly scoreOrange: HTMLElement;
    private readonly barBlue: HTMLElement;
    private readonly barOrange: HTMLElement;
    private readonly scoreSub: HTMLElement;
    private toastTimer = 0;
    private readonly damage: HTMLElement;
    private readonly feed: HTMLElement;
    private readonly respawn: HTMLElement;
    private hitTimer = 0;
    private damageLevel = 0;
    private lastScoreKey = '';
    private modeLabel = '오프라인 로컬 매치';
    private online = false;

    constructor(parent: HTMLElement) {
        this.root = document.createElement('div');
        this.root.className = 'hud';
        // Static template only; every runtime value is written with textContent.
        this.root.innerHTML = `
            <div class="hud-score" aria-label="점령률">
                <div class="score-side blue"><span class="team-tag">▲ BLUE</span><strong></strong></div>
                <div class="score-bar"><div class="score-fill blue"></div><div class="score-fill orange"></div></div>
                <div class="score-side orange"><strong></strong><span class="team-tag">ORANGE ■</span></div>
                <div class="score-sub"></div>
            </div>
            <pre class="hud-fps panel"></pre>
            <div class="crosshair"><i></i><i></i><i></i><i></i><b></b></div>
            <div class="hud-hp panel">
                <div class="hud-label">HP</div>
                <div class="bar"><div class="bar-fill"></div></div>
                <div class="hud-hp-value">100</div>
            </div>
            <div class="hud-dash panel"></div>
            <div class="hud-weapon panel">
                <div class="hud-ammo"><strong></strong><span></span></div>
                <div class="hud-weapon-name"></div>
                <div class="hud-reload"><div class="bar"><div class="bar-fill"></div></div><span>재장전</span></div>
                <div class="hud-team"></div>
            </div>
            <div class="hud-toast" role="status" aria-live="polite"></div>
            <div class="hud-damage"></div>
            <ol class="hud-feed" aria-label="킬 피드"></ol>
            <div class="hud-respawn hidden"></div>`;
        parent.append(this.root);

        this.fps = el(this.root, '.hud-fps');
        this.hpFill = el(this.root, '.hud-hp .bar-fill');
        this.hpValue = el(this.root, '.hud-hp-value');
        this.ammo = el(this.root, '.hud-ammo strong');
        this.magazine = el(this.root, '.hud-ammo span');
        this.weaponName = el(this.root, '.hud-weapon-name');
        this.team = el(this.root, '.hud-team');
        this.reload = el(this.root, '.hud-reload');
        this.reloadFill = el(this.root, '.hud-reload .bar-fill');
        this.dash = el(this.root, '.hud-dash');
        this.crosshair = el(this.root, '.crosshair');
        this.toast = el(this.root, '.hud-toast');
        this.damage = el(this.root, '.hud-damage');
        this.feed = el(this.root, '.hud-feed');
        this.respawn = el(this.root, '.hud-respawn');
        this.scoreBlue = el(this.root, '.score-side.blue strong');
        this.scoreOrange = el(this.root, '.score-side.orange strong');
        this.barBlue = el(this.root, '.score-fill.blue');
        this.barOrange = el(this.root, '.score-fill.orange');
        this.scoreSub = el(this.root, '.score-sub');
    }

    setVisible(visible: boolean) {
        this.root.classList.toggle('hidden', !visible);
    }

    /** Where the score comes from (offline local grid vs. server), shown under the score bar. */
    setModeLabel(label: string) {
        this.modeLabel = label;
        this.online = label.startsWith('온라인');
        this.lastScoreKey = '';
    }

    setFpsVisible(visible: boolean) {
        this.fps.classList.toggle('hidden', !visible);
    }

    /** Crosshair confirmation when the local player's shot hits an enemy. */
    showHitMarker(killed: boolean) {
        this.hitTimer = killed ? 0.35 : 0.14;
        this.crosshair.classList.toggle('kill', killed);
        this.crosshair.classList.add('hit');
    }

    /** Paint-coloured screen-edge flash when the local player takes a hit. */
    tookDamage(fraction: number) {
        this.damageLevel = Math.min(1, this.damageLevel + 0.35 + fraction);
    }

    /** Kill feed line (static structure; names go through textContent). */
    pushFeed(attacker: string, attackerTeam: 'blue' | 'orange', victim: string, victimTeam: 'blue' | 'orange') {
        const li = document.createElement('li');
        const a = document.createElement('span');
        a.className = attackerTeam;
        a.textContent = `${attackerTeam === 'blue' ? '▲' : '■'} ${attacker}`;
        const v = document.createElement('span');
        v.className = victimTeam;
        v.textContent = `${victimTeam === 'blue' ? '▲' : '■'} ${victim}`;
        li.append(a, document.createTextNode(' ✦ '), v);
        this.feed.prepend(li);
        while (this.feed.children.length > 5) this.feed.lastElementChild!.remove();
        setTimeout(() => li.remove(), 6000);
    }

    /** Respawn countdown while splatted (null hides it). */
    setRespawn(seconds: number | null) {
        this.respawn.classList.toggle('hidden', seconds === null);
        if (seconds !== null) this.respawn.textContent = `스플랫! 부활까지 ${seconds.toFixed(1)}초`;
    }

    showToast(message: string, seconds = 2.5) {
        this.toast.textContent = message;
        this.toast.classList.add('show');
        this.toastTimer = seconds;
    }

    update(
        dt: number,
        state: PlayerState,
        aiming: boolean,
        stats: FrameStats,
        score: PaintScore,
        speedMultiplier: number
    ) {
        const hpRatio = Math.max(0, state.hp / PLAYER_MAX_HP);
        this.hpFill.style.width = `${hpRatio * 100}%`;
        this.hpValue.textContent = String(Math.ceil(state.hp));

        const weapon = WEAPONS[state.weaponId];
        this.ammo.textContent = String(state.ammo);
        this.magazine.textContent = ` / ${weapon.magazineSize}`;
        const next = state.nextWeaponId ? WEAPONS[state.nextWeaponId] : null;
        this.weaponName.textContent = next ? `${weapon.label} → ${next.label} (부활 시)` : `${weapon.label} · [1–4] 교체`;
        // Wider crosshair for spread weapons (visual hint of the pellet cone).
        this.crosshair.style.setProperty('--spread', `${Math.round(weapon.spreadRad * 160)}px`);
        const reloading = state.reloadTicksRemaining > 0;
        this.reload.classList.toggle('active', reloading);
        if (reloading) {
            const total = reloadTicks(weapon) || 1;
            this.reloadFill.style.width = `${(1 - state.reloadTicksRemaining / total) * 100}%`;
        }
        this.ammo.classList.toggle('low', state.ammo <= Math.ceil(weapon.magazineSize * 0.2));
        this.root.dataset.team = state.team;
        this.team.textContent = `팀 ${state.team === 'blue' ? '▲ BLUE' : '■ ORANGE'} · ${this.online ? '서버 배정' : '[T] 전환 (개발용)'}`;

        const cooldown = state.dashCooldownTicks;
        this.dash.classList.toggle('ready', cooldown === 0);
        this.dash.textContent = cooldown === 0 ? 'DASH [Q] 준비' : `DASH ${(cooldown / TICK_RATE).toFixed(1)}s`;
        this.dash.style.setProperty('--progress', String(1 - cooldown / MOVEMENT.dashCooldownTicks));

        this.crosshair.classList.toggle('aiming', aiming);
        this.updateScore(score);

        const p = state.position;
        const speed = Math.hypot(state.velocity.x, state.velocity.z);
        this.fps.textContent =
            `FPS ${stats.fps.toFixed(0).padStart(3)}  ${stats.frameMs.toFixed(1)}ms\n` +
            `SIM ${TICK_RATE}Hz  ${speed.toFixed(2)}m/s  PAINT x${speedMultiplier.toFixed(2)}\n` +
            `POS ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}`;

        if (this.hitTimer > 0) {
            this.hitTimer -= dt;
            if (this.hitTimer <= 0) this.crosshair.classList.remove('hit', 'kill');
        }
        this.damageLevel = Math.max(0, this.damageLevel - dt * 1.4);
        this.damage.style.opacity = String(this.damageLevel * 0.8);
        this.damage.dataset.team = state.team === 'blue' ? 'orange' : 'blue';

        if (this.toastTimer > 0) {
            this.toastTimer -= dt;
            if (this.toastTimer <= 0) this.toast.classList.remove('show');
        }
    }

    private updateScore(score: PaintScore) {
        const key = `${score.blue}/${score.orange}/${score.paintable}`;
        if (key === this.lastScoreKey) return;
        this.lastScoreKey = key;
        this.scoreBlue.textContent = pct(score.blue, score.paintable);
        this.scoreOrange.textContent = pct(score.orange, score.paintable);
        this.barBlue.style.width = `${paintPercent(score.blue, score.paintable)}%`;
        this.barOrange.style.width = `${paintPercent(score.orange, score.paintable)}%`;
        this.scoreSub.textContent =
            `미점령 ${pct(score.unpainted, score.paintable)} · ` +
            `${score.blue.toLocaleString()} / ${score.orange.toLocaleString()} / ${score.paintable.toLocaleString()}셀 · ${this.modeLabel}`;
    }
}
