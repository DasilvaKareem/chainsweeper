import * as Phaser from 'phaser';
import { addText } from '../ui/text';
import { audio } from '../audio/manager';
import {
  PlotClient,
  encryptPlot,
  BITE_SANDBOX_2,
  CONTRACTS,
  PlotStatus,
} from '../chain';
import {
  connectTerritory,
  type PlotEntry,
  type TerritoryClient,
  type TerritoryEvent,
} from '../net/territory';

// World-space pixels per plot on the map. In-plot board is 8x8, rendered
// here as a TILE_SIZE-wide status tile.
const TILE_SIZE = 64;
const GRID_LINE_COLOR = 0x1a2230;
const GRID_AXIS_COLOR = 0x3b7bff;

// Pan vs click threshold (screen px). Move < this between down/up = click.
const CLICK_SLOP = 5;

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const ZOOM_STEP = 1.15;

// Extra plots to render past the viewport edge so panning looks seamless —
// tiles are already constructed when they slide into view.
const VIEWPORT_PAD_PLOTS = 2;

interface TileObjects {
  rect: Phaser.GameObjects.Rectangle;
  glyph: Phaser.GameObjects.Text;
  scar?: Phaser.GameObjects.Graphics;
}

/**
 * Territories world map — pannable + zoomable infinite grid. Plots live in
 * the TerritoryIndex Durable Object; this scene subscribes once, caches the
 * index in memory, and renders ONLY tiles inside the current viewport (+ a
 * small pad). At O(10k) plots this keeps Phaser object count low four digits
 * regardless of world size.
 *
 * Writes (mint/list/buy/repair) still go to the chain via PlotClient; the DO
 * observes those events and pushes updates back to every connected client.
 */
export class PlotMapScene extends Phaser.Scene {
  private client?: PlotClient;
  private territory?: TerritoryClient;

  // --- HUD (rendered by UI camera at zoom=1, unaffected by map zoom) ---
  private statusText?: Phaser.GameObjects.Text;
  private hoverText?: Phaser.GameObjects.Text;
  private repairText?: Phaser.GameObjects.Text;
  private liveBadge?: Phaser.GameObjects.Text;
  private uiCam?: Phaser.Cameras.Scene2D.Camera;
  private hudObjects: Phaser.GameObjects.GameObject[] = [];

  // --- Map-space objects (main camera) ---
  private gridLayer?: Phaser.GameObjects.Graphics;
  private plotLayer?: Phaser.GameObjects.Container;
  private reticle?: Phaser.GameObjects.Rectangle;

  // Glyphs inside plot tiles — re-bake font size on zoom change so they stay
  // readable when zoomed out.
  private zoomInvariantTexts: Phaser.GameObjects.Text[] = [];
  private lastGlyphZoom = 0;

  // In-memory plot index (from the DO snapshot + live updates). Coord key
  // `${x},${y}` → entry.
  private index = new Map<string, PlotEntry>();
  private indexByToken = new Map<string, string>();

  // Currently rendered tiles, keyed by coord. Recycled on pan/zoom rather
  // than torn down and rebuilt to minimize churn.
  private rendered = new Map<string, TileObjects>();

  // Re-render debounce + viewport change tracking.
  private viewportDirty = true;
  private lastViewport: { x0: number; y0: number; x1: number; y1: number } | null = null;

  // Pan/click tracking.
  private isDragging = false;
  private dragStart: { x: number; y: number } | null = null;
  private downAt: { x: number; y: number } | null = null;

  constructor() {
    super('PlotMap');
  }

