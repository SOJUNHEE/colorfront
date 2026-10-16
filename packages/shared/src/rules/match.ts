import type { PaintScore } from '../paint/PaintGrid.ts';
import type { TeamId } from '../types/player.ts';

/**
 * Match timings in seconds (GDD 2.1, amended — see docs/DECISIONS.md D-001).
 * There is no JUDGING phase: the score is frozen the instant PLAYING ends, and RESULTS opens
 * with a short, configurable reveal before the result summary.
 */
export const MATCH_TIMING = {
    countdownSeconds: 15,
    playingSeconds: 300,
    /** Reveal animation at the start of RESULTS. GDD originally had a 15 s judging step. */
    resultsRevealSeconds: 5,
    /** Result summary / rematch choice after the reveal. */
    resultsSummarySeconds: 30
} as const;

export type MatchTiming = { -readonly [K in keyof typeof MATCH_TIMING]: number };

/** Upper bound for the reveal so a config change can never stall the result screen. */
export const MAX_RESULTS_REVEAL_SECONDS = 15;

/** Validate a timing override; the reveal is clamped to [0, MAX_RESULTS_REVEAL_SECONDS]. */
export function createMatchTiming(overrides: Partial<MatchTiming> = {}): MatchTiming {
    const t: MatchTiming = { ...MATCH_TIMING, ...overrides };
    const reveal = Number.isFinite(t.resultsRevealSeconds) ? t.resultsRevealSeconds : MATCH_TIMING.resultsRevealSeconds;
    t.resultsRevealSeconds = Math.min(MAX_RESULTS_REVEAL_SECONDS, Math.max(0, reveal));
    return t;
}

export type ResultsStage = 'reveal' | 'summary' | 'done';

/** Which part of the RESULTS phase is showing `elapsed` seconds after it began. */
export function resultsStageAt(elapsed: number, timing: MatchTiming = MATCH_TIMING): ResultsStage {
    if (elapsed < timing.resultsRevealSeconds) return 'reveal';
    if (elapsed < timing.resultsRevealSeconds + timing.resultsSummarySeconds) return 'summary';
    return 'done';
}

export interface RoundResult {
    paintable: number;
    blue: number;
    orange: number;
    winner: TeamId | 'draw';
}

/**
 * Freeze the score at the end of PLAYING (GDD 2.1): winner by raw cell counts, equal counts are
 * a draw even if rounded percentages differ or match.
 */
export function finalizeRound(score: PaintScore): RoundResult {
    const winner = score.blue > score.orange ? 'blue' : score.orange > score.blue ? 'orange' : 'draw';
    return { paintable: score.paintable, blue: score.blue, orange: score.orange, winner };
}

/** GDD 2.1 start conditions. */
export const MATCH_START = {
    customRoomMinPlayers: 2,
    publicRoomMinReadyPlayers: 6
} as const;

/** GDD 7.5 */
export const RECONNECT_GRACE_SECONDS = 30;
