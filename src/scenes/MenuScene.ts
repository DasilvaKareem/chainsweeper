import * as Phaser from 'phaser';
import { addText } from '../ui/text';
import { audio } from '../audio/manager';

// Palette used by the floating-square ambient animation — cool Grid-blues with
// a warm accent to echo the player-one orange used elsewhere in the UI.
const FLOAT_COLORS = [0x6eb4ff, 0x4f8bff, 0x2a6df4, 0xf4a62a, 0x8fc9ff];
const FLOAT_COUNT = 22;

export class MenuScene extends Phaser.Scene {
  // Latched on SHUTDOWN so respawn callbacks don't add Game Objects to a dead
  // scene when the user clicks a menu button and we transition out.
  private shuttingDown = false;

  constructor() {
    super('Menu');
  }

  create() {
    audio.playBgm('menu-quiet-invitation');
    this.shuttingDown = false;
    const { width, height } = this.scale;
    const cx = width / 2;

    // Cyber background — cover-scale (crop to fit) rather than stretch, so the
    // image doesn't distort on arbitrary viewport ratios.
    if (this.textures.exists('menu_bg')) {
      const bg = this.add.image(cx, height / 2, 'menu_bg');
      const tex = bg.texture.getSourceImage() as HTMLImageElement;
      const scale = Math.max(width / tex.width, height / tex.height);
      bg.setScale(scale);
      // Lighter darkening than before so the menu art comes through brighter —
      // just enough to keep text legible on the busiest parts of the image.
      this.add.rectangle(cx, height / 2, width, height, 0x000000, 0.18);
    }

    // Floating ambient squares — staggered start times so they're not all
    // crossing the screen in phase.
    for (let i = 0; i < FLOAT_COUNT; i++) {
      const startDelay = Math.random() * 12000;
      this.time.delayedCall(startDelay, () => this.spawnFloatingSquare());
    }

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.shuttingDown = true;
    });

    addText(this, cx, height * 0.24, 'MachineSweep', {
      fontSize: '64px',
      color: '#e8ecf1',
    }).setOrigin(0.5);

    addText(this, cx, height * 0.24 + 54, 'SYSTEM TRIALS', {
      fontSize: '14px',
      color: '#6eb4ff',
      fontStyle: 'bold',
    }).setOrigin(0.5);

    this.makeButton(cx, height * 0.48, 'Arcade', () => {
      this.scene.start('SelectOperator');
    });
    this.makeButton(cx, height * 0.48 + 72, 'Multiplayer', () => {
      this.scene.start('MultiplayerHub');
    });

    addText(this, cx, height - 30, 'v0.1 · local prototype', {
      fontSize: '12px',
      color: '#4a5063',
    }).setOrigin(0.5);
  }

  private spawnFloatingSquare() {
    if (this.shuttingDown) return;
    const { width, height } = this.scale;
    const size = 6 + Math.random() * 16;
    const x = Math.random() * width;
    const yStart = height + 30;
    const color = FLOAT_COLORS[Math.floor(Math.random() * FLOAT_COLORS.length)];
    const alphaTarget = 0.15 + Math.random() * 0.3;
    const duration = 14000 + Math.random() * 10000;
    const drift = (Math.random() - 0.5) * 140;

    const sq = this.add.rectangle(x, yStart, size, size, color, 0)
      .setStrokeStyle(1, color, 0.9);

    // Position + rotation tween spans the whole lifespan; on complete, the
    // square is destroyed and a new one respawns to take its slot.
    this.tweens.add({
      targets: sq,
      y: -30,
      x: x + drift,
      angle: Math.random() * 40 - 20,
      duration,
      ease: 'Sine.easeInOut',
      onComplete: () => {
        sq.destroy();
        if (!this.shuttingDown) this.spawnFloatingSquare();
      },
    });

    // Alpha ping-pongs across the travel: fades in, holds, fades out. yoyo
    // halves the duration so the full cycle matches the position tween.
    this.tweens.add({
      targets: sq,
      alpha: alphaTarget,
      yoyo: true,
      duration: duration / 2,
      ease: 'Sine.easeInOut',
    });
  }

  private makeButton(x: number, y: number, label: string, onClick: () => void) {
    const btn = this.add.container(x, y);
    const bg = this.add.rectangle(0, 0, 240, 56, 0x2a6df4).setStrokeStyle(2, 0x4f8bff);
    const text = addText(this, 0, 0, label, {
      fontSize: '20px',
      color: '#ffffff',
    }).setOrigin(0.5);
    btn.add([bg, text]);
    bg.setInteractive({ useHandCursor: true });
    bg.on('pointerover', () => bg.setFillStyle(0x3b7bff));
    bg.on('pointerout', () => bg.setFillStyle(0x2a6df4));
    bg.on('pointerdown', onClick);
    return btn;
  }
}