  create() {
    audio.playBgm('menu-quiet-invitation');
    const { width, height } = this.scale;

    // --- World surface ---
    this.cameras.main.setBackgroundColor('#06080c');
    this.cameras.main.centerOn(0, 0);

    this.gridLayer = this.add.graphics();
    this.plotLayer = this.add.container(0, 0);
    this.reticle = this.add
      .rectangle(0, 0, TILE_SIZE - 2, TILE_SIZE - 2, 0xf4a62a, 0)
      .setStrokeStyle(2, 0xf4a62a, 0.9)
      .setVisible(false);

    this.drawGrid();

    // --- HUD ---
    const title = this.hudText(20, 16, 'Territories', { fontSize: '24px', color: '#e8ecf1' });
    this.statusText = this.hudText(20, 48, 'Connecting to live index…', {
      fontSize: '13px', color: '#aab0bf',
    });
    this.liveBadge = this.hudText(20, 72, 'LIVE — off', {
      fontSize: '11px', color: '#5a6170',
    });
    this.hoverText = this.hudText(20, height - 30, '', { fontSize: '12px', color: '#6eb4ff' });
    this.repairText = this.hudText(width - 20, 48, '', { fontSize: '13px', color: '#f4a62a' })
      .setOrigin(1, 0);

    this.makeHudButton(width - 20, 16, 'Back', () => this.leave());
    this.makeHudButton(width - 110, 16, 'Connect', () => this.connectWallet());

    this.makeHudButton(width - 20, height - 16, 'Marketplace', () => this.openMarket());
    this.makeHudButton(width - 150, height - 16, 'Recenter', () => this.cameras.main.centerOn(0, 0));

    title.setDepth(10);
    this.statusText.setDepth(10);
    this.liveBadge.setDepth(10);
    this.hoverText.setDepth(10);
    this.repairText.setDepth(10);

    this.setupUiCamera();
    this.wirePanZoom();

    // Subscribe to the territory index immediately — reads don't need a
    // wallet. Wallet connect is a separate explicit step for writes.
    void this.connectTerritoryStream();
  }

  /** Called every frame by Phaser. Cheap invariants + viewport culling. */
  update() {
    this.updateGlyphScales();
    if (this.viewportDirty) this.renderVisible();
  }

  private updateGlyphScales() {
    if (this.zoomInvariantTexts.length === 0) return;
    const zoom = this.cameras.main.zoom;
    if (Math.abs(zoom - this.lastGlyphZoom) < 0.02) return;
    this.lastGlyphZoom = zoom;
    const fontPx = Math.max(8, Math.min(96, Math.round(14 / zoom)));
    const visible = TILE_SIZE * zoom >= 14;
    for (const t of this.zoomInvariantTexts) {
      t.setFontSize(fontPx);
      t.setVisible(visible);
    }
  }

  // ------------------------------------------------------------- HUD helpers

  private setupUiCamera() {
    const { width, height } = this.scale;
    this.uiCam = this.cameras.add(0, 0, width, height, false, 'ui');
    this.uiCam.setBackgroundColor('rgba(0,0,0,0)');
    this.cameras.main.ignore(this.hudObjects);
    const worldObjs: Phaser.GameObjects.GameObject[] = [];
    if (this.gridLayer) worldObjs.push(this.gridLayer);
    if (this.plotLayer) worldObjs.push(this.plotLayer);
    if (this.reticle) worldObjs.push(this.reticle);
    this.uiCam.ignore(worldObjs);
  }

  private hudText(
    x: number, y: number, text: string,
    style: Phaser.Types.GameObjects.Text.TextStyle,
  ): Phaser.GameObjects.Text {
    const t = addText(this, x, y, text, style);
    this.hudObjects.push(t);
    return t;
  }

  private makeHudButton(x: number, y: number, label: string, onClick: () => void) {
    const atRight = x > this.scale.width * 0.5;
    const atBottom = y > this.scale.height * 0.5;
    const originX = atRight ? 1 : 0;
    const originY = atBottom ? 1 : 0;
    const bg = this.add.rectangle(x, y, 100, 28, 0x14171e)
      .setStrokeStyle(1, 0x2a2e38)
      .setOrigin(originX, originY)
      .setDepth(10);
    const textObj = addText(this, 0, 0, label, { fontSize: '12px', color: '#aab0bf' })
      .setOrigin(0.5)
      .setDepth(10);
    textObj.setPosition(
      x + (atRight ? -50 : 50),
      y + (atBottom ? -14 : 14),
    );
    bg.setInteractive({ useHandCursor: true });
    bg.on('pointerover', () => bg.setFillStyle(0x1e242f));
    bg.on('pointerout', () => bg.setFillStyle(0x14171e));
    bg.on('pointerdown', (_p: Phaser.Input.Pointer, _lx: number, _ly: number, ev?: Phaser.Types.Input.EventData) => {
      ev?.stopPropagation?.();
    });
    bg.on('pointerup', onClick);
    this.hudObjects.push(bg, textObj);
  }

  // ---------------------------------------------------------- pan/zoom input

