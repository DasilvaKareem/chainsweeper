import * as Phaser from 'phaser';
import { addText } from '../ui/text';
import { audio } from '../audio/manager';
import {
  type PlotClient,
  type CellRevealedEvent,
  type PlotClearedEvent,
  type PlotCorruptedEvent,
  PlotStatus,
  PLOT_WIDTH,
  PLOT_HEIGHT,
  encryptPlot,
  SKALE_CHAIN,
  CONTRACTS,
  computeNeighborLeak,
  errMsg,
  friendlyTxError,
} from '../chain';

interface PlotSceneData {
  client: PlotClient;
  tokenId: bigint;
  plotX: number;
  plotY: number;
  owner: string;
}

type LocalCell = {
  state: 'hidden' | 'safe' | 'core';
  adjacency: number;
};

/**
 * Single-plot play surface. 8×8 board. Owner taps a cell -> revealCell tx ->
 * wait for CellRevealed event -> render the updated state. Mirrors the UX
 * pattern of MatchScene but without turn/combo/health systems.
 */
export class PlotScene extends Phaser.Scene {
  private client!: PlotClient;
  private tokenId!: bigint;
  private plotX = 0;
  private plotY = 0;
  private owner = '';
  private isOwner = false;

  private board: LocalCell[] = [];
  private tileRects: Phaser.GameObjects.Rectangle[] = [];
  private tileLabels: Phaser.GameObjects.Text[] = [];
  private statusText?: Phaser.GameObjects.Text;
  private plotStatus: PlotStatus = PlotStatus.Uncleared;

  // Post-corruption banner: big headline + inline "Repair for 1" CTA.
  private banner?: Phaser.GameObjects.Container;
  private repairChipText?: Phaser.GameObjects.Text;
  private repairBal = 0;

  private unsubRevealed?: () => void;
  private unsubCleared?: () => void;
  private unsubCorrupted?: () => void;

  private pending = new Set<number>(); // cell indices with pending reveals

  constructor() {
    super('Plot');
  }

  init(data: PlotSceneData) {
    this.client = data.client;
    this.tokenId = data.tokenId;
    this.plotX = data.plotX;
    this.plotY = data.plotY;
    this.owner = data.owner;
    this.isOwner = data.owner.toLowerCase() === data.client.address.toLowerCase();
    this.board = Array.from({ length: PLOT_WIDTH * PLOT_HEIGHT }, () => ({
      state: 'hidden',
      adjacency: 0,
    }));
    this.pending.clear();
  }

  create() {
    audio.playBgm('menu-quiet-invitation');
    const { width, height } = this.scale;

    addText(this, width / 2, 44, `Plot ( ${this.plotX} , ${this.plotY} )`, {
      fontSize: '24px', color: '#e8ecf1',
    }).setOrigin(0.5);

    addText(this, width / 2, 72, this.isOwner ? 'YOUR PLOT' : `Owner ${short(this.owner)} · read-only`, {
      fontSize: '12px',
      color: this.isOwner ? '#f4a62a' : '#6eb4ff',
    }).setOrigin(0.5);

    this.statusText = addText(this, width / 2, 96, 'Loading…', {
      fontSize: '13px', color: '#aab0bf',
    }).setOrigin(0.5);

    this.drawBoard();
    this.makeButton(width / 2 - 80, height - 48, 'Back', () => this.leave());
    if (this.isOwner) {
      this.makeButton(width / 2 + 80, height - 48, 'Repair', () => this.tryRepair());
      this.repairChipText = addText(this, width - 20, 20, 'Repair Items · –', {
        fontSize: '12px', color: '#f4a62a',
      }).setOrigin(1, 0);
      void this.refreshRepairBalance();
    }

    void this.hydrate();
    this.subscribe();
  }

  private async refreshRepairBalance() {
    try {
      this.repairBal = await this.client.repairBalance();
      this.repairChipText?.setText(`Repair Items · ${this.repairBal}`);
    } catch {
      this.repairChipText?.setText('Repair Items · ?');
    }
  }

  private drawBoard() {
    const { width, height } = this.scale;
    const available = Math.min(width - 40, height - 220);
    const tile = Math.floor(available / PLOT_WIDTH);
    const boardPx = tile * PLOT_WIDTH;
    const originX = (width - boardPx) / 2;
    const originY = 120;

    for (let y = 0; y < PLOT_HEIGHT; y++) {
      for (let x = 0; x < PLOT_WIDTH; x++) {
        const idx = y * PLOT_WIDTH + x;
        const rect = this.add
          .rectangle(originX + x * tile + tile / 2, originY + y * tile + tile / 2, tile - 2, tile - 2, 0x1e242f)
          .setStrokeStyle(1, 0x2a2e38);
        rect.setInteractive({ useHandCursor: this.isOwner });
        rect.on('pointerdown', () => this.onTileClick(x, y));
        this.tileRects[idx] = rect;

        const label = addText(this, rect.x, rect.y, '', {
          fontSize: `${Math.max(12, Math.floor(tile * 0.45))}px`,
          color: '#e8ecf1',
          fontStyle: 'bold',
        }).setOrigin(0.5);
        this.tileLabels[idx] = label;
      }
    }
  }

