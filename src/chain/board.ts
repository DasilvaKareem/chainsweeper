import { AbiCoder, keccak256, toUtf8Bytes } from 'ethers';
import { BITE } from '@skalenetwork/bite';
import { createMatch, type MatchConfig } from '../state/gameState';

/**
 * Board generated + encrypted by the host. The cipherCells array is the
 * payload shipped to MachineSweepMatch.createMatch — BITE ciphertexts of
 * `abi.encode(bool isCore, uint8 adjacency)` for each cell, row-major.
 */
export interface EncryptedBoard {
  matchId: string; // bytes32 hex
  width: number;
  height: number;
  coreCount: number;
  cipherCells: string[]; // hex-encoded BITE ciphertexts
}

/**
 * Derive a deterministic matchId from the DO room code + host-chosen salt.
 * Keeping DO and chain linkable-but-not-equal lets us index across both
 * systems without revealing the chain id from the DO code alone.
 */
export function deriveMatchId(roomCode: string, salt: string): string {
  return keccak256(toUtf8Bytes(`${roomCode}|${salt}`));
}

/**
 * Generate the plaintext board locally (reusing the off-chain reducer so
 * local/arcade builds and the on-chain host share one source of truth),
 * then BITE-encrypt each cell's (isCore, adjacency) tuple.
 *
 * Only the host runs this — the guest never sees plaintext cells. The seed
 * in `config` MUST stay secret to the host; the reducer is deterministic,
 * so sharing the seed defeats the privacy.
 *
 * @param rpcUrl         SKALE Base Sepolia RPC URL.
 * @param submitterAddr  Address of the deployed MachineSweepMatch contract.
 *                       BITE binds ciphertexts to the submitter via aadTE,
 *                       so this must match what's on-chain or decryption
 *                       will fail at CTX time.
 * @param config         Local-game MatchConfig; seed/board size/core count.
 */
export async function encryptBoard(
  rpcUrl: string,
  submitterAddr: string,
  config: MatchConfig,
): Promise<Omit<EncryptedBoard, 'matchId'>> {
  const gs = createMatch(config);
  const bite = new BITE(rpcUrl);
  const coder = AbiCoder.defaultAbiCoder();

  // Encrypt cells in parallel — each call hits the RPC for committee info,
  // but that's fine for the one-time commit at match-create time. If we see
  // this become a bottleneck on larger boards we can switch to a batched
  // API once the SDK exposes one for messages.
  const cipherCells: string[] = await Promise.all(
    gs.board.map(async (cell) => {
      const payload = coder.encode(['bool', 'uint8'], [cell.isCore, cell.adjacent]);
      return bite.encryptMessageForCTX(payload, submitterAddr);
    }),
  );

  return {
    width: config.width,
    height: config.height,
    coreCount: config.coreCount,
    cipherCells,
  };
}
