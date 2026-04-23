import * as Phaser from 'phaser';
import {
  createBitmapFont,
  FONT_TILE_NUMBERS,
  FONT_HUD,
  FONT_HUD_BOLD,
  HUD_CHARS,
} from '../ui/bitmapFont';
import { audio } from '../audio/manager';

export class PreloadScene extends Phaser.Scene {
  constructor() {
    super('Preload');
  }

  preload() {
    this.load.image('menu_bg', 'assets/cyber_bg.png');
    this.load.image('icon_lock_closed', 'assets/icons/lock-closed.png');
    this.load.image('portrait_init0', 'assets/portraits/init0.png');
    this.load.image('portrait_mc_boy', 'assets/portraits/mc_boy.png');
    this.load.image('portrait_mc_girl', 'assets/portraits/mc_girl.png');
    this.load.image('portrait_iris', 'assets/portraits/iris.png');
    this.load.image('portrait_trace', 'assets/portraits/trace.png');
    this.load.image('portrait_glitch', 'assets/portraits/glitch.png');
    this.load.image('portrait_proof', 'assets/portraits/proof.png');
    this.load.image('portrait_fork', 'assets/portraits/fork.png');
    this.load.image('portrait_patch', 'assets/portraits/patch.png');
    this.load.image('portrait_root', 'assets/portraits/root.png');
    this.load.image('portrait_engineer', 'assets/portraits/engineer.png');
    this.load.image('bg_iris', 'assets/backgrounds/iris.png');
    this.load.image('bg_trace', 'assets/backgrounds/trace.png');
    this.load.image('bg_glitch', 'assets/backgrounds/glitch.png');
    this.load.image('bg_proof', 'assets/backgrounds/proof.png');
    this.load.image('bg_fork', 'assets/backgrounds/fork.png');
    this.load.image('bg_patch', 'assets/backgrounds/patch.png');
    this.load.image('bg_root', 'assets/backgrounds/root.png');
    this.load.image('bg_engineer', 'assets/backgrounds/engineer.png');
    this.load.image('bg_narrator', 'assets/backgrounds/narrator.png');
    // INIT-0's Floor 0 intro reuses the menu cover art as its backdrop so the
    // tutorial feels continuous with the title screen the player just clicked
    // through. Same file as `menu_bg`, registered under a second key so the
    // VN's `bg_<id>` auto-derive picks it up.
    this.load.image('bg_init0', 'assets/cyber_bg.png');
    this.load.spritesheet('fx_nullcore', 'assets/sprites/nullcore.png', {
      frameWidth: 32,
      frameHeight: 32,
    });
    audio.preloadAll(this);
  }

  create() {
    // Bake bitmap fonts once, up-front. All scenes share the cache, so
    // generating them here removes per-scene setup cost.
    const fontStack = '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif';

    createBitmapFont(this, {
      key: FONT_TILE_NUMBERS,
      fontFamily: fontStack,
      fontSize: 44,
      color: '#ffffff',
      chars: '12345678',
      bold: true,
    });

    createBitmapFont(this, {
      key: FONT_HUD,
      fontFamily: fontStack,
      fontSize: 32,
      color: '#e8ecf1',
      chars: HUD_CHARS,
    });

    createBitmapFont(this, {
      key: FONT_HUD_BOLD,
      fontFamily: fontStack,
      fontSize: 32,
      color: '#ffffff',
      chars: HUD_CHARS,
      bold: true,
    });

    this.anims.create({
      key: 'nullcore_spin',
      frames: this.anims.generateFrameNumbers('fx_nullcore', { start: 0, end: 14 }),
      frameRate: 10,
      repeat: -1,
    });

    this.scene.start('Menu');
  }
}
