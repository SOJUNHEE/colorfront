/** GDD 2.4 match phases. */
export const MatchPhase = {
    Waiting: 'WAITING',
    Countdown: 'COUNTDOWN',
    Playing: 'PLAYING',
    Results: 'RESULTS',
    Closed: 'CLOSED'
} as const;
export type MatchPhase = (typeof MatchPhase)[keyof typeof MatchPhase];

/** Allowed transitions (GDD 2.4, amended by D-015). */
export const MATCH_PHASE_TRANSITIONS: Readonly<Record<MatchPhase, readonly MatchPhase[]>> = {
    WAITING: ['COUNTDOWN', 'CLOSED'],
    COUNTDOWN: ['PLAYING', 'WAITING', 'CLOSED'],
    PLAYING: ['RESULTS', 'CLOSED'],
    // A finished round returns to WAITING in the same room for the next round (D-015).
    RESULTS: ['WAITING', 'CLOSED'],
    CLOSED: []
};

export const canTransition = (from: MatchPhase, to: MatchPhase): boolean => MATCH_PHASE_TRANSITIONS[from].includes(to);
