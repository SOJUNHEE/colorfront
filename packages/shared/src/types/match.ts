/** GDD 2.4 match phases. */
export const MatchPhase = {
    Waiting: 'WAITING',
    Countdown: 'COUNTDOWN',
    Playing: 'PLAYING',
    Results: 'RESULTS',
    Closed: 'CLOSED'
} as const;
export type MatchPhase = (typeof MatchPhase)[keyof typeof MatchPhase];

/** Allowed transitions. RESULTS -> CLOSED; a rematch is a new round/room (GDD 2.4). */
export const MATCH_PHASE_TRANSITIONS: Readonly<Record<MatchPhase, readonly MatchPhase[]>> = {
    WAITING: ['COUNTDOWN', 'CLOSED'],
    COUNTDOWN: ['PLAYING', 'WAITING', 'CLOSED'],
    PLAYING: ['RESULTS', 'CLOSED'],
    RESULTS: ['CLOSED'],
    CLOSED: []
};

export const canTransition = (from: MatchPhase, to: MatchPhase): boolean => MATCH_PHASE_TRANSITIONS[from].includes(to);
