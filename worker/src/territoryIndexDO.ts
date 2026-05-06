// Territory Index Durable Object — single-writer aggregator for the
// MachineSweep Territories grid. Polls the SKALE chain for plot + marketplace
// events, maintains an in-memory index keyed by (x,y), and fans out snapshots
// + live updates to connected WebSocket clients.
//
// Why a DO, not the chain directly: at O(10k) plots, `queryFilter` from
// genesis on every client refresh is cost-prohibitive. One DO does the scan
// once and serves many clients; the viewport-virtualized renderer on the
// client side keeps Phaser happy.
//
// Consistency model: DO is an eventually-consistent CACHE. Authoritative
// state still lives on-chain. The DO persists `plots` + `lastBlock` to its
// own storage so cold starts resume from the last persisted block instead
// of replaying from FROM_BLOCK. A bounded recent-window rescan (every
// `RESCAN_INTERVAL_MS`, looking back `RESCAN_WINDOW_BLOCKS`) re-applies
// recent events to heal RPC flakiness or short reorgs without ever going
// back to genesis — that pattern blew Cloudflare's per-invocation
// subrequest budget once the chain grew past the contract deploy block.

interface Env {
  TERRITORY: DurableObjectNamespace;
  SKALE_RPC_URL: string;
  PLOTS_ADDRESS: string;
  MARKETPLACE_ADDRESS: string;
  /**
   * Floor block for the very first scan when the DO has no persisted
   * lastBlock. Set to the Plots contract's deploy block. After the first
   * complete catch-up, persisted `lastBlock` takes over and FROM_BLOCK
   * only matters again if storage is wiped.
   */
  FROM_BLOCK: string;
}

// Topic hashes precomputed from the event signatures. Regenerate via:
//   node -e "const{id}=require('ethers');console.log(id('Event(uint256,...)'))"
// If a contract event signature changes, the hash must be updated here too.
const TOPIC = {
  PlotMinted:     '0x6e56a84a585f0232238a20d76053f6613c3494c6c866718580bee6f49dec0b84',
  CellRevealed:   '0x7b7b447af23c59c2c9e9d34f7126f220d3aa7f835c77bd424fecaaec2e53012d',
  PlotCleared:    '0x2dae6bc4425f8b6e7ada4ba71f7c1ec2a1d936e130eb7b8bc58d6371c670881d',
  PlotCorrupted:  '0x4eec20d54356b4609fcc68c751b73416d476d2063eab2450f9275a36118157c2',
  PlotRepaired:   '0x4417352289f08fab8da6ffd6b8c6df1a87f1d04399547b1253bec5c9052998a2',
  Transfer:       '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  Listed:         '0x50955776c5778c3b7d968d86d8c51fb6b29a7a74c20866b533268e209fc08343',
  Bought:         '0x888231f55a3cd8fd72276bc1b12ed5a60f8d92e62d288e64bf29dd6e5fc7809a',
  Cancelled:      '0x26deca31ff8139a06c52453ce8985d34f7648a6d9af1d283c4063d052c355a0f',
  PriceUpdated:   '0x945c1c4e99aa89f648fbfe3df471b916f719e16d960fcec0737d4d56bd696838',
} as const;

// Poll cadence for incremental scans; alarm wakes the DO. Low enough that
// map updates feel live, high enough that RPC costs stay reasonable.
const POLL_INTERVAL_MS = 10_000;
// Periodically re-apply events from a recent window to heal RPC flakiness /
// reorgs. Bounded — never goes back to genesis (that pattern blew the
// Worker subrequest budget once the chain grew past the initial deploy).
const RESCAN_INTERVAL_MS = 10 * 60 * 1000;
const RESCAN_WINDOW_BLOCKS = 5_000;
// Max blocks per eth_getLogs call. SKALE rejects spans > 2000 with
// `-32005 Block range limit exceeded`, so 2000 is the hard ceiling.
const SCAN_CHUNK = 2_000;
// Cap on chunks scanned per Worker invocation. Each chunk = 2 eth_getLogs
// subrequests (plots + marketplace); Cloudflare's free-plan cap is 50 per
// invocation. 15 chunks ≈ 30 subrequests, leaving headroom for
// eth_blockNumber + occasional eth_getBlockByNumber lookups. If the catch-up
// gap exceeds this, we save progress and let the next alarm continue.
const MAX_CHUNKS_PER_INVOCATION = 15;