  private async hydrate() {
    try {
      const plot = await this.client.getPlot(this.tokenId);
      this.plotStatus = plot.status;
      this.applyStatusText();
      // If we're walking into an already-corrupted plot, show the banner too.
      if (this.plotStatus === PlotStatus.Corrupted) this.showCorruptionBanner();
      // Pull every cell to paint the current state. 64 calls — fine for MVP;
      // if it becomes a bottleneck, swap to an event backfill via queryFilter.
      for (let y = 0; y < PLOT_HEIGHT; y++) {
        for (let x = 0; x < PLOT_WIDTH; x++) {
          const c = await this.client.getCell(this.tokenId, x, y);
          if (c.state !== 0) {
            this.applyCell(x, y, c.state === 2, c.adjacency);
          }
        }
      }
    } catch (err) {
      console.error('[plot] hydrate failed', err);
      this.statusText?.setText(`Hydrate failed — ${errMsg(err)}`);
    }
  }

  private subscribe() {
    this.unsubRevealed = this.client.onCellRevealed(this.tokenId, (ev) => this.onRevealed(ev));
    this.unsubCleared = this.client.onPlotCleared(this.tokenId, (ev) => this.onCleared(ev));
    this.unsubCorrupted = this.client.onPlotCorrupted(this.tokenId, (ev) => this.onCorrupted(ev));
  }

  private onRevealed(ev: CellRevealedEvent) {
    this.pending.delete(ev.y * PLOT_WIDTH + ev.x);
    this.applyCell(ev.x, ev.y, ev.wasCore, ev.adjacency);
    audio.sfx(ev.wasCore ? 'core-triggered' : 'reveal-pop');
  }

  private onCleared(_ev: PlotClearedEvent) {
    this.plotStatus = PlotStatus.Cleared;
    this.applyStatusText();
    audio.sfx('win');
  }

  private onCorrupted(_ev: PlotCorruptedEvent) {
    this.plotStatus = PlotStatus.Corrupted;
    this.applyStatusText();
    audio.sfx('lose');
    this.showCorruptionBanner();
  }

  private showCorruptionBanner() {
    if (this.banner) { this.banner.destroy(); this.banner = undefined; }
    if (this.plotStatus !== PlotStatus.Corrupted) return;

    const { width } = this.scale;
    const container = this.add.container(width / 2, 160);
    const bg = this.add.rectangle(0, 0, 520, 80, 0x2a0d0d, 0.95)
      .setStrokeStyle(2, 0xff6b6b);
    const title = addText(this, 0, -16, 'PLOT CORRUPTED', {
      fontSize: '22px', color: '#ff6b6b', fontStyle: 'bold',
    }).setOrigin(0.5);
    const body = this.isOwner
      ? `Burn 1 Repair Item to regenerate the board — you have ${this.repairBal}.`
      : 'This plot is locked. Ask the owner or buy it as-is on the market.';
    const bodyText = addText(this, 0, 14, body, {
      fontSize: '12px', color: '#e8ecf1',
    }).setOrigin(0.5);
    container.add([bg, title, bodyText]);
    this.banner = container;

    // Pulse in, then hold. A fade-to-invisible would hide the critical CTA,
    // so we just animate the entry and leave the banner until the scene exits.
    container.setAlpha(0);
    container.setScale(0.92);
    this.tweens.add({
      targets: container,
      alpha: 1,
      scale: 1,
      duration: 380,
      ease: 'Back.easeOut',
    });
    void this.refreshRepairBalance();
  }

  private applyCell(x: number, y: number, isCore: boolean, adjacency: number) {
    const idx = y * PLOT_WIDTH + x;
    const rect = this.tileRects[idx];
    const label = this.tileLabels[idx];
    if (!rect || !label) return;

    this.board[idx] = { state: isCore ? 'core' : 'safe', adjacency };
    if (isCore) {
      rect.setFillStyle(0x5c1f1f);
      rect.setStrokeStyle(2, 0xff6b6b);
      label.setText('◆').setColor('#ff6b6b');
    } else {
      rect.setFillStyle(0x10151c);
      rect.setStrokeStyle(1, 0x1a2230);
      // Only border cells can leak — look up neighbor mines asynchronously
      // and augment the number once we have the answer.
      const isBorder = x === 0 || y === 0 || x === PLOT_WIDTH - 1 || y === PLOT_HEIGHT - 1;
      label.setText(adjacency > 0 ? String(adjacency) : '');
      label.setColor(adjacencyColor(adjacency));
      if (isBorder) {
        void this.augmentWithLeak(x, y, adjacency, label);
      }
    }
    rect.disableInteractive();
  }

