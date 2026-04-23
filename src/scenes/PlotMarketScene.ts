import * as Phaser from 'phaser';
import { formatEther, parseEther } from 'ethers';
import { addText } from '../ui/text';
import { audio } from '../audio/manager';
import {
  type PlotClient,
  type PlotMintedEvent,
  type PlotListing,
  PlotStatus,
  type ChainPlot,
} from '../chain';

interface PlotMarketSceneData {
  client: PlotClient;
}

interface Row {
  ev: PlotMintedEvent;
  plot: ChainPlot;
  listing: PlotListing;
  isOwner: boolean;
}

/**
 * Plot ownership + marketplace dashboard. Three concerns stacked:
 *   1. Repair Item inventory + buy-from-protocol.
 *   2. Your plots: quick-list / unlist / play.
 *   3. Others' listings: inspect / buy.
 * List-mode UX — visual marketplace is a phase-4 concern.
 */
export class PlotMarketScene extends Phaser.Scene {
  private client!: PlotClient;
  private statusText?: Phaser.GameObjects.Text;
  private repairText?: Phaser.GameObjects.Text;
  private listContainer?: Phaser.GameObjects.Container;

  constructor() {
    super('PlotMarket');
  }

  init(data: PlotMarketSceneData) {
    this.client = data.client;
  }

  create() {
    audio.playBgm('menu-quiet-invitation');
    const { width, height } = this.scale;
    const cx = width / 2;

    this.add.rectangle(cx, height / 2, width, height, 0x0b0d12);

    addText(this, cx, 44, 'Plot Marketplace', {
      fontSize: '28px', color: '#e8ecf1',
    }).setOrigin(0.5);

    this.statusText = addText(this, cx, 78, '', { fontSize: '13px', color: '#aab0bf' }).setOrigin(0.5);

    this.repairText = addText(this, cx - 200, 110, 'Repair Items: –', {
      fontSize: '14px', color: '#f4a62a',
    }).setOrigin(0, 0.5);

    this.makeButton(cx + 40, 110, 'Buy 1 Repair', () => this.buyRepair());
    this.makeButton(cx + 190, 110, 'Back', () => this.scene.start('PlotMap'));
    this.makeButton(cx - 340, 110, 'Approve Market', () => this.approveMarket());

    this.listContainer = this.add.container(0, 160);
    void this.refresh();
  }

  private async refresh() {
    this.statusText?.setText('Loading…');
    try {
      const [bal, minted] = await Promise.all([
        this.client.repairBalance(),
        this.client.getAllMintedPlots(),
      ]);
      this.repairText?.setText(`Repair Items: ${bal}`);

      // Hydrate each plot's chain state + listing in parallel.
      const rows: Row[] = await Promise.all(
        minted.map(async (ev): Promise<Row> => {
          const [plot, listing] = await Promise.all([
            this.client.getPlot(ev.tokenId),
            this.client.getListing(ev.tokenId),
          ]);
          return {
            ev,
            plot,
            listing,
            isOwner: ev.owner.toLowerCase() === this.client.address.toLowerCase(),
          };
        }),
      );
      this.renderRows(rows);
      this.statusText?.setText(`${rows.length} plots · ${rows.filter((r) => r.listing.active).length} listed`);
    } catch (err) {
      this.statusText?.setText(`Load failed: ${errMsg(err)}`);
    }
  }

  private renderRows(rows: Row[]) {
    if (!this.listContainer) return;
    this.listContainer.removeAll(true);
    const cx = this.scale.width / 2;

    // Sort: my plots first, then active listings, then the rest.
    rows.sort((a, b) => {
      if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
      if (a.listing.active !== b.listing.active) return a.listing.active ? -1 : 1;
      return Number(a.ev.tokenId - b.ev.tokenId);
    });

    const rowH = 44;
    rows.forEach((r, i) => {
      const y = i * rowH;
      const bg = this.add.rectangle(
        cx, y + 16,
        Math.min(760, this.scale.width - 40),
        rowH - 6,
        r.isOwner ? 0x1e3a5f : 0x14171e,
      ).setStrokeStyle(1, r.listing.active ? 0xf4a62a : 0x2a2e38);
      const statusBadge = plotStatusLabel(r.plot.status);
      const listingBadge = r.listing.active ? ` · LISTED ${formatEther(r.listing.price)} ETH` : '';
      const label = addText(
        this, cx - 360, y + 16,
        `(${r.plot.x},${r.plot.y})  ${statusBadge}${listingBadge}  ·  ${short(r.ev.owner)}`,
        { fontSize: '13px', color: '#e8ecf1' },
      ).setOrigin(0, 0.5);

      this.listContainer!.add([bg, label]);

      // Per-row actions. Keep to a max of 2 buttons to fit the row.
      const actions = this.actionsFor(r);
      actions.forEach((a, ai) => {
        const btnX = cx + 200 + ai * 110;
        const btnBg = this.add.rectangle(btnX, y + 16, 100, 28, 0x2a6df4).setStrokeStyle(1, 0x4f8bff);
        const btnTxt = addText(this, btnX, y + 16, a.label, { fontSize: '12px', color: '#ffffff' })
          .setOrigin(0.5);
        btnBg.setInteractive({ useHandCursor: true });
        btnBg.on('pointerdown', a.onClick);
        this.listContainer!.add([btnBg, btnTxt]);
      });
    });
  }

