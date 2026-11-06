import { sanitizeInput } from '@colorfront/shared';
import type { PlayerInput } from '@colorfront/shared';

/**
 * Nickname rules (GDD 5.1, 7.4): 2–12 visible characters, no markup or control characters.
 * Anything invalid falls back to a generated name rather than rejecting the player.
 */
export function sanitizeName(raw: unknown, fallbackSeed: string): string {
    const text = typeof raw === 'string' ? raw : '';
    const cleaned = text
        .normalize('NFC')
        .replace(/[\u0000-\u001f\u007f-\u009f<>&"'`\\/]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    const chars = Array.from(cleaned).slice(0, 12).join('');
    if (Array.from(chars).length >= 2) return chars;
    return `Runner-${fallbackSeed.slice(0, 4).toUpperCase()}`;
}

/**
 * Chat text: NFC, no control / zero-width / bidi-override characters, single spaces, at most
 * `max` visible characters. Returns null for anything that is not a non-empty string. Clients
 * render it as text (never HTML).
 */
export function sanitizeChat(raw: unknown, max: number): string | null {
    if (typeof raw !== 'string' || raw.length > max * 8) return null;
    const cleaned = raw
        .normalize('NFC')
        .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    const text = Array.from(cleaned).slice(0, max).join('');
    return text.length ? text : null;
}

/**
 * Parse an untrusted `in` message ([seq, moveX, moveZ, yaw, pitch, buttons]). Returns null for
 * anything that is not exactly that shape; values are clamped by the shared sanitizer.
 */
export function parseInput(raw: unknown): PlayerInput | null {
    if (!Array.isArray(raw) || raw.length !== 6) return null;
    for (const v of raw) if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    const [seq, moveX, moveZ, yaw, pitch, buttons] = raw as number[];
    if (seq < 0 || seq > 0xffffffff) return null;
    return sanitizeInput({ seq, moveX, moveZ, yaw, pitch, buttons });
}