  private async augmentWithLeak(
    x: number,
    y: number,
    baseAdjacency: number,
    label: Phaser.GameObjects.Text,
  ) {
    try {
      const leak = await computeNeighborLeak(this.client, this.plotX, this.plotY, x, y);
      if (leak.extraCores === 0 && leak.unknownNeighbors === 0) return;
      const shown = baseAdjacency + leak.extraCores;
      const suffix = leak.unknownNeighbors > 0 ? '?' : '';
      label.setText(shown > 0 ? `${shown}${suffix}` : (suffix || ''));
      if (leak.extraCores > 0) {
        // Tint the label warmer when neighbor mines contribute, so players
        // can tell a 3 with a leak apart from a 3 without.
        label.setColor('#ff9f6b');
      }
    } catch {
      // Leak lookup is best-effort; a transient RPC error just means the
      // player sees the base adjacency, which is still correct for their plot.
    }
  }

  private applyStatusText() {
    if (!this.statusText) return;
    switch (this.plotStatus) {
      case PlotStatus.Uncleared:
        this.statusText.setText(this.isOwner
          ? 'Reveal cells to solve the plot. 1 bomb = corruption.'
          : 'Uncleared plot · read-only');
        this.statusText.setColor('#aab0bf');
        break;
      case PlotStatus.Cleared:
        this.statusText.setText('PLOT CLEARED · Repair Item earned');
        this.statusText.setColor('#6eff9c');
        break;
      case PlotStatus.Corrupted:
        this.statusText.setText(this.isOwner
          ? 'CORRUPTED · Repair with a Repair Item or sell as-is'
          : 'CORRUPTED · this plot is locked');
        this.statusText.setColor('#ff6b6b');
        break;
    }
  }

  private async onTileClick(x: number, y: number) {
    if (!this.isOwner) return;
    if (this.plotStatus !== PlotStatus.Uncleared) return;
    const idx = y * PLOT_WIDTH + x;
    if (this.board[idx].state !== 'hidden') return;
    if (this.pending.has(idx)) return;

    this.pending.add(idx);
    const rect = this.tileRects[idx];
    rect?.setFillStyle(0x2a6df4, 0.4);
    this.statusText?.setText(`Submitting reveal (${x},${y})…`);
    try {
      await this.client.revealCell(this.tokenId, x, y);
      this.statusText?.setText(`Waiting on BITE decrypt for (${x},${y})…`);
    } catch (err) {
      console.error('[plot] reveal failed', err);
      this.pending.delete(idx);
      rect?.setFillStyle(0x1e242f);
      this.statusText?.setText(`Reveal failed — ${friendlyTxError(err)}`);
    }
  }

  private async tryRepair() {
    if (!this.isOwner) return;
    if (this.plotStatus !== PlotStatus.Corrupted) {
      this.statusText?.setText('Plot is not corrupted.');
      return;
    }
    try {
      const bal = await this.client.repairBalance();
      if (bal < 1) {
        this.statusText?.setText('No Repair Items — visit the marketplace to buy.');
        return;
      }
      const confirmed = window.confirm(
        'Burn 1 Repair Item to regenerate this plot? Cells will be re-hidden and remines randomized.',
      );
      if (!confirmed) return;
      this.statusText?.setText('Encrypting new layout…');
      const salt = Math.floor(Math.random() * 2 ** 30);
      const plot = await encryptPlot(SKALE_CHAIN.rpcUrl, CONTRACTS.plots, this.plotX, this.plotY, salt);
      this.statusText?.setText('Submitting repair tx…');
      await this.client.repairPlot(this.tokenId, plot.cipherCells);
      this.statusText?.setText('Repaired. Reloading…');
      this.scene.restart({
        client: this.client,
        tokenId: this.tokenId,
        plotX: this.plotX,
        plotY: this.plotY,
        owner: this.owner,
      });
    } catch (err) {
      console.error('[plot] repair failed', err);
      this.statusText?.setText(`Repair failed — ${friendlyTxError(err)}`);
    }
  }

  private leave() {
    this.unsubRevealed?.();
    this.unsubCleared?.();
    this.unsubCorrupted?.();
    this.scene.start('PlotMap');
  }

  private makeButton(x: number, y: number, label: string, onClick: () => void) {
    const bg = this.add.rectangle(x, y, 140, 36, 0x2a6df4).setStrokeStyle(2, 0x4f8bff);
    addText(this, x, y, label, { fontSize: '14px', color: '#ffffff' }).setOrigin(0.5);
    bg.setInteractive({ useHandCursor: true });
    bg.on('pointerover', () => bg.setFillStyle(0x3b7bff));
    bg.on('pointerout', () => bg.setFillStyle(0x2a6df4));
    bg.on('pointerdown', onClick);
  }
}

function short(addr: string): string {
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}


function adjacencyColor(n: number): string {
  // Classic minesweeper palette, tuned to the dark theme.
  switch (n) {
    case 1: return '#6eb4ff';
    case 2: return '#6eff9c';
    case 3: return '#ffd86e';
    case 4: return '#f4a62a';
    case 5: return '#ff9f6b';
    case 6: return '#ff6bb4';
    case 7: return '#c26bff';
    case 8: return '#ff6b6b';
    default: return '#aab0bf';
  }
}
