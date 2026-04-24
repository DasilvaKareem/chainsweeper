import {
  BrowserProvider,
  Contract,
  type ContractEventPayload,
  type Eip1193Provider,
  type Log,
} from 'ethers';
import { MARKETPLACE_ABI, PLOTS_ABI, REPAIRS_ABI } from './abi';
import {
  SKALE_CHAIN,
  CONTRACTS,
  CTX_GAS_PAYMENT_WEI,
  PLOT_PRICE_WEI_DEFAULT,
  REPAIR_PRICE_WEI_DEFAULT,
} from './config';
import { switchOrAddChain } from './wallet';
import {
  type CellRevealedEvent,
  type ChainPlot,
  type ChainPlotCell,
  type PlotClearedEvent,
  type PlotCorruptedEvent,
  type PlotListing,
  type PlotMintedEvent,
  PlotStatus,
} from './types';

/**
 * Browser wallet client for Territories mode (MachineSweepPlots + Repairs +
 * Marketplace). Mirrors the shape of `ChainClient` so scenes can treat either
 * mode's client the same way. Keep Phaser imports out of this file.
 */
export class PlotClient {
  readonly plotsC: Contract;
  readonly repairsC: Contract;
  readonly marketC: Contract;
  readonly provider: BrowserProvider;
  readonly address: string;
  plotPriceWei: bigint;
  repairPriceWei: bigint;

  private constructor(
    plotsC: Contract,
    repairsC: Contract,
    marketC: Contract,
    provider: BrowserProvider,
    address: string,
    plotPriceWei: bigint,
    repairPriceWei: bigint,
  ) {
    this.plotsC = plotsC;
    this.repairsC = repairsC;
    this.marketC = marketC;
    this.provider = provider;
    this.address = address;
    this.plotPriceWei = plotPriceWei;
    this.repairPriceWei = repairPriceWei;
  }

  /** Native CREDIT balance, in wei (SKALE Base native has 18 decimals like ETH). */
  async nativeBalance(): Promise<bigint> {
    return await this.provider.getBalance(this.address);
  }

  static async connect(): Promise<PlotClient> {
    const eip1193 = (globalThis as unknown as { ethereum?: Eip1193Provider }).ethereum;
    if (!eip1193) throw new Error('No wallet detected — install MetaMask or similar');

    const provider = new BrowserProvider(eip1193);
    await provider.send('eth_requestAccounts', []);

    const network = await provider.getNetwork();
    if (Number(network.chainId) !== SKALE_CHAIN.chainId) {
      await switchOrAddChain(eip1193);
    }

    const signer = await provider.getSigner();
    const address = await signer.getAddress();
    const plotsC = new Contract(CONTRACTS.plots, PLOTS_ABI, signer);
    const repairsC = new Contract(CONTRACTS.repairs, REPAIRS_ABI, signer);
    const marketC = new Contract(CONTRACTS.marketplace, MARKETPLACE_ABI, signer);

    // Pull canonical prices from the contracts. Fall back to compile-time
    // defaults if the call fails (e.g. contract not deployed yet).
    let plotPrice = PLOT_PRICE_WEI_DEFAULT;
    let repairPrice = REPAIR_PRICE_WEI_DEFAULT;
    try {
      plotPrice = BigInt(await plotsC.PLOT_PRICE());
    } catch { /* keep default */ }
    try {
      repairPrice = BigInt(await repairsC.REPAIR_PRICE());
    } catch { /* keep default */ }

    return new PlotClient(plotsC, repairsC, marketC, provider, address, plotPrice, repairPrice);
  }

  // ----------------------------------------------------------------- mint

