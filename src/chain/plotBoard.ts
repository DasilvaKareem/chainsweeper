import { AbiCoder } from 'ethers';
import { BITE } from '@skalenetwork/bite';
import { createMatch } from '../state/gameState';

// MachineSweepPlots constants — must stay in lockstep with the contract.
export const PLOT_WIDTH = 8;
export const PLOT_HEIGHT = 8;
export const PLOT_CELL_COUNT = PLOT_WIDTH * PLOT_HEIGHT;
export const PLOT_CORE_COUNT = 10;

export interface EncryptedPlot {
  plotX: number;
  plotY: number;
  cipherCells: string[];
  // Retained client-side only — lets the player see their own uncommitted
  // layout when devving against a local chain without BITE. The contract
  // never sees it.
  localSeed: number;
}

/** Derive a per-plot seed from coords + a caller-chosen salt. */
export function plotSeed(plotX: number, plotY: number, salt: number): number {
  // Minimal mixing — mulberry32 inside createMatch handles the rest. A real
  // commit-reveal scheme would use a hidden salt + blockhash, but for MVP the
  // BITE encryption is already sufficient to keep mines secret from other
  // players: the cipher layer, not the seed, is what hides cores.
  const a = (plotX | 0) * 2654435761;
  const b = (plotY | 0) * 40503;
  return ((a ^ b ^ salt) >>> 0);
}

/**
 * Generate an 8x8 mine layout for a plot, BITE-encrypt each cell, and return
 * ciphertexts ready to pass into `MachineSweepPlots.mintPlot`. Mirrors
 * `src/chain/board.ts:encryptBoard` for the PvP match case.
 *
 * The seed is NOT sent on-chain — callers pass a private salt. Even if an
 * attacker later brute-forces the seed, they can't decrypt past ciphertexts
 * since BITE uses threshold encryption bound to the submitter address.
 */
export async function encryptPlot(
  rpcUrl: string,
  submitterAddr: string,
  plotX: number,
  plotY: number,
  salt: number,
): Promise<EncryptedPlot> {
  const seed = plotSeed(plotX, plotY, salt);
  const gs = createMatch({
    width: PLOT_WIDTH,
    height: PLOT_HEIGHT,
    coreCount: PLOT_CORE_COUNT,
    players: 1,
    seed,
  });
  const bite = new BITE(rpcUrl);
  const coder = AbiCoder.defaultAbiCoder();

  const cipherCells: string[] = await Promise.all(
    gs.board.map(async (cell) => {
      const payload = coder.encode(['bool', 'uint8'], [cell.isCore, cell.adjacent]);
      return bite.encryptMessageForCTX(payload, submitterAddr);
    }),
  );

  return { plotX, plotY, cipherCells, localSeed: seed };
}