  private wirePanZoom() {
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      this.downAt = { x: p.x, y: p.y };
      this.dragStart = { x: p.x, y: p.y };
      this.isDragging = false;
    });

    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (this.dragStart && p.isDown) {
        const dx = p.x - this.dragStart.x;
        const dy = p.y - this.dragStart.y;
        if (!this.isDragging && (Math.abs(dx) > CLICK_SLOP || Math.abs(dy) > CLICK_SLOP)) {
          this.isDragging = true;
        }
        if (this.isDragging) {
          const cam = this.cameras.main;
          cam.scrollX -= dx / cam.zoom;
          cam.scrollY -= dy / cam.zoom;
          this.dragStart = { x: p.x, y: p.y };
          this.viewportDirty = true;
        }
      }
      this.updateReticle(p);
    });

    this.input.on('pointerup', (p: Phaser.Input.Pointer) => {
      const wasDrag = this.isDragging;
      const startDown = this.downAt;
      this.dragStart = null;
      this.isDragging = false;
      this.downAt = null;
      if (wasDrag || !startDown) return;
      const dist = Math.hypot(p.x - startDown.x, p.y - startDown.y);
      if (dist > CLICK_SLOP) return;
      const world = this.cameras.main.getWorldPoint(p.x, p.y);
      const { plotX, plotY } = this.worldToPlot(world.x, world.y);
      this.handleEmptyClick(plotX, plotY);
    });

    this.input.on(
      'wheel',
      (_pointer: unknown, _gameObjects: unknown, _dx: number, dy: number) => {
        const cam = this.cameras.main;
        const factor = dy < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
        cam.setZoom(Phaser.Math.Clamp(cam.zoom * factor, MIN_ZOOM, MAX_ZOOM));
        this.viewportDirty = true;
      },
    );
  }

  private updateReticle(p: Phaser.Input.Pointer) {
    if (!this.reticle || !this.hoverText) return;
    const world = this.cameras.main.getWorldPoint(p.x, p.y);
    const { plotX, plotY } = this.worldToPlot(world.x, world.y);
    const { cx, cy } = this.plotToWorldCenter(plotX, plotY);
    this.reticle.setPosition(cx, cy).setVisible(true);

    const key = coordKey(plotX, plotY);
    const cached = this.index.get(key);
    if (cached) {
      const mine = this.client && cached.owner.toLowerCase() === this.client.address.toLowerCase();
      const status = plotStatusLabel(cached.status);
      const listing = cached.listed ? ` · LISTED` : '';
      this.hoverText.setText(
        `(${plotX},${plotY})  ${status}${listing}  ·  ${short(cached.owner)}${mine ? ' (you)' : ''}`,
      );
    } else {
      this.hoverText.setText(`(${plotX},${plotY})  · empty · click to mint`);
    }
  }

  // ---------------------------------------------------------------- rendering

  private drawGrid() {
    if (!this.gridLayer) return;
    const g = this.gridLayer;
    g.clear();
    const span = 40;
    g.lineStyle(1, GRID_LINE_COLOR, 0.5);
    for (let i = -span; i <= span; i++) {
      const x = i * TILE_SIZE;
      const y = i * TILE_SIZE;
      g.lineBetween(x, -span * TILE_SIZE, x, span * TILE_SIZE);
      g.lineBetween(-span * TILE_SIZE, y, span * TILE_SIZE, y);
    }
    g.lineStyle(2, GRID_AXIS_COLOR, 0.35);
    g.lineBetween(0, -span * TILE_SIZE, 0, span * TILE_SIZE);
    g.lineBetween(-span * TILE_SIZE, 0, span * TILE_SIZE, 0);
  }

  /**
   * Diff visible-plots vs currently-rendered and add/remove tiles. Hot path —
   * called every frame when viewportDirty is set. Cost is O(plotsInViewport)
   * per run, plus O(rendered) for the cull pass.
   */
  private renderVisible() {
    this.viewportDirty = false;
    if (!this.plotLayer) return;

    const vp = this.getViewportPlotBounds();
    this.lastViewport = vp;

    // 1) Ensure everything in the viewport is rendered or up-to-date.
    for (let py = vp.y0; py <= vp.y1; py++) {
      for (let px = vp.x0; px <= vp.x1; px++) {
        const key = coordKey(px, py);
        const entry = this.index.get(key);
        if (!entry) {
          // No plot here — if we used to render one, drop it.
          const stale = this.rendered.get(key);
          if (stale) {
            this.destroyTile(stale);
            this.rendered.delete(key);
          }
          continue;
        }
        const existing = this.rendered.get(key);
        if (existing) {
          this.restyleTile(existing, entry);
        } else {
          const tile = this.createTile(entry);
          this.rendered.set(key, tile);
        }
      }
    }

    // 2) Cull: anything rendered that's now outside the viewport goes away.
    //    Dropping tiles keeps the Phaser object count bounded regardless of
    //    total plot count.
    for (const [key, tile] of this.rendered) {
      const [x, y] = parseKey(key);
      if (x < vp.x0 || x > vp.x1 || y < vp.y0 || y > vp.y1) {
        this.destroyTile(tile);
        this.rendered.delete(key);
      }
    }
  }

  private createTile(entry: PlotEntry): TileObjects {
    const { cx, cy } = this.plotToWorldCenter(entry.x, entry.y);
    const selfAddr = this.client?.address.toLowerCase() ?? '';
    const mine = entry.owner.toLowerCase() === selfAddr;
    const { fill, stroke } = colorsFor(entry.status, entry.listed);

    const rect = this.add
      .rectangle(cx, cy, TILE_SIZE - 2, TILE_SIZE - 2, fill, 1)
      .setStrokeStyle(mine ? 3 : (entry.listed ? 2 : 1), mine ? 0xffffff : stroke, 1);
    rect.setInteractive({ useHandCursor: true });
    rect.on('pointerdown', (_p: Phaser.Input.Pointer, _lx: number, _ly: number, ev?: Phaser.Types.Input.EventData) => {
      ev?.stopPropagation?.();
    });
    rect.on('pointerup', () => {
      if (!this.isDragging) this.openPlot(entry);
    });

    const glyph = addText(this, cx, cy, statusGlyph(entry.status), {
      fontSize: '14px', color: '#ffffff',
    }).setOrigin(0.5).setDepth(1);

    this.plotLayer!.add([rect, glyph]);
    this.zoomInvariantTexts.push(glyph);
    this.lastGlyphZoom = 0; // force font-size re-bake for the new glyph

    let scar: Phaser.GameObjects.Graphics | undefined;
    if (entry.status === PlotStatus.Corrupted) {
      scar = this.drawCorruptionScar(cx, cy);
      scar.setDepth(0.5);
      this.plotLayer!.add(scar);
    }
    return { rect, glyph, scar };
  }

  private restyleTile(tile: TileObjects, entry: PlotEntry) {
    const selfAddr = this.client?.address.toLowerCase() ?? '';
    const mine = entry.owner.toLowerCase() === selfAddr;
    const { fill, stroke } = colorsFor(entry.status, entry.listed);
    tile.rect.setFillStyle(fill, 1);
    tile.rect.setStrokeStyle(mine ? 3 : (entry.listed ? 2 : 1), mine ? 0xffffff : stroke, 1);
    tile.glyph.setText(statusGlyph(entry.status));

    const { cx, cy } = this.plotToWorldCenter(entry.x, entry.y);
    const wantScar = entry.status === PlotStatus.Corrupted;
    if (wantScar && !tile.scar) {
      tile.scar = this.drawCorruptionScar(cx, cy);
      tile.scar.setDepth(0.5);
      this.plotLayer!.add(tile.scar);
    } else if (!wantScar && tile.scar) {
      tile.scar.destroy();
      tile.scar = undefined;
    }
  }

  private destroyTile(tile: TileObjects) {
    // Pull glyphs out of the zoom-invariant tracking array so we don't
    // setFontSize on a destroyed object.
    const i = this.zoomInvariantTexts.indexOf(tile.glyph);
    if (i >= 0) this.zoomInvariantTexts.splice(i, 1);
    tile.rect.destroy();
    tile.glyph.destroy();
    tile.scar?.destroy();
  }

  private drawCorruptionScar(cx: number, cy: number): Phaser.GameObjects.Graphics {
    const g = this.add.graphics();
    const half = (TILE_SIZE - 2) / 2;
    g.lineStyle(1, 0xff6b6b, 0.55);
    const spacing = 10;
    for (let d = -half; d <= half; d += spacing) {
      g.lineBetween(cx - half, cy + d, cx + half, cy + d + TILE_SIZE);
      g.lineBetween(cx - half, cy + d + TILE_SIZE, cx + half, cy + d);
    }
    return g;
  }

  private getViewportPlotBounds() {
    const cam = this.cameras.main;
    const halfW = cam.width / (2 * cam.zoom);
    const halfH = cam.height / (2 * cam.zoom);
    const cx = cam.scrollX + cam.width / 2;
    const cy = cam.scrollY + cam.height / 2;
    const pad = VIEWPORT_PAD_PLOTS;
    return {
      x0: Math.floor((cx - halfW) / TILE_SIZE + 0.5) - pad,
      x1: Math.floor((cx + halfW) / TILE_SIZE + 0.5) + pad,
      y0: Math.floor((cy - halfH) / TILE_SIZE + 0.5) - pad,
      y1: Math.floor((cy + halfH) / TILE_SIZE + 0.5) + pad,
    };
  }

  // --------------------------------------------------------- territory stream

  private async connectTerritoryStream() {
    try {
      this.territory = await connectTerritory();
      this.statusText?.setText('Live — streaming plot updates from the index');
      this.liveBadge?.setText('LIVE — on').setColor('#6eff9c');
      this.territory.onEvent((ev) => this.onTerritoryEvent(ev));
    } catch (err) {
      this.statusText?.setText(`Territory stream offline: ${errMsg(err)}`);
      this.liveBadge?.setText('LIVE — off').setColor('#ff6b6b');
    }
  }

  private onTerritoryEvent(ev: TerritoryEvent) {
    switch (ev.type) {
      case 'snapshot': {
        this.index.clear();
        this.indexByToken.clear();
        for (const p of ev.plots) {
          this.index.set(coordKey(p.x, p.y), p);
          this.indexByToken.set(p.tokenId.toLowerCase(), coordKey(p.x, p.y));
        }
        this.viewportDirty = true;
        this.statusText?.setText(`Live · ${this.index.size} plots indexed (block ${ev.block})`);
        break;
      }
      case 'update': {
        const key = coordKey(ev.plot.x, ev.plot.y);
        this.index.set(key, ev.plot);
        this.indexByToken.set(ev.plot.tokenId.toLowerCase(), key);
        // If the updated plot lies in the current viewport, restyle it; if
        // it's outside the viewport we just update the in-memory index and
        // the tile will appear correctly styled if/when the viewport reaches
        // it.
        if (this.isInViewport(ev.plot.x, ev.plot.y)) {
          const existing = this.rendered.get(key);
          if (existing) this.restyleTile(existing, ev.plot);
          else {
            const tile = this.createTile(ev.plot);
            this.rendered.set(key, tile);
          }
        }
        this.statusText?.setText(`Live · ${this.index.size} plots indexed`);
        break;
      }
      case 'removed': {
        const key = this.indexByToken.get(ev.tokenId.toLowerCase());
        if (!key) break;
        const entry = this.index.get(key);
        if (entry) {
          this.index.delete(key);
          this.indexByToken.delete(ev.tokenId.toLowerCase());
          const stale = this.rendered.get(key);
          if (stale) {
            this.destroyTile(stale);
            this.rendered.delete(key);
          }
        }
        break;
      }
      case 'error': {
        this.liveBadge?.setText('LIVE — off').setColor('#ff6b6b');
        this.statusText?.setText(`Stream: ${ev.message}`);
        break;
      }
    }
  }

  private isInViewport(px: number, py: number): boolean {
    const vp = this.lastViewport;
    if (!vp) return false;
    return px >= vp.x0 && px <= vp.x1 && py >= vp.y0 && py <= vp.y1;
  }

  // ---------------------------------------------------------------- wallet

  private async connectWallet() {
    if (!this.statusText) return;
    try {
      this.client = await PlotClient.connect();
      this.statusText.setText(`Wallet: ${short(this.client.address)}`);
      const bal = await this.client.repairBalance().catch(() => 0);
      this.repairText?.setText(`Repair Items · ${bal}`);
      // Force a re-render so "mine" highlighting applies to visible tiles.
      for (const [key, tile] of this.rendered) {
        const entry = this.index.get(key);
        if (entry) this.restyleTile(tile, entry);
      }
    } catch (err) {
      this.statusText.setText(`Connect failed: ${errMsg(err)}`);
    }
  }

  private openMarket() {
    if (!this.client) {
      this.statusText?.setText('Connect your wallet to open the marketplace.');
      return;
    }
    this.scene.start('PlotMarket', { client: this.client });
  }

  private openPlot(entry: PlotEntry) {
    if (!this.client) {
      this.statusText?.setText('Connect your wallet to enter a plot.');
      return;
    }
    this.scene.start('Plot', {
      client: this.client,
      tokenId: BigInt(entry.tokenId),
      plotX: entry.x,
      plotY: entry.y,
      owner: entry.owner,
    });
  }

  private async handleEmptyClick(plotX: number, plotY: number) {
    if (!this.client) {
      this.statusText?.setText('Connect your wallet to mint.');
      return;
    }
    if (this.index.has(coordKey(plotX, plotY))) return;

    const confirmed = window.confirm(
      `Mint plot at (${plotX}, ${plotY})?\n` +
      `Price: ${formatEthShort(this.client.plotPriceWei)} sFUEL`,
    );
    if (!confirmed) return;

    const salt = Math.floor(Math.random() * 2 ** 30);
    this.statusText?.setText(`Encrypting plot (${plotX},${plotY})…`);
    try {
      const plot = await encryptPlot(BITE_SANDBOX_2.rpcUrl, CONTRACTS.plots, plotX, plotY, salt);
      this.statusText?.setText('Submitting mint tx…');
      const hash = await this.client.mintPlot(plotX, plotY, plot.cipherCells);
      this.statusText?.setText(`Minted ${hash.slice(0, 10)}… · waiting for the index to catch up`);
      // No manual refresh — the DO will push an update to us within
      // POLL_INTERVAL_MS (~10s).
    } catch (err) {
      this.statusText?.setText(`Mint failed: ${errMsg(err)}`);
    }
  }

  private leave() {
    this.territory?.close();
    this.territory = undefined;
    this.scene.start('MultiplayerHub');
  }

  // ------------------------------------------------------------------ utils

  private worldToPlot(worldX: number, worldY: number): { plotX: number; plotY: number } {
    return {
      plotX: Math.floor(worldX / TILE_SIZE + 0.5),
      plotY: Math.floor(worldY / TILE_SIZE + 0.5),
    };
  }

  private plotToWorldCenter(plotX: number, plotY: number): { cx: number; cy: number } {
    return { cx: plotX * TILE_SIZE, cy: plotY * TILE_SIZE };
  }
}

