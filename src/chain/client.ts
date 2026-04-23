import {
  BrowserProvider,
  Contract,
  type ContractEventPayload,
  type Eip1193Provider,
  type Log,
} from 'ethers';
import { MATCH_ABI, RATINGS_ABI } from './abi';
import { BITE_SANDBOX_2, CONTRACTS, CTX_GAS_PAYMENT_WEI } from './config';
import {
  type ChainCell,
  type ChainMatch,
  type HealthChangedEvent,
  type MatchEndedEvent,
  type RevealedEvent,
} from './types';

/**
 * Browser wallet client for the MachineSweep on-chain contracts.
 *
 * Intentionally narrow: the chain layer exposes only what the scenes need
 * (create/join/reveal + typed events + rating reads). Keep Phaser imports
 * OUT of this module — per project layout, `src/chain/` is strictly isolated.
 */
export class ChainClient {
  private readonly matchC: Contract;
  private readonly ratingsC: Contract;
  readonly address: string;

  private constructor(matchC: Contract, ratingsC: Contract, address: string) {
    this.matchC = matchC;
    this.ratingsC = ratingsC;
    this.address = address;
  }

  /**
   * Prompt the injected wallet (MetaMask etc.) to connect and ensure we're on
   * BITE V2 Sandbox 2. Throws if no wallet is installed or the user rejects.
   */
  static async connect(): Promise<ChainClient> {
    const eip1193 = (globalThis as unknown as { ethereum?: Eip1193Provider }).ethereum;
    if (!eip1193) throw new Error('No wallet detected — install MetaMask or similar');

    const provider = new BrowserProvider(eip1193);
    await provider.send('eth_requestAccounts', []);

    const network = await provider.getNetwork();
    if (Number(network.chainId) !== BITE_SANDBOX_2.chainId) {
      await switchOrAddChain(eip1193);
    }

    const signer = await provider.getSigner();
    const address = await signer.getAddress();
    const matchC = new Contract(CONTRACTS.match, MATCH_ABI, signer);
    const ratingsC = new Contract(CONTRACTS.ratings, RATINGS_ABI, signer);
    return new ChainClient(matchC, ratingsC, address);
  }

  // ----------------------------------------------------------- match lifecycle

