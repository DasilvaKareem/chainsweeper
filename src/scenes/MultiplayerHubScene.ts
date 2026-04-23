import * as Phaser from 'phaser';
import { addText } from '../ui/text';
import { audio } from '../audio/manager';

/**
 * Multiplayer hub. Top-level menu only distinguishes single-player (Arcade)
 * from multiplayer; everything multi-seat lives here — local hot-seat, online
 * match, and Territories (infinite-grid plot NFTs).
 */
export class MultiplayerHubScene extends Phaser.Scene {
  constructor() {
    super('MultiplayerHub');
  }

  create() {
    audio.playBgm('menu-quiet-invitation');
    const { width, height } = this.scale;
    const cx = width / 2;

    addText(this, cx, height * 0.22, 'Multiplayer', {
      fontSize: '48px', color: '#e8ecf1',
    }).setOrigin(0.5);

    addText(this, cx, height * 0.22 + 42, 'PICK YOUR ARENA', {
      fontSize: '13px', color: '#6eb4ff', fontStyle: 'bold',
    }).setOrigin(0.5);

    this.makeButton(cx, height * 0.45, 'Play Local',
      'Hot-seat on one device · 2–4 players',
      () => this.scene.start('Lobby'));
    this.makeButton(cx, height * 0.45 + 96, 'Online Match',
      'Room code · BITE-encrypted boards · optional ranked',
      () => this.scene.start('OnlineLobby'));
    this.makeButton(cx, height * 0.45 + 192, 'Territories',
      'Infinite grid · buy plot NFTs · survive the cores',
      () => this.scene.start('PlotMap'));

    this.makeBackButton(cx, height - 60, () => this.scene.start('Menu'));
  }

  private makeButton(x: number, y: number, label: string, sub: string, onClick: () => void) {
    const btn = this.add.container(x, y);
    const bg = this.add.rectangle(0, 0, 320, 72, 0x2a6df4).setStrokeStyle(2, 0x4f8bff);
    const title = addText(this, 0, -10, label, { fontSize: '22px', color: '#ffffff' }).setOrigin(0.5);
    const subtitle = addText(this, 0, 16, sub, { fontSize: '11px', color: '#d0dcff' }).setOrigin(0.5);
    btn.add([bg, title, subtitle]);
    bg.setInteractive({ useHandCursor: true });
    bg.on('pointerover', () => bg.setFillStyle(0x3b7bff));
    bg.on('pointerout', () => bg.setFillStyle(0x2a6df4));
    bg.on('pointerdown', onClick);
  }

  private makeBackButton(x: number, y: number, onClick: () => void) {
    const bg = this.add.rectangle(x, y, 140, 36, 0x14171e).setStrokeStyle(1, 0x2a2e38);
    addText(this, x, y, 'Back', { fontSize: '14px', color: '#aab0bf' }).setOrigin(0.5);
    bg.setInteractive({ useHandCursor: true });
    bg.on('pointerdown', onClick);
  }
}
