import { CHAT_MAX_LENGTH } from '@colorfront/shared';
import type { ChatMessage } from '@colorfront/shared';

const VISIBLE_LINES = 7;
const FADE_AFTER_MS = 10000;

/**
 * Chat box above the HP bar. Enter opens the input (game input is suspended while typing), Enter
 * sends, Esc or an empty line closes. "/t " sends to teammates only. Lines are rendered with
 * textContent only — never as HTML.
 */
export class ChatPanel {
    readonly root: HTMLElement;
    private readonly list: HTMLElement;
    private readonly form: HTMLFormElement;
    private readonly input: HTMLInputElement;
    private readonly lines: { el: HTMLElement; at: number }[] = [];
    private open = false;

    /** Called with the cleaned text and whether it is team-only. */
    onSend?: (text: string, team: boolean) => void;
    /** Typing state changed (game input must be suspended while open). */
    onOpenChange?: (open: boolean) => void;

    constructor(parent: HTMLElement) {
        this.root = document.createElement('div');
        this.root.className = 'chat';
        this.list = document.createElement('ol');
        this.list.className = 'chat-lines';
        this.list.setAttribute('aria-live', 'polite');
        this.form = document.createElement('form');
        this.form.className = 'chat-form hidden';
        this.input = document.createElement('input');
        this.input.type = 'text';
        this.input.maxLength = CHAT_MAX_LENGTH * 2;
        this.input.placeholder = '메시지 (Enter 전송 · Esc 취소 · /t 팀에게만)';
        this.input.setAttribute('aria-label', '채팅 입력');
        this.input.autocomplete = 'off';
        this.input.spellcheck = false;
        this.form.append(this.input);
        this.root.append(this.list, this.form);
        parent.append(this.root);

        this.form.addEventListener('submit', (e) => {
            e.preventDefault();
            this.submit();
        });
        this.input.addEventListener('keydown', (e) => {
            // Keep keys away from the game while typing.
            e.stopPropagation();
            if (e.code === 'Escape') this.close();
        });
        this.input.addEventListener('keyup', (e) => e.stopPropagation());
        this.input.addEventListener('blur', () => this.close());
    }

    get isOpen() {
        return this.open;
    }

    openInput() {
        if (this.open) return;
        this.open = true;
        this.form.classList.remove('hidden');
        this.root.classList.add('active');
        this.input.value = '';
        // Let the Enter that opened the box finish before focusing (no instant submit).
        setTimeout(() => this.input.focus(), 0);
        this.onOpenChange?.(true);
    }

    close() {
        if (!this.open) return;
        this.open = false;
        this.form.classList.add('hidden');
        this.root.classList.remove('active');
        this.input.blur();
        this.onOpenChange?.(false);
    }

    private submit() {
        let text = this.input.value.trim();
        let team = false;
        if (/^\/t(\s|$)/i.test(text)) {
            team = true;
            text = text.slice(2).trim();
        }
        if (text) this.onSend?.(text, team);
        this.close();
    }

    /** Add a line (from the server, or a local system/offline line). */
    add(m: Pick<ChatMessage, 'name' | 'team' | 'text' | 'scope'>, mine = false, system = false) {
        const li = document.createElement('li');
        li.className = system ? 'system' : m.team === 'orange' ? 'orange' : 'blue';
        if (mine) li.classList.add('mine');
        if (!system) {
            const name = document.createElement('b');
            name.textContent = `${m.team === 'orange' ? '■' : '▲'} ${m.name}${m.scope === 'team' ? ' [팀]' : ''}`;
            li.append(name, document.createTextNode(' '));
        }
        const text = document.createElement('span');
        text.textContent = m.text;
        li.append(text);
        this.list.append(li);
        this.lines.push({ el: li, at: performance.now() });
        while (this.lines.length > VISIBLE_LINES) this.lines.shift()!.el.remove();
    }

    /** Fade old lines unless the box is open. */
    update() {
        const now = performance.now();
        for (const l of this.lines) l.el.classList.toggle('faded', !this.open && now - l.at > FADE_AFTER_MS);
    }
}
