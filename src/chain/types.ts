// TypeScript mirrors of on-chain structs / enums. Keep in lockstep with
// contracts/MachineSweepMatch.sol — any shape drift will cause silent decode
// errors at the ethers boundary.
//
// We use `as const` objects (not TS enums) because the project's tsconfig
// has `erasableSyntaxOnly` enabled, which forbids enum syntax.

export const MatchStatus = {
  Pending: 0,
  Playing: 1,
  Ended: 2,
} as const;
export type MatchStatus = typeof MatchStatus[keyof typeof MatchStatus];

export const CellState = {
  Hidden: 0,
  Safe: 1,
  Core: 2,
} as const;
export type CellState = typeof CellState[keyof typeof CellState];

export interface ChainMatch {
  host: string;
  guest: string;
  width: number;
  height: number;
  coreCount: number;
  safeRemaining: number;
  currentPlayer: number;
  winner: number;
  hostHealth: number;
  guestHealth: number;
  hostScore: number;
  guestScore: number;
  status: MatchStatus;
}

export interface ChainCell {
  state: CellState;
  adjacency: number;
  revealedBy: number;
}

export interface RevealedEvent {
  matchId: string;
  player: number;
  x: number;
  y: number;
  wasCore: boolean;
  adjacency: number;
}

export interface MatchEndedEvent {
  matchId: string;
  winner: string;
  winnerSeat: number;
}

export interface HealthChangedEvent {
  matchId: string;
  player: number;
  health: number;
}

// ---------------------------------------------------------- Territories mode

export const PlotStatus = {
  Uncleared: 0,
  Cleared: 1,
  Corrupted: 2,
} as const;
export type PlotStatus = typeof PlotStatus[keyof typeof PlotStatus];

export interface ChainPlot {
  x: number;
  y: number;
  status: PlotStatus;
  safeRemaining: number;
  mintedAt: number;
  lastPlayer: string;
}

export interface ChainPlotCell {
  // 0 = hidden, 1 = safe, 2 = core
  state: 0 | 1 | 2;
  adjacency: number;
}

export interface PlotListing {
  seller: string;
  price: bigint;
  active: boolean;
}

export interface PlotMintedEvent {
  tokenId: bigint;
  owner: string;
  x: number;
  y: number;
}

export interface CellRevealedEvent {
  tokenId: bigint;
  x: number;
  y: number;
  wasCore: boolean;
  adjacency: number;
}

export interface PlotClearedEvent {
  tokenId: bigint;
  owner: string;
}

export interface PlotCorruptedEvent {
  tokenId: bigint;
  owner: string;
  mineX: number;
  mineY: number;
}
