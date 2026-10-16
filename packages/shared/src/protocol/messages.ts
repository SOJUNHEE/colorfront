/**
 * DRAFT message contract (GDD 7.2). Nothing implements these yet — there is no server in
 * Phase 1. Names and transport (room.send / onMessage, Schema state, raw bytes) must be
 * confirmed against the installed Colyseus 0.18 types in Phase 3 before use.
 */
import type { MatchPhase } from '../types/match.ts';
import type { PlayerInput, TeamId } from '../types/player.ts';

export const ClientMessage = {
    Input: 'input',
    Ready: 'ready',
    Reload: 'reload',
    PaintResync: 'paint:resync'
} as const;
export type ClientMessage = (typeof ClientMessage)[keyof typeof ClientMessage];

export const ServerMessage = {
    PaintSnapshot: 'paint:snapshot',
    PaintDelta: 'paint:delta',
    Event: 'hit/event',
    RoundResult: 'round:result'
} as const;
export type ServerMessage = (typeof ServerMessage)[keyof typeof ServerMessage];

export type InputMessage = PlayerInput;

export interface ReadyMessage {
    ready: boolean;
}

export interface PaintResyncMessage {
    surfaceId: number;
    expectedRevision: number;
}

export interface PaintSnapshotMessage {
    surfaceId: number;
    width: number;
    height: number;
    revision: number;
    /** Compressed ownership (+ mask) bytes; encoding decided in Phase 2/3. */
    data: Uint8Array;
    chunkIndex: number;
    chunkCount: number;
    crc32: number;
}

export interface PaintDeltaMessage {
    surfaceId: number;
    revision: number;
    tick: number;
    /** Changed cell indices and their new owners (0 none, 1 blue, 2 orange). */
    cells: Uint32Array;
    owners: Uint8Array;
}

export interface RoundResultMessage {
    phase: MatchPhase;
    paintableCount: number;
    blueCount: number;
    orangeCount: number;
    winner: TeamId | 'draw';
}
