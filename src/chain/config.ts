// Chain + contract configuration. Values here are the only coupling between
// the TS client and the deployed on-chain artifacts — update after each
// deploy (or lift into Vite env vars if we start supporting multiple envs).

export interface ChainInfo {
  chainId: number;
  name: string;
  /** JSON-RPC URL. Public — no gating on SKALE Base Sepolia. */
  rpcUrl: string;
  /** Block explorer for user-facing "view tx" links. Optional. */
  explorerUrl?: string;
  /** Native token symbol shown in wallet prompts. */
  nativeSymbol: string;
}

/**
 * SKALE Base Sepolia — public L2-style SKALE chain with BITE V2 CTX rolled
 * out (confirmed by SKALE core dev, 2026-04-22). Replaces the earlier gated
 * "BITE V2 Sandbox 2" deployment. Territories + PvP reveal flows both depend
 * on the CTX precompile being present on this chain.
 *
 * Native token is CREDIT — treat it like native gas (msg.value). The CTX
 * precompile accepts CREDIT as payment, so CTX_GAS_PAYMENT_WEI below is
 * denominated in CREDIT.
 */
export const SKALE_BASE_SEPOLIA: ChainInfo = {
  chainId: 324705682,
  name: 'SKALE Base Sepolia',
  // `||` (not `??`) so an empty-string env var (from a commented-out line in
  // .env that still exports `VITE_SKALE_RPC_URL=`) falls back to the default
  // — otherwise BITE validates `new URL('')` and throws "Invalid provider URL".
  rpcUrl:
    (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_SKALE_RPC_URL ||
    'https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha',
  explorerUrl: 'https://base-sepolia-testnet-explorer.skalenodes.com/',
  nativeSymbol: 'CREDIT',
};

/** Semantic alias; prefer in new call sites so future chain swaps are a one-line change. */
export const SKALE_CHAIN = SKALE_BASE_SEPOLIA;

/**
 * Deployed contract addresses. Placeholders until we actually deploy — then
 * paste the addresses here (or plumb through env vars for multi-deploy).
 */
export const CONTRACTS = {
  match: (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MATCH_CONTRACT ?? '0x0000000000000000000000000000000000000000',
  ratings: (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_RATINGS_CONTRACT ?? '0x0000000000000000000000000000000000000000',
  plots: (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_PLOTS_CONTRACT ?? '0x0000000000000000000000000000000000000000',
  repairs: (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_REPAIRS_CONTRACT ?? '0x0000000000000000000000000000000000000000',
  marketplace: (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MARKETPLACE_CONTRACT ?? '0x0000000000000000000000000000000000000000',
} as const;

/**
 * Mirrors MachineSweepMatch.CTX_GAS_PAYMENT — must stay in sync with contract.
 * Denominated in CREDIT (the SKALE Base Sepolia native token); msg.value
 * semantics are identical to ETH on Base.
 */
export const CTX_GAS_PAYMENT_WEI = 60_000_000_000_000_000n; // 0.06 CREDIT

/**
 * Display-only fallback; canonical price lives on-chain (PlotClient reads
 * MachineSweepPlots.PLOT_PRICE at connect time). 0.01 ETH-equivalent matches
 * the plan's suggested starting price.
 */
export const PLOT_PRICE_WEI_DEFAULT = 10_000_000_000_000_000n; // 0.01 ETH

/** Repair price default. Real value read on-chain. Plan calls for ~3x plot. */
export const REPAIR_PRICE_WEI_DEFAULT = 30_000_000_000_000_000n; // 0.03 ETH
