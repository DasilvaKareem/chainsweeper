import * as Phaser from 'phaser';
import { audio } from '../audio/manager';

export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  create() {
    audio.init(this.game);
    this.scene.start('Preload');
  }
}