  private actionsFor(r: Row): Array<{ label: string; onClick: () => void }> {
    const out: Array<{ label: string; onClick: () => void }> = [];
    if (r.isOwner) {
      if (r.listing.active) {
        out.push({ label: 'Unlist', onClick: () => this.cancel(r) });
      } else {
        if (r.plot.status !== PlotStatus.Cleared) {
          // Let owner play/repair; marketplace can wait.
          out.push({ label: 'Play', onClick: () => this.openPlot(r) });
        }
        out.push({ label: 'List', onClick: () => this.list(r) });
      }
    } else {
      if (r.listing.active) {
        out.push({
          label: `Buy ${formatEther(r.listing.price)}`,
          onClick: () => this.buy(r),
        });
      } else {
        out.push({ label: 'Inspect', onClick: () => this.openPlot(r) });
      }
    }
    return out;
  }

  private async buyRepair() {
    try {
      this.statusText?.setText('Buying Repair Item…');
      await this.client.buyRepair(1);
      this.statusText?.setText('Bought. Refreshing…');
      await this.refresh();
    } catch (err) {
      this.statusText?.setText(`Buy failed: ${errMsg(err)}`);
    }
  }

  private async approveMarket() {
    try {
      const already = await this.client.isMarketplaceApproved();
      if (already) {
        this.statusText?.setText('Marketplace already approved.');
        return;
      }
      this.statusText?.setText('Approving marketplace…');
      await this.client.approveMarketplace();
      this.statusText?.setText('Approved. You can list now.');
    } catch (err) {
      this.statusText?.setText(`Approve failed: ${errMsg(err)}`);
    }
  }

  private async list(r: Row) {
    try {
      const already = await this.client.isMarketplaceApproved();
      if (!already) {
        this.statusText?.setText('Approve marketplace first (top-left button).');
        return;
      }
      const raw = window.prompt(`List plot (${r.plot.x},${r.plot.y}) for how much (ETH)?`, '0.01');
      if (!raw) return;
      const priceWei = parseEther(raw);
      this.statusText?.setText('Listing…');
      await this.client.listPlot(r.ev.tokenId, priceWei);
      this.statusText?.setText('Listed.');
      await this.refresh();
    } catch (err) {
      this.statusText?.setText(`List failed: ${errMsg(err)}`);
    }
  }

  private async cancel(r: Row) {
    try {
      this.statusText?.setText('Cancelling listing…');
      await this.client.cancelListing(r.ev.tokenId);
      this.statusText?.setText('Cancelled.');
      await this.refresh();
    } catch (err) {
      this.statusText?.setText(`Cancel failed: ${errMsg(err)}`);
    }
  }

  private async buy(r: Row) {
    try {
      this.statusText?.setText('Buying plot…');
      await this.client.buyListing(r.ev.tokenId);
      this.statusText?.setText('Bought.');
      await this.refresh();
    } catch (err) {
      this.statusText?.setText(`Buy failed: ${errMsg(err)}`);
    }
  }

  private openPlot(r: Row) {
    this.scene.start('Plot', {
      client: this.client,
      tokenId: r.ev.tokenId,
      plotX: r.plot.x,
      plotY: r.plot.y,
      owner: r.ev.owner,
    });
  }

  private makeButton(x: number, y: number, label: string, onClick: () => void) {
    const bg = this.add.rectangle(x, y, 140, 30, 0x2a6df4).setStrokeStyle(1, 0x4f8bff);
    addText(this, x, y, label, { fontSize: '13px', color: '#ffffff' }).setOrigin(0.5);
    bg.setInteractive({ useHandCursor: true });
    bg.on('pointerdown', onClick);
  }
}

function plotStatusLabel(s: PlotStatus): string {
  switch (s) {
    case PlotStatus.Uncleared: return 'UNCLEARED';
    case PlotStatus.Cleared:   return 'CLEARED';
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
