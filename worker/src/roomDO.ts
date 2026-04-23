// Room Durable Object — one instance per matchId. Holds the authoritative
// realtime state for a single match: connected players, (eventually) turn
// order, board snapshot, and timer. On-chain move verification stays on
// SKALE/BITE CTX; this DO coordinates *realtime UX* only.
//
// Uses the WebSocket hibernation API (acceptWebSocket) so the DO can be
// evicted between messages without dropping connections — much cheaper than
// holding an `addEventListener('message', ...)` handler alive forever.

interface Attachment {
  playerId: string;
  joinedAt: number;
}

type Outbound =
  | { type: 'room-state'; you: string; players: string[] }
  | { type: 'opponent-joined'; playerId: string }
  | { type: 'opponent-left'; playerId: string }
  | { type: 'match-config'; config: unknown }
  | { type: 'move'; by: string; move: unknown }
  | { type: 'pong' }
  | { type: 'error'; message: string };

const MAX_PLAYERS = 2;

export class Room {
  private state: DurableObjectState;

  constructor(state: DurableObjectState, _env: unknown) {
    this.state = state;
    // No-op: the runtime restores hibernated sockets automatically and we
    // read attachments on demand via deserializeAttachment.
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const live = this.state.getWebSockets();
    if (live.length >= MAX_PLAYERS) {
      return new Response('Room full', { status: 409 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const playerId = crypto.randomUUID();
    const attachment: Attachment = { playerId, joinedAt: Date.now() };
    server.serializeAttachment(attachment);

    this.state.acceptWebSocket(server);

    // Announce: tell the new socket who they are + who else is in the room.
    const players = this.currentPlayerIds();
    this.sendTo(server, { type: 'room-state', you: playerId, players });

    // Tell everyone else a new player arrived.
    this.broadcastExcept(server, { type: 'opponent-joined', playerId });

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let msg: unknown;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      this.sendTo(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }
    if (!isRecord(msg) || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'ping':
        this.sendTo(ws, { type: 'pong' });
        return;
      case 'match-config':
        // Thin relay: broadcast to everyone (including sender) so both
        // clients transition on the same signal. The DO does not validate
        // config shape — game logic stays on the client.
        if (isRecord(msg.config)) {
          this.broadcastAll({ type: 'match-config', config: msg.config });
        }
        return;
      case 'move': {
        // Per-move relay. Broadcast to everyone (sender included) so every
        // client applies moves in the same order — the DO's single-threaded
        // message loop is our sequencer. Game-logic validation lives on the
        // client (and eventually on-chain via BITE CTX).
        const att = ws.deserializeAttachment() as Attachment | null;
        const by = att?.playerId ?? '';
        if (isRecord(msg.move)) {
          this.broadcastAll({ type: 'move', by, move: msg.move });
        }
        return;
      }
      default:
        return;
    }
  }

  webSocketClose(ws: WebSocket) {
    this.handleDeparture(ws);
  }

  webSocketError(ws: WebSocket) {
    this.handleDeparture(ws);
  }

  private handleDeparture(ws: WebSocket) {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    this.broadcastExcept(ws, { type: 'opponent-left', playerId: att.playerId });
  }

  private currentPlayerIds(): string[] {
    return this.state.getWebSockets()
      .map((ws) => (ws.deserializeAttachment() as Attachment | null)?.playerId)
      .filter((id): id is string => typeof id === 'string');
  }

  private sendTo(ws: WebSocket, message: Outbound) {
    try { ws.send(JSON.stringify(message)); } catch {}
  }

  private broadcastExcept(exclude: WebSocket, message: Outbound) {
    const data = JSON.stringify(message);
    for (const ws of this.state.getWebSockets()) {
      if (ws === exclude) continue;
      try { ws.send(data); } catch {}
    }
  }

  private broadcastAll(message: Outbound) {
    const data = JSON.stringify(message);
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(data); } catch {}
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
