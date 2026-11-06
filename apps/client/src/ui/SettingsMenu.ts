import type { TeamId } from '@colorfront/shared';

import { DEFAULT_SETTINGS } from '../settings/settings.ts';
import type { GameSettings, GraphicsQuality, RenderScale } from '../settings/settings.ts';

const CONTROLS: [string, string, boolean][] = [
    ['W A S D', '이동', true],
    ['마우스', '카메라 회전 · 조준', true],
    ['우클릭', '어깨너머 조준 (줌)', true],
    ['휠', '카메라 거리', true],
    ['Shift', '달리기', true],
    ['Space', '점프', true],
    ['Q', '대시 (4m · 쿨다운 6초)', true],
    ['좌클릭', '사격 (적 공격 + 바닥 칠하기)', true],
    ['1 · 2 · 3 · 4', '무기: 라이플 · 샷건 · SMG · 저격총 (스폰 구역에서 즉시)', true],
    ['R', '재장전', true],
    ['ESC', '설정 / 일시정지', true],
    ['G', '준비 / 준비 취소 (온라인 대기실)', true],
    ['Enter', '채팅 (팀 전용: /t 메시지)', true],
    ['T', '팀 전환 — 오프라인 개발용', true],
    ['Tab · M', '스코어보드 · 맵 (추후)', false]
];

/**
 * Start screen and ESC menu. Every control here is wired to a real setting; options the
 * browser cannot honour (e.g. VSync) are intentionally absent.
 */
export class SettingsMenu {
    readonly root: HTMLElement;
    private settings: GameSettings;
    private readonly title: HTMLElement;
    private readonly playButton: HTMLButtonElement;
    private readonly modeRow: HTMLElement;
    private readonly nameInput: HTMLInputElement;
    private readonly nameField: HTMLElement;
    private readonly onlineRow: HTMLElement;
    private readonly readyButton: HTMLButtonElement;
    private readonly sub: HTMLElement;
    private readonly message: HTMLElement;

    onChange?: (settings: GameSettings) => void;
    onPlay?: () => void;
    /** Start screen: join the authoritative server with this nickname. */
    onPlayOnline?: (name: string) => void;
    /** Start screen: offline practice with local bots (no server). */
    onPlayOffline?: () => void;
    onReady?: () => void;
    onLeaveOnline?: () => void;
    onTeam?: (team: TeamId) => void;
    onClearPaint?: () => void;
    onBots?: (count: number) => void;
    onVictory?: () => void;
    onWardrobe?: () => void;

