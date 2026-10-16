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
    ['좌클릭', '페인트 사격 (6발/초 · 사거리 25m)', true],
    ['R', '재장전 (1.8초)', true],
    ['ESC', '설정 / 일시정지', true],
    ['T', '팀 전환 — 개발용', true],
    ['Tab · M · 1~4', '스코어보드 · 맵 · 무기 (추후)', false]
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
    private readonly message: HTMLElement;

    onChange?: (settings: GameSettings) => void;
    onPlay?: () => void;
    onTeam?: (team: TeamId) => void;
    onClearPaint?: () => void;
    onBots?: (count: number) => void;
    onVictory?: () => void;

    constructor(parent: HTMLElement, settings: GameSettings) {
        this.settings = { ...settings };
        this.root = document.createElement('div');
        this.root.className = 'menu-backdrop';
        this.root.innerHTML = `
            <div class="menu panel" role="dialog" aria-modal="true" aria-labelledby="menu-title">
                <header>
                    <h1 id="menu-title"></h1>
                    <p class="menu-sub">Neon Terminal · 오프라인 도색·전투 테스트 (로컬 봇 지원)</p>
                </header>
                <button class="play" type="button"></button>
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
                    </section>
                </div>
            </div>`;
        parent.append(this.root);

        this.title = this.root.querySelector('#menu-title')!;
        this.playButton = this.root.querySelector('.play')!;
        this.message = this.root.querySelector('.menu-message')!;

        this.playButton.addEventListener('click', () => this.onPlay?.());
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

        this.render();
    }

    show(mode: 'start' | 'paused') {
        this.title.textContent = mode === 'start' ? 'COLORFRONT' : '일시정지';
        this.playButton.textContent = mode === 'start' ? '클릭하여 플레이' : '계속하기';
        this.root.classList.remove('hidden');
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
