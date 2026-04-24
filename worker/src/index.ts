import { Room } from './roomDO';
import { TerritoryIndex } from './territoryIndexDO';

export { Room, TerritoryIndex };

export interface Env {
  ROOM: DurableObjectNamespace;
  TERRITORY: DurableObjectNamespace;
  // SKALE Base Sepolia RPC URL + deployed contract addresses. Required for
  // the TerritoryIndex DO's chain polling.
  SKALE_RPC_URL: string;
  PLOTS_ADDRESS: string;
  MARKETPLACE_ADDRESS: string;
  // Block where the Plots contract was deployed. DO scans start here instead
  // of block 0 to keep cold starts within the Worker CPU budget.
  FROM_BLOCK: string;
}

// Path-based routing:
//   GET /room/:code    → Room DO (one per matchId for PvP match rooms)
//   GET /territory     → TerritoryIndex DO (singleton for the plot map)
//
// idFromName is deterministic — same code / same name always lands on the
// same DO instance.
const ROOM_PATH = /^\/room\/([A-Z0-9]{6})$/;
const TERRITORY_PATH = '/territory';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }

    if (url.pathname === TERRITORY_PATH) {
      if (req.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }
      // Singleton: all clients connect to the same DO instance named 'global'.
      // When plot count outgrows one DO, shard by chunk coord (e.g., name =
      // `chunk-${floor(x/32)}-${floor(y/32)}`) and have the client subscribe
      // to the chunks its viewport overlaps.
      const id = env.TERRITORY.idFromName('global');
      const stub = env.TERRITORY.get(id);
      return stub.fetch(req);
    }

    const match = url.pathname.match(ROOM_PATH);
    if (match) {
      if (req.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }
      const code = match[1];
      const id = env.ROOM.idFromName(code);
      const stub = env.ROOM.get(id);
      return stub.fetch(req);
    }

    return new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