    constructor(parent: HTMLElement, settings: GameSettings) {
        this.settings = { ...settings };
        this.root = document.createElement('div');
        this.root.className = 'menu-backdrop';
        this.root.innerHTML = `
            <div class="menu panel" role="dialog" aria-modal="true" aria-labelledby="menu-title">
                <header>
                    <h1 id="menu-title"></h1>
                    <p class="menu-sub"></p>
                </header>
                <label class="name-field"><span>닉네임</span><input type="text" maxlength="12" autocomplete="nickname" spellcheck="false" placeholder="2~12자" /></label>
                <div class="mode-row">
                    <button class="play" type="button" data-mode="online">온라인 매치 참가</button>
                    <button class="play secondary" type="button" data-mode="offline">오프라인 연습 (로컬 봇)</button>
                </div>
                <button class="play" type="button" data-mode="continue"></button>
                <button class="play secondary" type="button" data-action="wardrobe">아바타 꾸미기</button>
                <div class="mode-row online-row hidden">
                    <button class="play secondary" type="button" data-action="ready">준비 [G]</button>
                    <button class="play secondary" type="button" data-action="leave">방 나가기</button>
                </div>
                <p class="menu-message" role="alert"></p>
                <div class="menu-columns">
                    <section>
                        <h2>설정</h2>
                        <div class="field">
                            <span>그래픽 품질</span>
                            <div class="seg" data-key="quality">
                                <button type="button" data-value="low">낮음</button>
                                <button type="button" data-value="medium">중간</button>
                                <button type="button" data-value="high">높음</button>
                            </div>
                        </div>
                        <div class="field">
                            <span>렌더 스케일</span>
                            <div class="seg" data-key="renderScale">
                                <button type="button" data-value="0.5">50%</button>
                                <button type="button" data-value="0.75">75%</button>
                                <button type="button" data-value="1">100%</button>
                            </div>
                        </div>
                        <label class="field">
                            <span>마우스 감도 <output data-for="sensitivity"></output></span>
                            <input type="range" min="0.1" max="3" step="0.05" data-key="sensitivity" />
                        </label>
                        <label class="field">
                            <span>시야각 (FOV) <output data-for="fov"></output></span>
                            <input type="range" min="55" max="100" step="1" data-key="fov" />
                        </label>
                        <label class="field check"><input type="checkbox" data-key="invertY" /> <span>마우스 Y축 반전</span></label>
                        <label class="field check"><input type="checkbox" data-key="showFps" /> <span>FPS 표시</span></label>
                        <label class="field check"><input type="checkbox" data-key="cameraShake" /> <span>카메라 반동·흔들림</span></label>
                        <label class="field check"><input type="checkbox" data-key="autoScale" /> <span>자동 해상도 (프레임 유지)</span></label>
                        <div class="field row">
                            <button type="button" class="ghost" data-action="fullscreen">전체화면</button>
                            <button type="button" class="ghost" data-action="reset">기본값</button>
                        </div>
                    </section>
                    <section>
                        <h2>조작</h2>
                        <dl class="controls">
                            ${CONTROLS.map(([k, v, on]) => `<div class="${on ? '' : 'later'}"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}
                        </dl>
                        <h2 class="dev-title">개발자 도구</h2>
                        <p class="menu-sub online-only">온라인 매치에서는 서버가 팀·페인트·판정을 결정하므로 로컬 개발자 도구가 꺼집니다.</p>
                        <div class="dev-offline">
                        <div class="field">
                            <span>내 팀 (도색 색상)</span>
                            <div class="seg" data-dev="team">
                                <button type="button" data-value="blue">▲ 블루</button>
                                <button type="button" data-value="orange">■ 오렌지</button>
                            </div>
                        </div>
                        <div class="field">
                            <span>로컬 봇 (네트워크 아님)</span>
                            <div class="seg" data-dev="bots">
                                <button type="button" data-value="1">1:1</button>
                                <button type="button" data-value="7">4:4</button>
                                <button type="button" data-value="29">15:15</button>
                                <button type="button" data-value="0">제거</button>
                            </div>
                        </div>
                        <div class="field row">
                            <button type="button" class="ghost" data-action="clear-paint">페인트 초기화</button>
                            <button type="button" class="ghost" data-action="victory">승리 포즈</button>
                        </div>
                        </div>
                    </section>
                </div>
            </div>`;
        parent.append(this.root);

        this.title = this.root.querySelector('#menu-title')!;
        this.playButton = this.root.querySelector('[data-mode="continue"]')!;
        this.modeRow = this.root.querySelector('.mode-row')!;
        this.nameInput = this.root.querySelector('.name-field input')!;
        this.nameField = this.root.querySelector('.name-field')!;
        this.onlineRow = this.root.querySelector('.online-row')!;
        this.readyButton = this.root.querySelector('[data-action="ready"]')!;
        this.sub = this.root.querySelector('.menu-sub')!;
        this.message = this.root.querySelector('.menu-message')!;
        this.nameInput.value = loadName();

        this.playButton.addEventListener('click', () => this.onPlay?.());
        this.root.querySelector('[data-mode="online"]')!.addEventListener('click', () => {
            const name = this.nameInput.value.trim();
            saveName(name);
            this.onPlayOnline?.(name);
        });
        this.root.querySelector('[data-mode="offline"]')!.addEventListener('click', () => this.onPlayOffline?.());
        this.readyButton.addEventListener('click', () => this.onReady?.());
        this.root.querySelector('[data-action="leave"]')!.addEventListener('click', () => this.onLeaveOnline?.());
        for (const seg of this.root.querySelectorAll<HTMLElement>('.seg[data-key]')) {
            seg.addEventListener('click', (e) => {
                const button = (e.target as HTMLElement).closest('button');
                if (!button) return;
                const key = seg.dataset.key as 'quality' | 'renderScale';
                const raw = button.dataset.value!;
                if (key === 'quality') this.update({ quality: raw as GraphicsQuality });
                else this.update({ renderScale: Number(raw) as RenderScale });
            });
        }
        for (const input of this.root.querySelectorAll<HTMLInputElement>('input[data-key]')) {
            input.addEventListener('input', () => {
                const key = input.dataset.key as keyof GameSettings;
                this.update({ [key]: input.type === 'checkbox' ? input.checked : Number(input.value) });
            });
        }
        this.root
            .querySelector('[data-action="reset"]')!
            .addEventListener('click', () => this.update({ ...DEFAULT_SETTINGS }));
        this.root.querySelector('[data-dev="team"]')!.addEventListener('click', (e) => {
            const value = (e.target as HTMLElement).closest('button')?.dataset.value;
            if (value === 'blue' || value === 'orange') this.onTeam?.(value);
        });
        this.root.querySelector('[data-action="wardrobe"]')!.addEventListener('click', () => this.onWardrobe?.());
        this.root.querySelector('[data-action="clear-paint"]')!.addEventListener('click', () => this.onClearPaint?.());
        this.root.querySelector('[data-action="victory"]')!.addEventListener('click', () => this.onVictory?.());
        this.root.querySelector('[data-dev="bots"]')!.addEventListener('click', (e) => {
            const value = (e.target as HTMLElement).closest('button')?.dataset.value;
            if (value !== undefined) this.onBots?.(Number(value));
        });
        this.root.querySelector('[data-action="fullscreen"]')!.addEventListener('click', () => {
            const request = document.fullscreenElement
                ? document.exitFullscreen()
                : document.documentElement.requestFullscreen();
            request.catch(() => this.setMessage('이 브라우저에서 전체화면을 사용할 수 없습니다.'));
        });

        this.setOnline(false);
        this.render();
    }

    private online = false;

    show(mode: 'start' | 'paused') {
        const start = mode === 'start';
        this.title.textContent = start ? 'COLORFRONT' : '일시정지';
        this.playButton.textContent = '계속하기';
        this.playButton.classList.toggle('hidden', start);
        this.modeRow.classList.toggle('hidden', !start);
        this.nameField.classList.toggle('hidden', !start);
        this.onlineRow.classList.toggle('hidden', start || !this.online);
        this.sub.textContent = start
            ? 'Neon Terminal · 온라인 15 vs 15 페인트 매치 (권위 서버) 또는 오프라인 연습 (로컬 봇)'
            : this.online
              ? '온라인 매치 진행 중 · 게임은 일시정지되지 않습니다'
              : '오프라인 연습 · 로컬 봇은 네트워크 플레이어가 아닙니다';
        this.root.classList.remove('hidden');
    }

    /** Online mode hides the offline-only developer tools (the server decides teams and paint). */
    setOnline(online: boolean) {
        this.online = online;
        this.root.querySelector('.menu')!.classList.toggle('online', online);
        for (const el of this.root.querySelectorAll<HTMLElement>('.online-only')) el.classList.toggle('hidden', !online);
    }

    setReady(ready: boolean) {
        this.readyButton.textContent = ready ? '준비 취소 [G]' : '준비 [G]';
    }

    hide() {
        this.root.classList.add('hidden');
        this.setMessage('');
    }

    setMessage(text: string) {
        this.message.textContent = text;
    }

    /** Reflect the current team in the developer tools. */
    setTeam(team: TeamId) {
        for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-dev="team"] button')) {
            b.setAttribute('aria-pressed', String(b.dataset.value === team));
        }
    }

    private update(patch: Partial<GameSettings>) {
        this.settings = { ...this.settings, ...patch };
        this.render();
        this.onChange?.({ ...this.settings });
    }

    private render() {
        const s = this.settings;
        for (const seg of this.root.querySelectorAll<HTMLElement>('.seg[data-key]')) {
            const current = String(s[seg.dataset.key as 'quality' | 'renderScale']);
            for (const b of seg.querySelectorAll<HTMLButtonElement>('button')) {
                b.setAttribute('aria-pressed', String(b.dataset.value === current));
            }
        }
        for (const input of this.root.querySelectorAll<HTMLInputElement>('input[data-key]')) {
            const value = s[input.dataset.key as keyof GameSettings];
            if (input.type === 'checkbox') input.checked = Boolean(value);
            else input.value = String(value);
        }
        this.root.querySelector('output[data-for="sensitivity"]')!.textContent = s.sensitivity.toFixed(2);
        this.root.querySelector('output[data-for="fov"]')!.textContent = `${s.fov}°`;
    }
}

const NAME_KEY = 'colorfront.name';

function loadName(): string {
    try {
        return localStorage.getItem(NAME_KEY) ?? '';
    } catch {
        return '';
    }
}

function saveName(name: string) {
    try {
        localStorage.setItem(NAME_KEY, name);
    } catch {
        /* storage unavailable: the name is just not remembered */
    }
}