  async createMatch(
    matchId: string,
    width: number,
    height: number,
    coreCount: number,
    cipherCells: string[],
  ): Promise<string> {
    const tx = await this.matchC.createMatch(matchId, width, height, coreCount, cipherCells);
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async joinMatch(matchId: string): Promise<string> {
    const tx = await this.matchC.joinMatch(matchId);
    const receipt = await tx.wait();
    return receipt.hash;
  }

  /**
   * Submit a reveal tx. Pays CTX_GAS_PAYMENT and returns the tx hash. The
   * actual board mutation fires from the Revealed event (in the NEXT block
   * after BITE decrypts). Callers should subscribe via `onRevealed` rather
   * than trying to read getCell() immediately after the tx confirms.
   */
  async reveal(matchId: string, x: number, y: number): Promise<string> {
    const tx = await this.matchC.reveal(matchId, x, y, { value: CTX_GAS_PAYMENT_WEI });
    const receipt = await tx.wait();
    return receipt.hash;
  }

  // ---------------------------------------------------------------- reads

  async getMatch(matchId: string): Promise<ChainMatch> {
    const raw = await this.matchC.getMatch(matchId);
    return {
      host: raw.host,
      guest: raw.guest,
      width: Number(raw.width),
      height: Number(raw.height),
      coreCount: Number(raw.coreCount),
      safeRemaining: Number(raw.safeRemaining),
      currentPlayer: Number(raw.currentPlayer),
      winner: Number(raw.winner),
      hostHealth: Number(raw.hostHealth),
      guestHealth: Number(raw.guestHealth),
      hostScore: Number(raw.hostScore),
      guestScore: Number(raw.guestScore),
      status: Number(raw.status) as ChainMatch['status'],
    };
  }

  async getCell(matchId: string, x: number, y: number): Promise<ChainCell> {
    const raw = await this.matchC.getCell(matchId, x, y);
    return {
      state: Number(raw.state) as ChainCell['state'],
      adjacency: Number(raw.adjacency),
      revealedBy: Number(raw.revealedBy),
    };
  }

  async getRating(address: string): Promise<number> {
    const r: bigint = await this.ratingsC.getRating(address);
    return Number(r);
  }

  // ---------------------------------------------------------------- events

  /**
   * Subscribe to `Revealed` events for a given match. Returns a disposer.
   * Ethers v6 typed filter lets us scope by matchId server-side so we only
   * receive traffic for the match we care about.
   */
  onRevealed(matchId: string, cb: (ev: RevealedEvent) => void): () => void {
    const filter = this.matchC.filters.Revealed(matchId);
    const listener = (...args: unknown[]) => {
      const payload = args[args.length - 1] as ContractEventPayload;
      const [mid, player, x, y, wasCore, adjacency] = payload.args as unknown as [
        string, bigint, bigint, bigint, boolean, bigint,
      ];
      cb({
        matchId: mid,
        player: Number(player),
        x: Number(x),
        y: Number(y),
        wasCore,
        adjacency: Number(adjacency),
      });
    };
    this.matchC.on(filter, listener);
    return () => { this.matchC.off(filter, listener); };
  }

  onHealthChanged(matchId: string, cb: (ev: HealthChangedEvent) => void): () => void {
    const filter = this.matchC.filters.HealthChanged(matchId);
    const listener = (...args: unknown[]) => {
      const payload = args[args.length - 1] as ContractEventPayload;
      const [mid, player, health] = payload.args as unknown as [string, bigint, bigint];
      cb({ matchId: mid, player: Number(player), health: Number(health) });
    };
    this.matchC.on(filter, listener);
    return () => { this.matchC.off(filter, listener); };
  }

  onMatchEnded(matchId: string, cb: (ev: MatchEndedEvent) => void): () => void {
    const filter = this.matchC.filters.MatchEnded(matchId);
    const listener = (...args: unknown[]) => {
      const payload = args[args.length - 1] as ContractEventPayload;
      const [mid, winner, seat] = payload.args as unknown as [string, string, bigint];
      cb({ matchId: mid, winner, winnerSeat: Number(seat) });
    };
    this.matchC.on(filter, listener);
    return () => { this.matchC.off(filter, listener); };
  }

  /**
   * Backfill past Revealed events for a match — useful for a late-joining
   * spectator or a tab that just reconnected and needs to rebuild state.
   * Returns events in block order.
   */
  async getPastReveals(matchId: string, fromBlock: number = 0): Promise<RevealedEvent[]> {
    const filter = this.matchC.filters.Revealed(matchId);
    const logs = await this.matchC.queryFilter(filter, fromBlock) as unknown as Log[];
    return logs.map((raw) => {
      const args = (raw as unknown as { args: unknown[] }).args;
      const [mid, player, x, y, wasCore, adjacency] = args as [
        string, bigint, bigint, bigint, boolean, bigint,
      ];
      return {
        matchId: mid,
        player: Number(player),
        x: Number(x),
        y: Number(y),
        wasCore,
        adjacency: Number(adjacency),
      };
    });
  }
}

// ---------------------------------------------------------- wallet helpers

/**
 * EIP-3085 wallet_addEthereumChain / wallet_switchEthereumChain flow for
 * BITE V2 Sandbox 2. Tries to switch first; if the chain isn't in the
 * wallet yet, requests to add it and then switches.
 */
async function switchOrAddChain(eip1193: Eip1193Provider): Promise<void> {
  const hexChainId = '0x' + BITE_SANDBOX_2.chainId.toString(16);
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
          chainName: BITE_SANDBOX_2.name,
          nativeCurrency: { name: BITE_SANDBOX_2.nativeSymbol, symbol: BITE_SANDBOX_2.nativeSymbol, decimals: 18 },
          rpcUrls: BITE_SANDBOX_2.rpcUrl ? [BITE_SANDBOX_2.rpcUrl] : [],
          blockExplorerUrls: BITE_SANDBOX_2.explorerUrl ? [BITE_SANDBOX_2.explorerUrl] : [],
        }],
      });
    } else {
      throw err;
    }
  }
}
