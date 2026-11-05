import { TICK_RATE } from '../constants/simulation.ts';
import { MATCH_START, MATCH_TIMING, type MatchTiming, type ResultsStage, createMatchTiming } from '../rules/match.ts';
import type { MatchPhase } from '../types/match.ts';

export type FlowTiming = {
    countdownTicks: number;
    playingTicks: number;
    revealTicks: number;
    summaryTicks: number;
};

export function flowTiming(timing: Partial<MatchTiming> = {}): FlowTiming {
    const t = createMatchTiming({ ...MATCH_TIMING, ...timing });
    return {
        countdownTicks: Math.max(1, Math.round(t.countdownSeconds * TICK_RATE)),
        playingTicks: Math.max(1, Math.round(t.playingSeconds * TICK_RATE)),
        revealTicks: Math.round(t.resultsRevealSeconds * TICK_RATE),
        summaryTicks: Math.max(1, Math.round(t.resultsSummarySeconds * TICK_RATE))
    };
}

export type FlowChange = { from: MatchPhase; to: MatchPhase; round: number };

/**
 * Server-side match phase machine (GDD 2.4, D-001, D-015):
 * WAITING → (≥ minPlayers, everyone ready) → COUNTDOWN → PLAYING → RESULTS (reveal + summary)
 * → WAITING for the next round in the same room. COUNTDOWN falls back to WAITING if players leave.
 */
export class MatchFlow {
    phase: MatchPhase = 'WAITING';
    ticksLeft = 0;
    round = 1;
    readonly timing: FlowTiming;
    readonly minPlayers: number;

    constructor(timing: FlowTiming = flowTiming(), minPlayers: number = MATCH_START.customRoomMinPlayers) {
        this.timing = timing;
        this.minPlayers = minPlayers;
    }

    /** Players may move (WAITING is free warm-up) only outside COUNTDOWN and RESULTS. */
    get acceptsInput(): boolean {
        return this.phase === 'WAITING' || this.phase === 'PLAYING';
    }

    get resultsStage(): ResultsStage | null {
        if (this.phase !== 'RESULTS') return null;
        return this.ticksLeft > this.timing.summaryTicks ? 'reveal' : 'summary';
    }

    /** Advance one tick given the current connected and ready player counts. */
    step(players: number, ready: number): FlowChange | null {
        const from = this.phase;
        switch (this.phase) {
            case 'WAITING':
                if (players >= this.minPlayers && ready === players) return this.enter('COUNTDOWN', this.timing.countdownTicks, from);
                return null;
            case 'COUNTDOWN':
                if (players < this.minPlayers) return this.enter('WAITING', 0, from);
                if (--this.ticksLeft <= 0) return this.enter('PLAYING', this.timing.playingTicks, from);
                return null;
            case 'PLAYING':
                if (--this.ticksLeft <= 0) return this.enter('RESULTS', this.timing.revealTicks + this.timing.summaryTicks, from);
                return null;
            case 'RESULTS':
                if (--this.ticksLeft <= 0) {
                    this.round++;
                    return this.enter('WAITING', 0, from);
                }
                return null;
            default:
                return null;
        }
    }

    private enter(to: MatchPhase, ticks: number, from: MatchPhase): FlowChange {
        this.phase = to;
        this.ticksLeft = ticks;
        return { from, to, round: this.round };
    }
}