interface PlotCellEntry {
  x: number;
  y: number;
  state: 1 | 2; // safe | core
  adjacency: number;
}

interface PlotEntry {
  tokenId: string;   // hex (bigint would blow out JSON)
  x: number;
  y: number;
  owner: string;
  status: 0 | 1 | 2; // Uncleared | Cleared | Corrupted
  cells: PlotCellEntry[];
  listed: boolean;
  price: string;     // wei as decimal string
  mintedAt: number;  // block timestamp (seconds)
}

type Snapshot = { type: 'snapshot'; plots: PlotEntry[]; block: number };
type Delta    = { type: 'update'; plot: PlotEntry };
type Removed  = { type: 'removed'; tokenId: string };
type Pong     = { type: 'pong' };
type Err      = { type: 'error'; message: string };
type Outbound = Snapshot | Delta | Removed | Pong | Err;

export class TerritoryIndex {
  private doState: DurableObjectState;
  private env: Env;

  // Coord-keyed index. `${x},${y}` is the stable key even across status
  // changes; tokenId → coord lookups go through `byToken`.
  private plots = new Map<string, PlotEntry>();
  private byToken = new Map<string, string>(); // tokenId hex → coord key

  // Block scan state. lastBlock tracks where incremental polling resumes;
  // it's persisted in DO storage so cold starts don't replay from
  // FROM_BLOCK every time the DO is evicted.
  private lastBlock = 0;
  private lastFullRescanAt = 0;
  private scanning = false;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  // Set whenever an event handler mutates `plots`. Persistence is gated on
  // this so idle ticks (head moved, no events) don't rewrite the full
  // index every poll.
  private plotsDirty = false;
  // Storage keys.
  private static readonly KEY_LAST_BLOCK = 'lastBlock';
  private static readonly KEY_PLOTS = 'plots';

  constructor(state: DurableObjectState, env: Env) {
    this.doState = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    // ensureInitialized only loads persisted state — no RPC. The alarm
    // does the actual scanning, so the upgrade always returns fast even
    // if the DO is many thousands of blocks behind.
    await this.ensureInitialized();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.doState.acceptWebSocket(server);

    // Send current snapshot immediately so the client can paint without a
    // round-trip. May be empty/stale on a brand-new DO; live updates arrive
    // as the alarm-driven scan catches up.
    this.sendTo(server, {
      type: 'snapshot',
      plots: [...this.plots.values()],
      block: this.lastBlock,
    });

    // Kick the alarm so a connect on a cold DO triggers an immediate scan
    // (otherwise the user waits up to POLL_INTERVAL_MS for the next tick).
    await this.armAlarmImmediate();

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let msg: unknown;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (!isRecord(msg) || typeof msg.type !== 'string') return;
    if (msg.type === 'ping') this.sendTo(ws, { type: 'pong' });
  }

  webSocketClose(_ws: WebSocket) { /* sockets clean themselves up */ }
  webSocketError(_ws: WebSocket) { /* ditto */ }

  async alarm() {
    // Re-init from storage if the DO was evicted between alarms.
    await this.ensureInitialized();
    let moreWorkPending = false;
    try {
      moreWorkPending = await this.pollIncremental();
    } catch (err) {
      console.error('[TerritoryIndex] poll failed', err);
    }
    // Re-arm if there are live clients OR if we still have catch-up to do.
    // The catch-up case matters on a brand-new DO: scanning the historical
    // range takes many invocations (MAX_CHUNKS_PER_INVOCATION × SCAN_CHUNK
    // per tick), and we want progress to continue even when no one's
    // connected so the next user gets a complete snapshot.
    const hasClients = this.doState.getWebSockets().length > 0;
    if (hasClients || moreWorkPending) await this.ensureAlarm();
  }

  // ------------------------------------------------------------ init/poll

