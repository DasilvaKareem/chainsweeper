import * as Phaser from 'phaser';
import { addText } from '../ui/text';
import { audio } from '../audio/manager';

export class ResultScene extends Phaser.Scene {
  constructor() {
    super('Result');
  }

  create(data: { scores: number[]; winner: number | null }) {
    audio.playBgm('menu-quiet-invitation');
    const { width, height } = this.scale;
    const cx = width / 2;

    const title = data.winner === null ? 'Draw' : `Player ${data.winner + 1} wins`;
    addText(this, cx, height * 0.3, title, {
      fontSize: '56px',
      color: '#e8ecf1',
    }).setOrigin(0.5);

    const scoreLine = data.scores.map((s, i) => `P${i + 1}: ${s}`).join('    ');
    addText(this, cx, height * 0.3 + 70, scoreLine, {
      fontSize: '22px',
      color: '#7c8497',
    }).setOrigin(0.5);

    const btn = this.add.rectangle(cx, height * 0.6, 220, 52, 0x2a6df4).setStrokeStyle(2, 0x4f8bff);
    addText(this, cx, height * 0.6, 'Play Again', {
      fontSize: '20px',
      color: '#ffffff',
    }).setOrigin(0.5);
    btn.setInteractive({ useHandCursor: true });
    btn.on('pointerover', () => btn.setFillStyle(0x3b7bff));
    btn.on('pointerout', () => btn.setFillStyle(0x2a6df4));
    btn.on('pointerdown', () => this.scene.start('Menu'));
  }
}
