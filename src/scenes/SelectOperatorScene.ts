import * as Phaser from 'phaser';
import { addText } from '../ui/text';
import { audio } from '../audio/manager';
import { playerState, MC_NAMES, type McKey } from '../state/player';

// Character-select screen shown before an Arcade run starts. Picks between
// two MC portrait variants; the choice is stored on `playerState` and read by
// DialogueScene / VNScene to render the MC portrait on the left side of every
// champion cutscene. Click a portrait → enter the run.

interface Option {
  key: McKey;
  label: string;
  sub: string;
}

const OPTIONS: Option[] = [
  { key: 'mc_boy',  label: MC_NAMES.mc_boy.toUpperCase(),  sub: 'OPERATOR · M' },
  { key: 'mc_girl', label: MC_NAMES.mc_girl.toUpperCase(), sub: 'OPERATOR · F' },
];

export class SelectOperatorScene extends Phaser.Scene {
  // Lockout after mount — blocks a stale pointerup from the previous scene's
  // button click from auto-confirming a card before the player has actually
  // interacted with this screen.
  private canActAt = 0;

  constructor() {
    super('SelectOperator');
  }

  create() {
    audio.playBgm('menu-quiet-invitation');
    this.canActAt = this.time.now + 500;
    const { width, height } = this.scale;
    const cx = width / 2;

    // Reuse the menu background art so the transition from Menu feels
    // continuous. Slightly darker overlay than MenuScene to focus on the pick.
    if (this.textures.exists('menu_bg')) {
      const bg = this.add.image(cx, height / 2, 'menu_bg');
      const tex = bg.texture.getSourceImage() as HTMLImageElement;
      const scale = Math.max(width / tex.width, height / tex.height);
      bg.setScale(scale);
      this.add.rectangle(cx, height / 2, width, height, 0x000000, 0.35);
    }

    addText(this, cx, height * 0.12, 'Select Your Operator', {
      fontSize: '40px',
      color: '#e8ecf1',
    }).setOrigin(0.5);

    addText(this, cx, height * 0.12 + 44, 'THE GRID WAITS', {
      fontSize: '12px',
      color: '#6eb4ff',
      fontStyle: 'bold',
    }).setOrigin(0.5);

    // Two-column portrait picker. Keep each column narrower than half-width
    // so the text labels don't collide when the viewport shrinks.
    const cardGap = 32;
    const cardW = Math.min(320, (width - cardGap - 80) / 2);
    const cardH = Math.min(560, height * 0.62);
    const cy = height * 0.55;
    const leftX  = cx - cardGap / 2 - cardW / 2;
    const rightX = cx + cardGap / 2 + cardW / 2;

    this.buildCard(leftX,  cy, cardW, cardH, OPTIONS[0]);
    this.buildCard(rightX, cy, cardW, cardH, OPTIONS[1]);

    addText(this, cx, height - 28, 'Click to confirm', {
      fontSize: '12px',
      color: '#4a5063',
    }).setOrigin(0.5);

    this.buildBackButton(24, 24);
  }

  private buildBackButton(x: number, y: number) {
    const label = addText(this, x, y, '← BACK', {
      fontSize: '14px',
      color: '#aab0bf',
      fontStyle: 'bold',
    }).setOrigin(0, 0);
    label.setInteractive({ useHandCursor: true });
    label.on('pointerover', () => label.setColor('#e8ecf1'));
    label.on('pointerout',  () => label.setColor('#aab0bf'));
    // Same canActAt guard as the cards — prevents a stale release from
    // MenuScene's button from instantly bouncing the player back.
    label.on('pointerdown', () => {
      if (this.time.now < this.canActAt) return;
      this.scene.start('Menu');
    });
  }

  private buildCard(x: number, y: number, w: number, h: number, opt: Option) {
    const portraitKey = `portrait_${opt.key}`;
    const frame = this.add.rectangle(x, y, w, h, 0x12151f, 0.72)
      .setStrokeStyle(2, 0x2a3a5a);

    // Scale portrait to fit the card's interior, preserving aspect ratio.
    if (this.textures.exists(portraitKey)) {
      const tex = this.textures.get(portraitKey).getSourceImage() as HTMLImageElement;
      const padY = 68;   // leave room for name + sub-label below
      const availH = h - padY;
      const availW = w - 40;
      const scale = Math.min(availW / tex.width, availH / tex.height);
      const img = this.add.image(x, y - 24, portraitKey).setScale(scale).setAlpha(0.95);
      // Subtle idle breathing so each option doesn't sit like a flat sprite.
      this.tweens.add({
        targets: img,
        scaleX: scale * 1.015,
        scaleY: scale * 1.015,
        yoyo: true,
        repeat: -1,
        duration: 2600,
        ease: 'Sine.easeInOut',
      });
    }

    addText(this, x, y + h / 2 - 42, opt.label, {
      fontSize: '22px',
      color: '#e8ecf1',
      fontStyle: 'bold',
    }).setOrigin(0.5);
    addText(this, x, y + h / 2 - 18, opt.sub, {
      fontSize: '11px',
      color: '#6eb4ff',
      fontStyle: 'bold',
    }).setOrigin(0.5);

    frame.setInteractive({ useHandCursor: true });
    frame.on('pointerover', () => frame.setStrokeStyle(2, 0x4f8bff).setFillStyle(0x1a1f2e, 0.8));
    frame.on('pointerout',  () => frame.setStrokeStyle(2, 0x2a3a5a).setFillStyle(0x12151f, 0.72));
    // pointerdown (not pointerup) so a stale release from the previous scene
    // can't auto-select a card. Guarded by canActAt for the same reason.
    frame.on('pointerdown', () => {
      if (this.time.now < this.canActAt) return;
      this.confirm(opt.key);
    });
  }

  private confirm(key: McKey) {
    playerState.select(key);
    this.scene.start('ArcadeRun', { restart: true });
  }
}
