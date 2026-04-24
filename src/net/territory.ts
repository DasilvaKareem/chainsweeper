// WebSocket client for the TerritoryIndex Durable Object. Speaks the JSON
// protocol defined in worker/src/territoryIndexDO.ts:
//   server → client: snapshot (full index on connect), update (per-plot
//                    delta), removed (tokenId dropped after a rescan), pong.
//   client → server: ping (keepalive).
//
// Usage: `TerritoryClient.connect()` → returns a connected client. Call
// `onEvent(cb)` to receive snapshots + live updates. Call `close()` when
// done. Reconnect is the caller's concern for now — the PlotMapScene handles
// it by re-subscribing on retry.

export interface PlotCellEntry {
  x: number;
  y: number;
  state: 1 | 2; // safe | core
  adjacency: number;
}

export interface PlotEntry {
  tokenId: string; // hex (lowercased)
  x: number;
  y: number;
  owner: string;
  status: 0 | 1 | 2; // Uncleared | Cleared | Corrupted
  cells?: PlotCellEntry[];
  listed: boolean;
  price: string; // wei as decimal string (use BigInt(price) to do math)
  mintedAt: number; // unix seconds
}

export type TerritoryEvent =
  | { type: 'snapshot'; plots: PlotEntry[]; block: number }
  | { type: 'update'; plot: PlotEntry }
  | { type: 'removed'; tokenId: string }
  | { type: 'error'; message: string };

export interface TerritoryClient {
  onEvent(cb: (ev: TerritoryEvent) => void): void;
  close(): void;
}

const PING_INTERVAL_MS = 15_000;
const STALE_THRESHOLD_MS = 45_000;

function workerBase(): string {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env ?? {};
  return env.VITE_WORKER_URL || 'ws://localhost:8787';
}

export function connectTerritory(): Promise<TerritoryClient> {
  return new Promise<TerritoryClient>((resolve, reject) => {
    const ws = new WebSocket(`${workerBase()}/territory`);
    let listener: ((ev: TerritoryEvent) => void) | null = null;
    let resolved = false;
    let lastMessageAt = Date.now();

    // Heartbeat — keeps us + the DO honest about liveness, separate from
    // TCP keepalive which often doesn't detect wedged sockets (laptop sleep,
    // NAT timeout). If we see radio silence past STALE_THRESHOLD_MS we close.
    const heartbeat = setInterval(() => {
      if (Date.now() - lastMessageAt > STALE_THRESHOLD_MS) {
        try { ws.close(4000, 'stale'); } catch {}
        return;
      }
      try { ws.send(JSON.stringify({ type: 'ping' })); } catch {}
    }, PING_INTERVAL_MS);

    const fail = (message: string) => {
      if (!resolved) reject(new Error(message));
      else listener?.({ type: 'error', message });
    };

    ws.addEventListener('message', (ev) => {
      lastMessageAt = Date.now();
      let msg: unknown;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!isRecord(msg) || typeof msg.type !== 'string') return;

      if (msg.type === 'pong') return;

      if (msg.type === 'snapshot') {
        if (!resolved) {
          resolved = true;
          resolve({
            onEvent(cb) { listener = cb; },
            close() {
              clearInterval(heartbeat);
              try { ws.close(); } catch {}
              listener = null;
            },
          });
        }
        const plots = Array.isArray(msg.plots) ? msg.plots as PlotEntry[] : [];
        const block = typeof msg.block === 'number' ? msg.block : 0;
        // Replay snapshot to the listener if already attached. Usually the
        // listener is attached before the first snapshot lands (we resolve
        // the promise on snapshot; caller attaches in the same microtask).
        queueMicrotask(() => listener?.({ type: 'snapshot', plots, block }));
        return;
      }

      if (msg.type === 'update' && isRecord(msg.plot)) {
        listener?.({ type: 'update', plot: msg.plot as unknown as PlotEntry });
        return;
      }
      if (msg.type === 'removed' && typeof msg.tokenId === 'string') {
        listener?.({ type: 'removed', tokenId: msg.tokenId });
        return;
      }
    });

    ws.addEventListener('error', () => fail('Territory connection error'));
    ws.addEventListener('close', (ev) => {
      clearInterval(heartbeat);
      if (!resolved) fail(ev.reason || 'Failed to connect');
      else listener?.({ type: 'error', message: 'Disconnected' });
    });
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