  async mintPlot(plotX: number, plotY: number, cipherCells: string[]): Promise<string> {
    const tx = await this.plotsC.mintPlot(plotX, plotY, cipherCells, {
      value: this.plotPriceWei,
    });
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async revealCell(tokenId: bigint, x: number, y: number): Promise<string> {
    const tx = await this.plotsC.revealCell(tokenId, x, y, { value: CTX_GAS_PAYMENT_WEI });
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async repairPlot(tokenId: bigint, cipherCells: string[]): Promise<string> {
    const tx = await this.plotsC.repairPlot(tokenId, cipherCells);
    const receipt = await tx.wait();
    return receipt.hash;
  }

  // ---------------------------------------------------------------- reads

  async getPlot(tokenId: bigint): Promise<ChainPlot> {
    const raw = await this.plotsC.getPlot(tokenId);
    return {
      x: Number(raw.x),
      y: Number(raw.y),
      status: Number(raw.status) as PlotStatus,
      safeRemaining: Number(raw.safeRemaining),
      mintedAt: Number(raw.mintedAt),
      lastPlayer: raw.lastPlayer,
    };
  }

  async getCell(tokenId: bigint, x: number, y: number): Promise<ChainPlotCell> {
    const raw = await this.plotsC.getCell(tokenId, x, y);
    return {
      state: Number(raw.state) as ChainPlotCell['state'],
      adjacency: Number(raw.adjacency),
    };
  }

  async tokenIdFor(plotX: number, plotY: number): Promise<bigint> {
    const id: bigint = await this.plotsC.tokenIdFor(plotX, plotY);
    return id;
  }

  async ownerOf(tokenId: bigint): Promise<string> {
    return (await this.plotsC.ownerOf(tokenId)) as string;
  }

  async repairBalance(who?: string): Promise<number> {
    const owner = who ?? this.address;
    const repairId: bigint = await this.repairsC.REPAIR_CORE();
    const bal: bigint = await this.repairsC.balanceOf(owner, repairId);
    return Number(bal);
  }

  async buyRepair(amount: number): Promise<string> {
    const owed = this.repairPriceWei * BigInt(amount);
    const tx = await this.repairsC.buyFromProtocol(amount, { value: owed });
    const receipt = await tx.wait();
    return receipt.hash;
  }

  // ---------------------------------------------------------- marketplace

  async listPlot(tokenId: bigint, priceWei: bigint): Promise<string> {
    // Caller must have approved the marketplace first. Frontend should prompt
    // setApprovalForAll once and reuse.
    const tx = await this.marketC.list(tokenId, priceWei);
    return (await tx.wait()).hash;
  }

  async buyListing(tokenId: bigint): Promise<string> {
    const listing = await this.getListing(tokenId);
    if (!listing.active) throw new Error('Not listed');
    const tx = await this.marketC.buy(tokenId, { value: listing.price });
    return (await tx.wait()).hash;
  }

  async cancelListing(tokenId: bigint): Promise<string> {
    const tx = await this.marketC.cancel(tokenId);
    return (await tx.wait()).hash;
  }

  async getListing(tokenId: bigint): Promise<PlotListing> {
    const raw = await this.marketC.getListing(tokenId);
    return {
      seller: raw.seller,
      price: BigInt(raw.price),
      active: Boolean(raw.active),
    };
  }

  async approveMarketplace(): Promise<string> {
    const tx = await this.plotsC.setApprovalForAll(CONTRACTS.marketplace, true);
    return (await tx.wait()).hash;
  }

  async isMarketplaceApproved(): Promise<boolean> {
    return (await this.plotsC.isApprovedForAll(this.address, CONTRACTS.marketplace)) as boolean;
  }

  // --------------------------------------------------------------- events

  /** All minted plots ever. Used by PlotMapScene to paint the world. */
  async getAllMintedPlots(fromBlock: number = 0): Promise<PlotMintedEvent[]> {
    const filter = this.plotsC.filters.PlotMinted();
    const logs = (await this.plotsC.queryFilter(filter, fromBlock)) as unknown as Log[];
    return logs.map((raw) => {
      const args = (raw as unknown as { args: unknown[] }).args;
      const [tokenId, owner, x, y] = args as [bigint, string, bigint, bigint];
      return { tokenId: BigInt(tokenId), owner, x: Number(x), y: Number(y) };
    });
  }

  onPlotMinted(cb: (ev: PlotMintedEvent) => void): () => void {
    const filter = this.plotsC.filters.PlotMinted();
    const listener = (...args: unknown[]) => {
      const payload = args[args.length - 1] as ContractEventPayload;
      const [tokenId, owner, x, y] = payload.args as unknown as [bigint, string, bigint, bigint];
      cb({ tokenId: BigInt(tokenId), owner, x: Number(x), y: Number(y) });
    };
    this.plotsC.on(filter, listener);
    return () => { this.plotsC.off(filter, listener); };
  }

  onCellRevealed(tokenId: bigint, cb: (ev: CellRevealedEvent) => void): () => void {
    const filter = this.plotsC.filters.CellRevealed(tokenId);
    const listener = (...args: unknown[]) => {
      const payload = args[args.length - 1] as ContractEventPayload;
      const [tid, x, y, wasCore, adjacency] = payload.args as unknown as [
        bigint, bigint, bigint, boolean, bigint,
      ];
      cb({
        tokenId: BigInt(tid),
        x: Number(x),
        y: Number(y),
        wasCore,
        adjacency: Number(adjacency),
      });
    };
    this.plotsC.on(filter, listener);
    return () => { this.plotsC.off(filter, listener); };
  }

  onPlotCleared(tokenId: bigint, cb: (ev: PlotClearedEvent) => void): () => void {
    const filter = this.plotsC.filters.PlotCleared(tokenId);
    const listener = (...args: unknown[]) => {
      const payload = args[args.length - 1] as ContractEventPayload;
      const [tid, owner] = payload.args as unknown as [bigint, string];
      cb({ tokenId: BigInt(tid), owner });
    };
    this.plotsC.on(filter, listener);
    return () => { this.plotsC.off(filter, listener); };
  }

  onPlotCorrupted(tokenId: bigint, cb: (ev: PlotCorruptedEvent) => void): () => void {
    const filter = this.plotsC.filters.PlotCorrupted(tokenId);
    const listener = (...args: unknown[]) => {
      const payload = args[args.length - 1] as ContractEventPayload;
      const [tid, owner, mineX, mineY] = payload.args as unknown as [
        bigint, string, bigint, bigint,
      ];
      cb({
        tokenId: BigInt(tid),
        owner,
        mineX: Number(mineX),
        mineY: Number(mineY),
      });
    };
    this.plotsC.on(filter, listener);
    return () => { this.plotsC.off(filter, listener); };
  }
}
