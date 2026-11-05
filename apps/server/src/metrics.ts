/** Rolling server tick statistics (GDD 8.1: tick average / p95 / max / overruns). */
export class TickMetrics {
    private readonly samples: number[] = [];
    private readonly capacity: number;
    ticks = 0;
    overruns = 0;
    maxMs = 0;
    paintBytes = 0;
    players = 0;
    /** Malformed inputs and unknown message types that were dropped. */
    rejected = 0;
    /** Ticks that threw (should stay 0). */
    errors = 0;
    readonly budgetMs: number;

    constructor(capacity = 900, budgetMs = 1000 / 30) {
        this.capacity = capacity;
        this.budgetMs = budgetMs;
    }

    record(ms: number, players: number) {
        this.ticks++;
        this.players = players;
        if (ms > this.budgetMs) this.overruns++;
        if (ms > this.maxMs) this.maxMs = ms;
        this.samples.push(ms);
        if (this.samples.length > this.capacity) this.samples.shift();
    }

    summary() {
        const sorted = [...this.samples].sort((a, b) => a - b);
        const avg = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
        const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
        return {
            ticks: this.ticks,
            players: this.players,
            tickAvgMs: +avg.toFixed(3),
            tickP95Ms: +p95.toFixed(3),
            tickMaxMs: +this.maxMs.toFixed(3),
            overruns: this.overruns,
            paintBytesTotal: this.paintBytes,
            rejectedMessages: this.rejected,
            tickErrors: this.errors
        };
    }
}
