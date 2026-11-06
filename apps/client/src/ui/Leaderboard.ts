import { PAINT_CELL_SIZE } from '@colorfront/shared';

export type LeaderEntry = { id: string; name: string; team: string; painted: number; kills: number };

/** Painted cells -> m² (a cell is PAINT_CELL_SIZE × PAINT_CELL_SIZE). */
const areaOf = (cells: number) => Math.round(cells * PAINT_CELL_SIZE * PAINT_CELL_SIZE);

/**
 * "점령 기여 TOP 5" (top-left): players ranked by the area they painted this round. The local
 * player is highlighted; if outside the top 5 their own rank is shown underneath.
 */
export class Leaderboard {
    readonly root: HTMLElement;
    private readonly list: HTMLOListElement;
    private readonly me: HTMLElement;
    private key = '';

    constructor(parent: HTMLElement) {
        this.root = document.createElement('section');
        this.root.className = 'leaderboard panel';
        this.root.setAttribute('aria-label', '점령 기여 순위');
        const h = document.createElement('h2');
        h.textContent = '점령 기여 TOP 5';
        this.list = document.createElement('ol');
        this.me = document.createElement('p');
        this.me.className = 'leaderboard-me hidden';
        this.root.append(h, this.list, this.me);
        parent.append(this.root);
    }

    setVisible(v: boolean) {
        this.root.classList.toggle('hidden', !v);
    }

    update(entries: LeaderEntry[], localId: string) {
        const ranked = [...entries].sort((a, b) => b.painted - a.painted || b.kills - a.kills || a.name.localeCompare(b.name));
        const top = ranked.slice(0, 5);
        const myRank = ranked.findIndex((e) => e.id === localId);
        const key = top.map((e) => `${e.id}:${e.painted}:${e.name}:${e.team}`).join('|') + `#${myRank}:${ranked[myRank]?.painted ?? 0}`;
        if (key === this.key) return; // DOM only changes when the ranking does
        this.key = key;
        this.list.replaceChildren(
            ...top.map((e, i) => {
                const li = document.createElement('li');
                li.className = e.team === 'orange' ? 'orange' : 'blue';
                if (e.id === localId) li.classList.add('mine');
                const rank = document.createElement('span');
                rank.className = 'rank';
                rank.textContent = String(i + 1);
                const name = document.createElement('span');
                name.className = 'name';
                name.textContent = `${e.team === 'orange' ? '■' : '▲'} ${e.name}`;
                const area = document.createElement('span');
                area.className = 'area';
                area.textContent = `${areaOf(e.painted)} m²`;
                li.append(rank, name, area);
                return li;
            })
        );
        const showMe = myRank >= 5;
        this.me.classList.toggle('hidden', !showMe);
        if (showMe) this.me.textContent = `나: ${myRank + 1}위 · ${areaOf(ranked[myRank].painted)} m²`;
    }
}
