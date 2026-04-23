// WebSocket client for the Cloudflare Durable Object room backend. One DO
// per matchId (6-char code); this module speaks the JSON protocol defined in
// worker/src/roomDO.ts.
//
// Realtime coordination only — turn/connected-players/timer — NOT the source
// of truth for hidden mines. SKALE + BITE CTX remains authoritative for
// reveals and move verification.

// Wire-format move. Kept minimal and deterministic — both clients run the
// same reducer on the same seed, so identical moves applied in order yield
// identical state. elapsedMs is the actor's turn-clock reading; relayed so
// speed-combo scoring stays in sync.
export type NetMove =
  | { kind: 'reveal'; x: number; y: number; elapsedMs: number }
  | { kind: 'mark'; x: number; y: number }
  | { kind: 'skip' };

export type RoomEvent =
  | { type: 'opponent-joined'; playerId: string }
  | { type: 'opponent-left'; playerId: string }
  | { type: 'match-start' }
  | { type: 'match-config'; config: unknown }
  | { type: 'move'; by: string; move: NetMove }
  | { type: 'error'; message: string };

export interface RoomClient {
  readonly code: string;
  readonly you: string;
  readonly isHost: boolean;
  onEvent(cb: (ev: RoomEvent) => void): void;
  sendMatchConfig(config: unknown): void;
  sendMove(move: NetMove): void;
  close(): void;
}

// Ambiguous characters (0/O, 1/I) removed so codes are easy to read aloud.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRoomCode(length = 6): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

export function isValidRoomCode(code: string): boolean {
  if (code.length !== 6) return false;
  for (const ch of code) if (!ALPHABET.includes(ch)) return false;
  return true;
}

function workerBase(): string {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env ?? {};
  return env.VITE_WORKER_URL || 'ws://localhost:8787';
}

export async function createRoom(): Promise<RoomClient> {
  return connect(generateRoomCode(), true);
}

export async function joinRoom(code: string): Promise<RoomClient> {
  if (!isValidRoomCode(code)) throw new Error('Invalid code');
  return connect(code, false);
}

// Liveness tuning. We send a ping every PING_INTERVAL_MS and treat the link
// as dead if we've heard nothing at all — ping replies or real traffic — for
// STALE_THRESHOLD_MS. TCP keepalive won't notice a wedged connection fast
// (laptop sleep, NAT timeout, bad wifi), so this is the actual detection.
const PING_INTERVAL_MS = 15_000;
const STALE_THRESHOLD_MS = 30_000;

function connect(code: string, isHost: boolean): Promise<RoomClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${workerBase()}/room/${code}`);
    let listener: ((ev: RoomEvent) => void) | null = null;
    let resolved = false;
    let you = '';
    let lastMessageAt = Date.now();

    // Heartbeat: ping every 15s, tear the socket down if the server has been
    // silent > 30s. Closing triggers the ws close handler, which emits the
    // error event to listeners.
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
      // Any inbound byte resets the liveness clock, including server pongs.
      // That way a silent but healthy opponent doesn't look like a dead link.
      lastMessageAt = Date.now();
      let msg: unknown;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!isRecord(msg) || typeof msg.type !== 'string') return;

      // First message from the server is always room-state; we resolve the
      // connect promise once we've learned our playerId.
      if (msg.type === 'room-state') {
        if (!resolved) {
          you = typeof msg.you === 'string' ? msg.you : '';
          resolved = true;
          resolve({
            code,
            you,
            isHost,
            onEvent(cb) { listener = cb; },
            sendMatchConfig(config) {
              try { ws.send(JSON.stringify({ type: 'match-config', config })); } catch {}
            },
            sendMove(move) {
              try { ws.send(JSON.stringify({ type: 'move', move })); } catch {}
            },
            close() {
              clearInterval(heartbeat);
              try { ws.close(); } catch {}
              listener = null;
            },
          });
        }
        // If a second player is already present at connect time (join flow),
        // immediately fire match-start.
        const players = Array.isArray(msg.players) ? (msg.players as unknown[]) : [];
        if (players.length >= 2) {
          queueMicrotask(() => listener?.({ type: 'match-start' }));
        }
        return;
      }

      if (msg.type === 'opponent-joined' && typeof msg.playerId === 'string') {
        listener?.({ type: 'opponent-joined', playerId: msg.playerId });
        listener?.({ type: 'match-start' });
        return;
      }
      if (msg.type === 'opponent-left' && typeof msg.playerId === 'string') {
        listener?.({ type: 'opponent-left', playerId: msg.playerId });
        return;
      }
      if (msg.type === 'match-config') {
        listener?.({ type: 'match-config', config: msg.config });
        return;
      }
      if (msg.type === 'move') {
        const move = normalizeNetMove(msg.move);
        if (!move) return;
        const by = typeof msg.by === 'string' ? msg.by : '';
        listener?.({ type: 'move', by, move });
        return;
      }
    });

    ws.addEventListener('error', () => fail('Connection error'));
    ws.addEventListener('close', (ev) => {
      clearInterval(heartbeat);
      // Pre-upgrade failures (e.g. 409 Room full) land here without ever
      // resolving. WS close reason is often empty; rely on code.
      if (!resolved) fail(ev.reason || 'Failed to connect');
      else listener?.({ type: 'error', message: 'Disconnected' });
    });
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

// Move comes across as `unknown`; clamp to a valid NetMove or drop it.
function normalizeNetMove(raw: unknown): NetMove | null {
  if (!isRecord(raw)) return null;
  const kind = raw.kind;
  if (kind === 'skip') return { kind: 'skip' };
  if (kind === 'reveal' || kind === 'mark') {
    const x = typeof raw.x === 'number' ? raw.x | 0 : NaN;
    const y = typeof raw.y === 'number' ? raw.y | 0 : NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (kind === 'reveal') {
      const elapsedMs = typeof raw.elapsedMs === 'number' && raw.elapsedMs >= 0 ? raw.elapsedMs : 0;
      return { kind: 'reveal', x, y, elapsedMs };
    }
    return { kind: 'mark', x, y };
  }
  return null;
}
