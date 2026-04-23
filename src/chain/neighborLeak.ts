import type { PlotClient } from './plots';
import { PLOT_WIDTH, PLOT_HEIGHT } from './plotBoard';

/**
 * Cross-plot adjacency helper. When a player reveals a border cell at
 * (localX, localY) in plot (plotX, plotY), the contract stores only the
 * intra-plot adjacency (baked into the ciphertext at mint time). This helper
 * walks the 8 world-neighbors that fall across the plot boundary and reports
 * how many ALREADY-REVEALED cores they contain.
 *
 * Scope (v1):
 *   - We only count cells whose on-chain state is 2 (core). Hidden cells in
 *     neighbor plots contribute 0, even if the plot is Cleared — the cores
 *     in a cleared plot remain encrypted until/unless someone pays to
 *     force-decrypt them (see plan phase 5b).
 *   - We query neighbor plots on demand. No global subscription; callers who
 *     need live updates should re-run this when they see new reveal events
 *     on neighbor plots.
 *
 * Returns the ADDITIONAL core count to add on top of the stored adjacency,
 * plus the list of world neighbors that were unknowable (so callers can
 * show a "partial" badge).
 */
export interface NeighborLeak {
  extraCores: number;
  unknownNeighbors: number;
}

const BORDER_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [0, -1], [1, -1],
  [-1,  0],          [1,  0],
  [-1,  1], [0,  1], [1,  1],
];

export async function computeNeighborLeak(
  client: PlotClient,
  plotX: number,
  plotY: number,
  localX: number,
  localY: number,
): Promise<NeighborLeak> {
  // Only border cells can leak. Fast-path interior cells.
  if (
    localX > 0 && localX < PLOT_WIDTH - 1 &&
    localY > 0 && localY < PLOT_HEIGHT - 1
  ) {
    return { extraCores: 0, unknownNeighbors: 0 };
  }

  let extra = 0;
  let unknown = 0;

  // Cache neighbor-plot tokenId lookups so we don't pay for the same coord
  // twice per border cell (corners touch two neighbor plots).
  const tokenIdCache = new Map<string, bigint | null>();
  const getNeighborTokenId = async (px: number, py: number): Promise<bigint | null> => {
    const key = `${px},${py}`;
    if (tokenIdCache.has(key)) return tokenIdCache.get(key)!;
    try {
      const tid = await client.tokenIdFor(px, py);
      // ownerOf reverts for non-minted tokens, which tells us "no plot here".
      // Rather than catch a revert per lookup we try the cell read directly
      // and let a revert surface as "unknown".
      await client.ownerOf(tid);
      tokenIdCache.set(key, tid);
      return tid;
    } catch {
      tokenIdCache.set(key, null);
      return null;
    }
  };

  for (const [dx, dy] of BORDER_OFFSETS) {
    const nx = localX + dx;
    const ny = localY + dy;
    const insideOwnPlot =
      nx >= 0 && nx < PLOT_WIDTH && ny >= 0 && ny < PLOT_HEIGHT;
    if (insideOwnPlot) continue; // stored adjacency already covers this

    // Translate out-of-plot coords to (neighborPlot, neighborLocal). Since
    // BORDER_OFFSETS only shifts by ±1, nx/ny are in the range [-1, PLOT_WIDTH]
    // — at most one plot over in each axis.
    let neighborPlotX = plotX;
    let neighborLocalX = nx;
    if (nx < 0) { neighborPlotX = plotX - 1; neighborLocalX = nx + PLOT_WIDTH; }
    else if (nx >= PLOT_WIDTH) { neighborPlotX = plotX + 1; neighborLocalX = nx - PLOT_WIDTH; }

    let neighborPlotY = plotY;
    let neighborLocalY = ny;
    if (ny < 0) { neighborPlotY = plotY - 1; neighborLocalY = ny + PLOT_HEIGHT; }
    else if (ny >= PLOT_HEIGHT) { neighborPlotY = plotY + 1; neighborLocalY = ny - PLOT_HEIGHT; }

    const neighborTokenId = await getNeighborTokenId(neighborPlotX, neighborPlotY);
    if (neighborTokenId === null) {
      // No plot minted at that coord → no mine possible there.
      continue;
    }
    try {
      const cell = await client.getCell(neighborTokenId, neighborLocalX, neighborLocalY);
      if (cell.state === 2) extra += 1;
      else if (cell.state === 0) unknown += 1;
      // state === 1 (safe) contributes nothing
    } catch {
      unknown += 1;
    }
  }

  return { extraCores: extra, unknownNeighbors: unknown };
}
