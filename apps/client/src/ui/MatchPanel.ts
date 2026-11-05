import { TICK_RATE, paintPercent } from '@colorfront/shared';
import type { MatchPhase, RoundResultMessage, TeamId } from '@colorfront/shared';

import type { ConnectionStatus, NetActor } from '../network/OnlineSession.ts';

const STATUS_TEXT: Record<ConnectionStatus, string> = {
    idle: '오프라인',
    connecting: '서버 연결 중…',
    connected: '온라인',
    reconnecting: '재연결 중…',
    disconnected: '연결 끊김',
    error: '연결 실패'
};

const mmss = (seconds: number) => {
    const s = Math.max(0, Math.ceil(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const teamMark = (t: TeamId) => (t === 'blue' ? '▲' : '■');

/**
 * Online match overlay: connection badge, phase/timer, lobby roster with ready state, and the
 * round result. Static template; every runtime string goes through textContent.
 */
export class MatchPanel {
    readonly root: HTMLElement;
    private readonly badge: HTMLElement;
    private readonly phaseLine: HTMLElement;
    private readonly lobby: HTMLElement;
    private readonly roster: HTMLElement;
    private readonly lobbyHint: HTMLElement;
    private readonly countdown: HTMLElement;
    private readonly results: HTMLElement;
    private readonly resultTitle: HTMLElement;
    private readonly resultScore: HTMLElement;
    private readonly resultTable: HTMLElement;
    private readonly resultMeta: HTMLElement;
    private rosterKey = '';

    constructor(parent: HTMLElement) {
        this.root = document.createElement('div');
        this.root.className = 'match hidden';
        this.root.innerHTML = `
            <div class="net-badge panel" data-status="idle"></div>
            <div class="match-phase"></div>
            <div class="match-lobby panel">
                <h3>대기실</h3>
                <ol class="roster"></ol>
                <p class="lobby-hint"></p>
            </div>
            <div class="match-countdown"></div>
            <div class="match-results panel hidden" role="dialog" aria-label="경기 결과">
                <h2></h2>
                <div class="result-score"></div>
                <table><thead><tr><th>플레이어</th><th>도색</th><th>스플랫</th><th>당함</th></tr></thead><tbody></tbody></table>
                <p class="result-meta"></p>
            </div>`;
        parent.append(this.root);
        const q = <T extends HTMLElement>(s: string) => this.root.querySelector(s) as T;
        this.badge = q('.net-badge');
        this.phaseLine = q('.match-phase');
        this.lobby = q('.match-lobby');
        this.roster = q('.roster');
        this.lobbyHint = q('.lobby-hint');
        this.countdown = q('.match-countdown');
        this.results = q('.match-results');
        this.resultTitle = q('.match-results h2');
        this.resultScore = q('.result-score');
        this.resultTable = q('.match-results tbody');
        this.resultMeta = q('.result-meta');
    }

    setVisible(visible: boolean) {
        this.root.classList.toggle('hidden', !visible);
    }

    update(view: {
        status: ConnectionStatus;
        roomId: string;
        rttMs: number;
        phase: MatchPhase;
        ticksLeft: number;
        round: number;
        actors: Iterable<NetActor>;
        localId: string;
        minPlayers: number;
        syncOk: boolean;
    }) {
        const actors = [...view.actors];
        this.badge.dataset.status = view.status;
        const code = view.roomId ? ` · 방 ${view.roomId}` : '';
        const ping = view.status === 'connected' && view.rttMs ? ` · ${Math.round(view.rttMs)}ms` : '';
        this.badge.textContent = `● ${STATUS_TEXT[view.status]}${code}${ping} · ${actors.length}명${view.syncOk ? '' : ' · 페인트 재동기화'}`;

        const seconds = view.ticksLeft / TICK_RATE;
        const phase = view.phase;
        if (phase === 'WAITING') this.phaseLine.textContent = `라운드 ${view.round} · 대기 중 (준비 [G])`;
        else if (phase === 'COUNTDOWN') this.phaseLine.textContent = `라운드 ${view.round} · 곧 시작`;
        else if (phase === 'PLAYING') this.phaseLine.textContent = `라운드 ${view.round} · ${mmss(seconds)}`;
        else if (phase === 'RESULTS') this.phaseLine.textContent = `라운드 ${view.round} · 결과`;
        else this.phaseLine.textContent = '';
        this.phaseLine.classList.toggle('urgent', phase === 'PLAYING' && seconds <= 10);

        this.lobby.classList.toggle('hidden', phase !== 'WAITING');
        if (phase === 'WAITING') {
            const key = actors.map((a) => `${a.id}:${a.team}:${a.ready}:${a.connected}:${a.name}`).join('|');
            if (key !== this.rosterKey) {
                this.rosterKey = key;
                this.roster.replaceChildren(
                    ...actors.map((a) => {
                        const li = document.createElement('li');
                        li.className = a.team;
                        li.textContent = `${teamMark(a.team)} ${a.name}${a.id === view.localId ? ' (나)' : ''}`;
                        const tag = document.createElement('span');
                        tag.textContent = !a.connected ? '재연결 대기' : a.ready ? '준비 완료' : '대기';
                        tag.className = a.ready ? 'ready' : '';
                        li.append(tag);
                        return li;
                    })
                );
            }
            const ready = actors.filter((a) => a.ready && a.connected).length;
            const connected = actors.filter((a) => a.connected).length;
            this.lobbyHint.textContent =
                connected < view.minPlayers
                    ? `최소 ${view.minPlayers}명이 필요합니다 (현재 ${connected}명). 대기 중에도 자유롭게 연습할 수 있습니다.`
                    : `[G] 준비 · ${ready}/${connected}명 준비 완료 — 모두 준비하면 카운트다운이 시작됩니다.`;
        }

        this.countdown.classList.toggle('hidden', phase !== 'COUNTDOWN');
        if (phase === 'COUNTDOWN') this.countdown.textContent = String(Math.max(1, Math.ceil(seconds)));
        if (phase !== 'RESULTS') this.results.classList.add('hidden');
    }

    showResult(r: RoundResultMessage, localId: string, localTeam: TeamId | null) {
        this.results.classList.remove('hidden');
        const win = r.winner === 'draw' ? '무승부' : `${teamMark(r.winner)} ${r.winner === 'blue' ? 'BLUE' : 'ORANGE'} 승리`;
        const mine = localTeam && r.winner !== 'draw' ? (r.winner === localTeam ? ' — 우리 팀 승리!' : ' — 패배') : '';
        this.resultTitle.textContent = `라운드 ${r.round} · ${win}${mine}`;
        this.resultTitle.dataset.winner = r.winner;
        this.resultScore.textContent =
            `▲ ${paintPercent(r.blue, r.paintable).toFixed(1)}%  vs  ` +
            `${paintPercent(r.orange, r.paintable).toFixed(1)}% ■   (${r.blue.toLocaleString()} / ${r.orange.toLocaleString()} / ${r.paintable.toLocaleString()}셀)`;
        const rows = [...r.players].sort((a, b) => b.painted - a.painted);
        this.resultTable.replaceChildren(
            ...rows.map((p) => {
                const tr = document.createElement('tr');
                tr.className = p.team + (p.id === localId ? ' me' : '');
                for (const v of [`${teamMark(p.team)} ${p.name}`, p.painted.toLocaleString(), String(p.kills), String(p.deaths)]) {
                    const td = document.createElement('td');
                    td.textContent = v;
                    tr.append(td);
                }
                return tr;
            })
        );
        this.resultMeta.textContent = `서버 판정 · 페인트 해시 ${(r.hash >>> 0).toString(16).padStart(8, '0')} · 잠시 후 대기실로 돌아갑니다`;
    }
}
