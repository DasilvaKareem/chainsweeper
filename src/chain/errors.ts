// Shared tx-error helpers. Used by any scene that calls into ChainClient /
// PlotClient / the BITE SDK — so player-facing error messages stay consistent
// across PvP, Territories mint/reveal, and marketplace flows.

import { SKALE_CHAIN } from './config';

/** Pull the best human-readable string off an unknown value. */
export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Translate the noisy errors MetaMask + ethers + BITE throw into one-liners
 * a player can act on. Fall back to the raw message (clipped) for anything
 * we don't recognize; the full error object is expected to be logged via
 * console.error at the call site.
 *
 * Pattern-match on both `.code` (canonical EIP-1193) and `.message` because
 * wallets are inconsistent — MetaMask uses `4001` for user-rejected, some
 * libraries surface `ACTION_REJECTED`, and some surface only the raw revert
 * string.
 */
export function friendlyTxError(err: unknown): string {
  const e = err as {
    code?: string | number;
    shortMessage?: string;
    message?: string;
    reason?: string;
  };
  const code = e?.code;
  const msg = (e?.shortMessage || e?.reason || e?.message || '').toLowerCase();

  if (
    code === 4001 ||
    code === 'ACTION_REJECTED' ||
    msg.includes('user rejected') ||
    msg.includes('user denied')
  ) {
    return 'You rejected the transaction in your wallet.';
  }
  if (msg.includes('insufficient funds')) {
    return (
      `Not enough ${SKALE_CHAIN.nativeSymbol} to cover the transaction. ` +
      'Faucet: base-sepolia-faucet.skale.space'
    );
  }
  if (msg.includes('nonce')) {
    return (
      'Wallet nonce is out of sync — reset the account in MetaMask ' +
      '(Settings → Advanced → Clear activity tab data) and retry.'
    );
  }
  if (msg.includes('underpriced') || msg.includes('replacement transaction')) {
    return 'Another transaction is already pending. Wait for it to confirm, then retry.';
  }
  if (msg.includes('bad cipher') || msg.includes('malformed ctx')) {
    return 'BITE encryption produced invalid ciphertext. The CTX precompile may not be available on this chain.';
  }
  if (msg.includes('invalid provider url')) {
    return 'RPC provider URL is misconfigured — check VITE_SKALE_RPC_URL in .env.';
  }
  if (msg.includes('buffer is not defined')) {
    return 'Browser is missing the Buffer polyfill — this is a build bug, not a user problem.';
  }
  if (msg.includes('network') || msg.includes('fetch failed') || msg.includes('timeout')) {
    return 'Network error talking to the SKALE RPC — check your connection and retry.';
  }

  const raw = errMsg(err);
  return raw.length > 160 ? raw.slice(0, 157) + '…' : raw;
}