  private ensureInitialized(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      try {
        // Load persisted state. No RPC here — the alarm handles scanning.
        // Persisted plots survive DO eviction so cold starts skip the
        // 100k-block historical replay that used to blow the subrequest cap.
        const persistedLastBlock = await this.doState.storage.get<number>(
          TerritoryIndex.KEY_LAST_BLOCK,
        );
        const persistedPlots = await this.doState.storage.get<PlotEntry[]>(
          TerritoryIndex.KEY_PLOTS,
        );

        if (Array.isArray(persistedPlots)) {
          for (const p of persistedPlots) {
            const coord = `${p.x},${p.y}`;
            this.plots.set(coord, p);
            this.byToken.set(p.tokenId.toLowerCase(), coord);
          }
        }
        this.lastBlock = persistedLastBlock ?? 0;
        this.initialized = true;
      } finally {
        this.initPromise = null;
      }
    })();
    return this.initPromise;
  }

  /** Returns true if more catch-up remains for the next alarm to handle. */
  private async pollIncremental(): Promise<boolean> {
    if (this.scanning) return false;
    this.scanning = true;
    try {
      const head = await this.getBlockNumber();
      const now = Date.now();

      // Catch-up scan: from wherever we left off (persisted lastBlock) up
      // to head, bounded by MAX_CHUNKS_PER_INVOCATION so we never blow the
      // subrequest cap. If there's still gap left, the next alarm continues.
      const fromBlock = this.lastBlock > 0
        ? this.lastBlock + 1
        : parseFromBlock(this.env.FROM_BLOCK);
      let reachedHead = head;
      if (head >= fromBlock) {
        reachedHead = await this.scanRange(fromBlock, head);
        this.lastBlock = reachedHead;
        await this.persistLastBlock();
      }

      // Periodic recent-window rescan heals missed events (reorgs, RPC
      // flakiness). Bounded — never goes back to FROM_BLOCK. Events are
      // idempotent (set state by tokenId), so re-applying is safe.
      // Only run when catch-up reached head; otherwise we'd rescan a
      // window we haven't fully scanned yet.
      const caughtUp = reachedHead >= head;
      if (caughtUp && this.lastBlock > 0
          && now - this.lastFullRescanAt >= RESCAN_INTERVAL_MS) {
        const rescanFrom = Math.max(
          parseFromBlock(this.env.FROM_BLOCK),
          this.lastBlock - RESCAN_WINDOW_BLOCKS,
        );
        await this.scanRange(rescanFrom, this.lastBlock);
        this.lastFullRescanAt = now;
      }

      // Persist plots only when an event handler actually changed the
      // index. Avoids rewriting ~2MB on every idle tick.
      if (this.plotsDirty) {
        await this.persistPlots();
        this.plotsDirty = false;
      }

      return reachedHead < head;
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Scan [fromBlock, toBlock] inclusive in chunks of SCAN_CHUNK blocks,
   * stopping after MAX_CHUNKS_PER_INVOCATION chunks to stay under
   * Cloudflare's per-invocation subrequest cap. Returns the last block
   * actually scanned (caller persists it as lastBlock); the next alarm
   * picks up from there.
   *
   * Events within a chunk are applied in (blockNumber, logIndex) order —
   * ordering matters for correctness (e.g. a Listed event must not
   * overwrite a later Bought event).
   */
  private async scanRange(fromBlock: number, toBlock: number): Promise<number> {
    let chunks = 0;
    let lastEnd = fromBlock - 1;
    for (let start = fromBlock; start <= toBlock; start += SCAN_CHUNK) {
      if (chunks >= MAX_CHUNKS_PER_INVOCATION) break;
      const end = Math.min(start + SCAN_CHUNK - 1, toBlock);
      const plotsAddr = this.env.PLOTS_ADDRESS;
      const mktAddr = this.env.MARKETPLACE_ADDRESS;

      const [plotLogs, mktLogs] = await Promise.all([
        plotsAddr ? this.getLogs(plotsAddr, Object.values(TOPIC_PLOT), start, end) : Promise.resolve([]),
        mktAddr ? this.getLogs(mktAddr, Object.values(TOPIC_MARKET), start, end) : Promise.resolve([]),
      ]);

      const merged = [...plotLogs, ...mktLogs].sort((a, b) => {
        const ba = parseInt(a.blockNumber, 16);
        const bb = parseInt(b.blockNumber, 16);
        if (ba !== bb) return ba - bb;
        return parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16);
      });
      for (const log of merged) await this.applyLog(log);

      lastEnd = end;
      chunks++;
    }
    return lastEnd;
  }

  private async persistLastBlock() {
    await this.doState.storage.put(TerritoryIndex.KEY_LAST_BLOCK, this.lastBlock);
  }

  private async persistPlots() {
    // Stored as a flat array — much cheaper to deserialize than a Map and
    // small enough at expected scale (10k plots × ~200B = 2MB) to fit
    // comfortably in DO storage.
    await this.doState.storage.put(
      TerritoryIndex.KEY_PLOTS,
      [...this.plots.values()],
    );
  }

  private async applyLog(log: RawLog) {
    const topic0 = log.topics[0]?.toLowerCase();
    const addr = log.address.toLowerCase();
    const plotsAddr = (this.env.PLOTS_ADDRESS || '').toLowerCase();
    const mktAddr   = (this.env.MARKETPLACE_ADDRESS || '').toLowerCase();

    if (addr === plotsAddr) {
      if (topic0 === TOPIC.PlotMinted) return this.onPlotMinted(log);
      if (topic0 === TOPIC.CellRevealed) return this.onCellRevealed(log);
      if (topic0 === TOPIC.PlotCleared) return this.onPlotStatus(log, 1);
      if (topic0 === TOPIC.PlotCorrupted) return this.onPlotStatus(log, 2);
      if (topic0 === TOPIC.PlotRepaired) return this.onPlotStatus(log, 0, true);
      if (topic0 === TOPIC.Transfer) return this.onTransfer(log);
    } else if (addr === mktAddr) {
      if (topic0 === TOPIC.Listed) return this.onListed(log);
      if (topic0 === TOPIC.Bought) return this.onListingEnded(log);
      if (topic0 === TOPIC.Cancelled) return this.onListingEnded(log);
      if (topic0 === TOPIC.PriceUpdated) return this.onPriceUpdated(log);
    }
  }

  // ------------------------------------------------------- event handlers

  private async onPlotMinted(log: RawLog) {
    // PlotMinted(uint256 indexed tokenId, address indexed owner, int64 x, int64 y)
    const tokenId = log.topics[1] ?? '';
    const owner = decodeAddress(log.topics[2] ?? '');
    const data = stripHex(log.data);
    // data: int64 x (32 bytes), int64 y (32 bytes)
    const x = Number(decodeInt(data.slice(0, 64)));
    const y = Number(decodeInt(data.slice(64, 128)));

    const mintedAt = await this.getBlockTimestamp(parseInt(log.blockNumber, 16));
    const coordKey = `${x},${y}`;
    const tokenIdLower = tokenId.toLowerCase();
    const entry: PlotEntry = {
      tokenId: tokenIdLower,
      x, y,
      owner,
      status: 0,
      cells: [],
      listed: false,
      price: '0',
      mintedAt,
    };
    this.plots.set(coordKey, entry);
    this.byToken.set(tokenIdLower, coordKey);
    this.broadcast({ type: 'update', plot: entry });
  }

  private onCellRevealed(log: RawLog) {
    // CellRevealed(uint256 indexed tokenId, uint8 x, uint8 y, bool wasCore, uint8 adjacency)
    const tokenId = (log.topics[1] ?? '').toLowerCase();
    const coord = this.byToken.get(tokenId);
    if (!coord) return;
    const prev = this.plots.get(coord);
    if (!prev) return;

    const data = stripHex(log.data);
    const x = Number(decodeUint(data.slice(0, 64)));
    const y = Number(decodeUint(data.slice(64, 128)));
    const wasCore = decodeUint(data.slice(128, 192)) !== 0n;
    const adjacency = Number(decodeUint(data.slice(192, 256)));
    const nextCell: PlotCellEntry = {
      x,
      y,
      state: wasCore ? 2 : 1,
      adjacency,
    };

    const cells = prev.cells.filter((c) => c.x !== x || c.y !== y);
    cells.push(nextCell);
    cells.sort((a, b) => (a.y - b.y) || (a.x - b.x));

    const next: PlotEntry = { ...prev, cells };
    this.plots.set(coord, next);
    this.broadcast({ type: 'update', plot: next });
  }

  private onPlotStatus(log: RawLog, status: 0 | 1 | 2, resetCells = false) {
    const tokenId = (log.topics[1] ?? '').toLowerCase();
    const coord = this.byToken.get(tokenId);
    if (!coord) return;
    const prev = this.plots.get(coord);
    if (!prev) return;
    const next: PlotEntry = { ...prev, status, cells: resetCells ? [] : prev.cells };
    this.plots.set(coord, next);
    this.broadcast({ type: 'update', plot: next });
  }

  private onTransfer(log: RawLog) {
    // ERC-721 Transfer(from, to, tokenId). from=0 is a mint (handled by
    // PlotMinted with richer data); from=0 + to=marketplace is a list escrow;
    // we only care about tracking the visible owner for non-marketplace moves.
    const from = decodeAddress(log.topics[1] ?? '');
    const to = decodeAddress(log.topics[2] ?? '');
    const tokenId = (log.topics[3] ?? '').toLowerCase();
    if (from === '0x0000000000000000000000000000000000000000') return; // mint

    const mktAddr = (this.env.MARKETPLACE_ADDRESS || '').toLowerCase();
    const coord = this.byToken.get(tokenId);
    if (!coord) return;
    const prev = this.plots.get(coord);
    if (!prev) return;

    // If the NFT is escrowed by the marketplace, keep the previous owner —
    // Listed will flip `listed=true` too. When bought, Transfer fires with
    // from=mkt, to=buyer, and we set owner=buyer.
    if (to.toLowerCase() === mktAddr) return; // list escrow

    const next: PlotEntry = { ...prev, owner: to };
    this.plots.set(coord, next);
    this.broadcast({ type: 'update', plot: next });
  }

  private onListed(log: RawLog) {
    // Listed(uint256 indexed tokenId, address indexed seller, uint256 price)
    const tokenId = (log.topics[1] ?? '').toLowerCase();
    const data = stripHex(log.data);
    const price = decodeUint(data.slice(0, 64)).toString();
    const coord = this.byToken.get(tokenId);
    if (!coord) return;
    const prev = this.plots.get(coord);
    if (!prev) return;
    const next: PlotEntry = { ...prev, listed: true, price };
    this.plots.set(coord, next);
    this.broadcast({ type: 'update', plot: next });
  }

  private onListingEnded(log: RawLog) {
    const tokenId = (log.topics[1] ?? '').toLowerCase();
    const coord = this.byToken.get(tokenId);
    if (!coord) return;
    const prev = this.plots.get(coord);
    if (!prev) return;
    const next: PlotEntry = { ...prev, listed: false, price: '0' };
    this.plots.set(coord, next);
    this.broadcast({ type: 'update', plot: next });
  }

  private onPriceUpdated(log: RawLog) {
    const tokenId = (log.topics[1] ?? '').toLowerCase();
    const data = stripHex(log.data);
    const price = decodeUint(data.slice(0, 64)).toString();
    const coord = this.byToken.get(tokenId);
    if (!coord) return;
    const prev = this.plots.get(coord);
    if (!prev || !prev.listed) return;
    const next: PlotEntry = { ...prev, price };
    this.plots.set(coord, next);
    this.broadcast({ type: 'update', plot: next });
  }

  // -------------------------------------------------------------- RPC I/O

  private async getBlockNumber(): Promise<number> {
    const res = await this.rpc('eth_blockNumber', []);
    return parseInt(res as string, 16);
  }

  private blockTsCache = new Map<number, number>();
  private async getBlockTimestamp(blockNum: number): Promise<number> {
    const cached = this.blockTsCache.get(blockNum);
    if (cached !== undefined) return cached;
    const block = await this.rpc('eth_getBlockByNumber', [
      '0x' + blockNum.toString(16), false,
    ]) as { timestamp?: string } | null;
    const ts = block?.timestamp ? parseInt(block.timestamp, 16) : 0;
    // Cap cache size — we don't need ancient entries around forever.
    if (this.blockTsCache.size > 512) this.blockTsCache.clear();
    this.blockTsCache.set(blockNum, ts);
    return ts;
  }

  private async getLogs(
    address: string,
    topics0: string[],
    fromBlock: number,
    toBlock: number,
  ): Promise<RawLog[]> {
    const res = await this.rpc('eth_getLogs', [{
      address,
      fromBlock: '0x' + fromBlock.toString(16),
      toBlock: '0x' + toBlock.toString(16),
      topics: [topics0],
    }]);
    return Array.isArray(res) ? (res as RawLog[]) : [];
  }

  private async rpc(method: string, params: unknown[]): Promise<unknown> {
    const url = this.env.SKALE_RPC_URL;
    if (!url) throw new Error('SKALE_RPC_URL not configured');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`RPC ${method} failed: ${res.status}`);
    const json = await res.json() as { result?: unknown; error?: { message: string } };
    if (json.error) throw new Error(`RPC ${method} error: ${json.error.message}`);
    return json.result;
  }

  // ------------------------------------------------------------- WebSocket

  /** Arm the alarm POLL_INTERVAL_MS from now. Idempotent. */
  private async ensureAlarm() {
    const now = Date.now();
    const pending = await this.doState.storage.getAlarm();
    if (pending && pending > now) return;
    await this.doState.storage.setAlarm(now + POLL_INTERVAL_MS);
  }

  /**
   * Arm the alarm to fire ASAP — used on a fresh WS connect so a cold DO
   * doesn't make the user wait POLL_INTERVAL_MS before the first scan.
   * Overrides any pending alarm that was further out.
   */
  private async armAlarmImmediate() {
    const target = Date.now() + 1;
    const pending = await this.doState.storage.getAlarm();
    if (pending && pending <= target) return;
    await this.doState.storage.setAlarm(target);
  }

  private sendTo(ws: WebSocket, msg: Outbound) {
    try { ws.send(JSON.stringify(msg)); } catch { /* socket is going away */ }
  }

  private broadcast(msg: Outbound) {
    // Every mutation in this DO flows through broadcast(update|removed),
    // so this is the single place that flips the persistence dirty bit.
    if (msg.type === 'update' || msg.type === 'removed') this.plotsDirty = true;
    const data = JSON.stringify(msg);
    for (const ws of this.doState.getWebSockets()) {
      try { ws.send(data); } catch { /* ignore */ }
    }
  }
}

