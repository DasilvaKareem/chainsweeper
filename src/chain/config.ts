// Chain + contract configuration. Values here are the only coupling between
// the TS client and the deployed on-chain artifacts — update after each
// deploy (or lift into Vite env vars if we start supporting multiple envs).

export interface ChainInfo {
  chainId: number;
  name: string;
  /** JSON-RPC URL. Sandbox 2 URL is gated (Discord request) — fill this in. */
  rpcUrl: string;
  /** Block explorer for user-facing "view tx" links. Optional. */
  explorerUrl?: string;
  /** Native token symbol shown in wallet prompts. */
  nativeSymbol: string;
}

/**
 * BITE V2 Sandbox 2 — the only SKALE chain with CTX support today. RPC URL
 * is gated (Discord request per SKALE team); set it via VITE_SKALE_RPC_URL
 * once provisioned. Territories + PvP reveal flows both depend on the CTX
 * precompile being present on this chain.
 */
export const BITE_SANDBOX_2: ChainInfo = {
  chainId: 1036987955,
  name: 'BITE V2 Sandbox 2',
  rpcUrl: (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_SKALE_RPC_URL ?? '',
  nativeSymbol: 'sFUEL',
};

/** Semantic alias; same chain. Prefer in new call sites. */
export const SKALE_CHAIN = BITE_SANDBOX_2;

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

/** Mirrors MachineSweepMatch.CTX_GAS_PAYMENT — must stay in sync with contract. */
export const CTX_GAS_PAYMENT_WEI = 60_000_000_000_000_000n; // 0.06 ETH

/**
 * Display-only fallback; canonical price lives on-chain (PlotClient reads
 * MachineSweepPlots.PLOT_PRICE at connect time). 0.01 ETH-equivalent matches
 * the plan's suggested starting price.
 */
export const PLOT_PRICE_WEI_DEFAULT = 10_000_000_000_000_000n; // 0.01 ETH

/** Repair price default. Real value read on-chain. Plan calls for ~3x plot. */
export const REPAIR_PRICE_WEI_DEFAULT = 30_000_000_000_000_000n; // 0.03 ETH
