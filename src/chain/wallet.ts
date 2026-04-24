import type { Eip1193Provider } from 'ethers';
import { SKALE_CHAIN } from './config';

/**
 * EIP-3085 wallet_addEthereumChain / wallet_switchEthereumChain flow for
 * SKALE_CHAIN. Tries to switch first; if the chain isn't in the wallet yet,
 * requests to add it and then retries the switch.
 *
 * Shared by ChainClient (PvP) and PlotClient (Territories) so both flows
 * offer the same auto-switch UX.
 */
export async function switchOrAddChain(eip1193: Eip1193Provider): Promise<void> {
  const hexChainId = '0x' + SKALE_CHAIN.chainId.toString(16);
  try {
    await eip1193.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: hexChainId }],
    });
  } catch (err) {
    // Error code 4902 = "chain not added". Add it, then the switch is implicit.
    const code = (err as { code?: number }).code;
    if (code === 4902 || code === -32603) {
      await eip1193.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: hexChainId,
          chainName: SKALE_CHAIN.name,
          nativeCurrency: { name: SKALE_CHAIN.nativeSymbol, symbol: SKALE_CHAIN.nativeSymbol, decimals: 18 },
          rpcUrls: SKALE_CHAIN.rpcUrl ? [SKALE_CHAIN.rpcUrl] : [],
          blockExplorerUrls: SKALE_CHAIN.explorerUrl ? [SKALE_CHAIN.explorerUrl] : [],
        }],
      });
    } else {
      throw err;
    }
  }
}
