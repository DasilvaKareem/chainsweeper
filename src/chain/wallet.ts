import type { Eip1193Provider } from 'ethers';
import { BrowserProvider, type JsonRpcSigner } from 'ethers';
import { SKALE_CHAIN } from './config';

const WALLET_CONNECTED_KEY = 'chainsweeper.wallet.connected';
const WALLET_LAST_ADDRESS_KEY = 'chainsweeper.wallet.lastAddress';

export interface InjectedWalletSession {
  eip1193: Eip1193Provider;
  provider: BrowserProvider;
  signer: JsonRpcSigner;
  address: string;
}

export function rememberedWalletAddress(): string | null {
  try {
    return window.localStorage.getItem(WALLET_LAST_ADDRESS_KEY);
  } catch {
    return null;
  }
}

export function clearRememberedWallet(): void {
  try {
    window.localStorage.removeItem(WALLET_CONNECTED_KEY);
    window.localStorage.removeItem(WALLET_LAST_ADDRESS_KEY);
  } catch {
    // Storage may be unavailable in private browsing modes.
  }
}

function hasRememberedWallet(): boolean {
  try {
    return window.localStorage.getItem(WALLET_CONNECTED_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberWallet(address: string): void {
  try {
    window.localStorage.setItem(WALLET_CONNECTED_KEY, '1');
    window.localStorage.setItem(WALLET_LAST_ADDRESS_KEY, address);
  } catch {
    // Non-fatal; the wallet still connected for this session.
  }
}

/**
 * Connect to the injected wallet. With `prompt: false`, this never calls
 * eth_requestAccounts; it only reuses accounts the wallet has already exposed
 * to this origin. That lets scenes auto-restore a wallet without a popup.
 */
export async function connectInjectedWallet(prompt: boolean): Promise<InjectedWalletSession | null> {
  const eip1193 = (globalThis as unknown as { ethereum?: Eip1193Provider }).ethereum;
  if (!eip1193) {
    if (prompt) throw new Error('No wallet detected — install MetaMask or similar');
    return null;
  }

  if (!prompt && !hasRememberedWallet()) return null;

  const provider = new BrowserProvider(eip1193);
  const accounts = await provider.send(prompt ? 'eth_requestAccounts' : 'eth_accounts', []);
  const address = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : '';
  if (!address) {
    clearRememberedWallet();
    if (prompt) throw new Error('No wallet account selected');
    return null;
  }

  const network = await provider.getNetwork();
  if (Number(network.chainId) !== SKALE_CHAIN.chainId) {
    if (!prompt) return null;
    await switchOrAddChain(eip1193);
  }

  const signer = await provider.getSigner(address);
  const signerAddress = await signer.getAddress();
  rememberWallet(signerAddress);
  return { eip1193, provider, signer, address: signerAddress };
}

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