// ---- event-topic groupings (for per-address filtering in eth_getLogs) ---

const TOPIC_PLOT = {
  PlotMinted: TOPIC.PlotMinted,
  CellRevealed: TOPIC.CellRevealed,
  PlotCleared: TOPIC.PlotCleared,
  PlotCorrupted: TOPIC.PlotCorrupted,
  PlotRepaired: TOPIC.PlotRepaired,
  Transfer: TOPIC.Transfer,
} as const;
const TOPIC_MARKET = {
  Listed: TOPIC.Listed,
  Bought: TOPIC.Bought,
  Cancelled: TOPIC.Cancelled,
  PriceUpdated: TOPIC.PriceUpdated,
} as const;

// ---- ABI decode helpers ---------------------------------------------------

interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string; // hex
  logIndex: string;    // hex
  transactionHash: string;
}

/** Strip 0x prefix; returns hex without leading 0x. */
function stripHex(hex: string): string {
  return hex.startsWith('0x') ? hex.slice(2) : hex;
}

/** Decode 32-byte two's-complement signed int (works for int8..int256). */
function decodeInt(hex64: string): bigint {
  let b = BigInt('0x' + hex64);
  if ((b >> 255n) === 1n) b -= 1n << 256n;
  return b;
}

/** Decode 32-byte unsigned int. */
function decodeUint(hex64: string): bigint {
  return BigInt('0x' + hex64);
}

/** Decode a 32-byte topic/word slot as a 20-byte address. */
function decodeAddress(word: string): string {
  const clean = stripHex(word);
  return '0x' + clean.slice(-40);
}

/**
 * Parse FROM_BLOCK env value. Accepts decimal ("1628770"), hex ("0x18da62"),
 * or empty (→ 0). We default to 0 rather than throwing so the worker boots
 * locally without the var set, but production deploys should always supply
 * the Plots contract's deploy block.
 */
function parseFromBlock(raw: string | undefined): number {
  if (!raw) return 0;
  const n = raw.startsWith('0x') ? parseInt(raw, 16) : parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