// ---- helpers (module-local) --------------------------------------------

function coordKey(x: number, y: number): string { return `${x},${y}`; }
function parseKey(k: string): [number, number] {
  const [a, b] = k.split(',');
  return [Number(a), Number(b)];
}

function colorsFor(status: PlotStatus, listed: boolean): { fill: number; stroke: number } {
  switch (status) {
    case PlotStatus.Uncleared:
      return { fill: 0x1e3a5f, stroke: listed ? 0xf4a62a : 0x4f8bff };
    case PlotStatus.Cleared:
      return { fill: 0x1f5c3a, stroke: listed ? 0xf4a62a : 0x6eff9c };
    case PlotStatus.Corrupted:
      return { fill: 0x5c1f1f, stroke: listed ? 0xf4a62a : 0xff6b6b };
    default:
      return { fill: 0x1e242f, stroke: 0x2a2e38 };
  }
}

function statusGlyph(status: PlotStatus): string {
  switch (status) {
    case PlotStatus.Uncleared: return '·';
    case PlotStatus.Cleared: return '✓';
    case PlotStatus.Corrupted: return '◆';
    default: return '';
  }
}

function plotStatusLabel(s: PlotStatus): string {
  switch (s) {
    case PlotStatus.Uncleared: return 'UNCLEARED';
    case PlotStatus.Cleared: return 'CLEARED';
    case PlotStatus.Corrupted: return 'CORRUPTED';
    default: return '?';
  }
}

function short(addr: string): string {
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatEthShort(wei: bigint): string {
  const whole = wei / 10n ** 14n;
  const str = (Number(whole) / 10_000).toFixed(4);
  return str.replace(/\.?0+$/, '');
}

