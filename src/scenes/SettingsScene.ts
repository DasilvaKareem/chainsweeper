import * as Phaser from 'phaser';
import { addText } from '../ui/text';
import { audio } from '../audio/manager';

// Simple settings screen — three volume sliders (Master / Music / SFX) and a
// Back button. Values write through to the AudioManager immediately, which
// persists to localStorage, so settings survive reloads. BGM is live so users
// hear music changes as they drag.

type GetGain = () => number;
type SetGain = (v: number) => void;

interface Slider {
  track: Phaser.GameObjects.Rectangle;
  fill: Phaser.GameObjects.Rectangle;
  thumb: Phaser.GameObjects.Rectangle;
  valueLabel: Phaser.GameObjects.Text;
  getValue: GetGain;
  setValue: SetGain;
  trackX: number;
  trackY: number;
  trackW: number;
}

export class SettingsScene extends Phaser.Scene {
  private sliders: Slider[] = [];
  private dragging: Slider | null = null;

  constructor() {
    super('Settings');
  }

  create() {
    const { width, height } = this.scale;
    const cx = width / 2;
    const narrow = width < 620;

    this.cameras.main.setBackgroundColor('#07090d');

    addText(this, cx, narrow ? 48 : 80, 'Settings', {
      fontSize: narrow ? '32px' : '42px',
      color: '#e8ecf1',
      fontStyle: 'bold',
    }).setOrigin(0.5);
    addText(this, cx, (narrow ? 48 : 80) + (narrow ? 36 : 46), 'AUDIO', {
      fontSize: '12px',
      color: '#6eb4ff',
      fontStyle: 'bold',
    }).setOrigin(0.5);

    const rowGap = narrow ? 86 : 96;
    const firstY = narrow ? 180 : 240;
    const trackW = Math.min(width - 96, 420);
    const trackX = cx - trackW / 2;

    this.sliders.push(this.makeSlider({
      x: trackX, y: firstY, w: trackW,
      label: 'Master',
      getValue: () => audio.getMasterGain(),
      setValue: (v) => audio.setMasterGain(v),
    }));
    this.sliders.push(this.makeSlider({
      x: trackX, y: firstY + rowGap, w: trackW,
      label: 'Music',
      getValue: () => audio.getBgmGain(),
      setValue: (v) => audio.setBgmGain(v),
    }));
    this.sliders.push(this.makeSlider({
      x: trackX, y: firstY + rowGap * 2, w: trackW,
      label: 'SFX',
      getValue: () => audio.getSfxGain(),
      setValue: (v) => audio.setSfxGain(v),
    }));

    // Back button at the bottom — centered, matching the menu's button style.
    const backY = height - (narrow ? 72 : 100);
    const backBg = this.add.rectangle(cx, backY, narrow ? 200 : 240, narrow ? 48 : 52, 0x2a6df4)
      .setStrokeStyle(2, 0x4f8bff)
      .setInteractive({ useHandCursor: true });
    addText(this, cx, backY, 'Back', {
      fontSize: '18px',
      color: '#ffffff',
    }).setOrigin(0.5);
    backBg.on('pointerover', () => backBg.setFillStyle(0x3b7bff));
    backBg.on('pointerout', () => backBg.setFillStyle(0x2a6df4));
    backBg.on('pointerup', () => this.scene.start('Menu'));

    // Global pointer listeners — sliders only listen on their own thumb/track
    // for pointerdown, but movement + release must be scene-level so dragging
    // off the thumb still updates (otherwise the thumb "falls off your finger"
    // the moment you drag past its edge).
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (!this.dragging) return;
      this.updateSliderFromPointer(this.dragging, pointer.x);
    });
    this.input.on('pointerup', () => { this.dragging = null; });
    this.input.on('pointerupoutside', () => { this.dragging = null; });

    this.input.keyboard?.on('keydown-ESC', () => this.scene.start('Menu'));
  }

  private makeSlider(opts: {
    x: number; y: number; w: number;
    label: string;
    getValue: GetGain;
    setValue: SetGain;
  }): Slider {
    const { x, y, w } = opts;
    const labelY = y - 26;

    addText(this, x, labelY, opts.label, {
      fontSize: '14px',
      color: '#c8cfdc',
      fontStyle: 'bold',
    });

    const valueLabel = addText(this, x + w, labelY, '', {
      fontSize: '14px',
      color: '#6eb4ff',
      fontStyle: 'bold',
    }).setOrigin(1, 0);

    const trackH = 8;
    const track = this.add.rectangle(x, y, w, trackH, 0x1c2030)
      .setOrigin(0, 0.5)
      .setStrokeStyle(1, 0x2a3a5a);

    const fill = this.add.rectangle(x, y, 0, trackH, 0x2a6df4)
      .setOrigin(0, 0.5);

    const thumbSize = 28;
    const thumb = this.add.rectangle(x, y, thumbSize, thumbSize, 0x4f8bff)
      .setStrokeStyle(2, 0xffffff)
      .setInteractive({ useHandCursor: true, draggable: false });

    const slider: Slider = {
      track, fill, thumb, valueLabel,
      getValue: opts.getValue, setValue: opts.setValue,
      trackX: x, trackY: y, trackW: w,
    };

    // Expanded hit area on the track so the user can click anywhere on the bar
    // to jump the thumb, not just on the thumb itself.
    track.setInteractive({
      useHandCursor: true,
      hitArea: new Phaser.Geom.Rectangle(0, -20, w, 40),
      hitAreaCallback: Phaser.Geom.Rectangle.Contains,
    });
    track.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      this.dragging = slider;
      this.updateSliderFromPointer(slider, pointer.x);
    });
    thumb.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      this.dragging = slider;
      this.updateSliderFromPointer(slider, pointer.x);
    });

    this.renderSlider(slider);
    return slider;
  }

  private updateSliderFromPointer(slider: Slider, pointerX: number): void {
    const ratio = Phaser.Math.Clamp((pointerX - slider.trackX) / slider.trackW, 0, 1);
    slider.setValue(ratio);
    this.renderSlider(slider);
  }

  private renderSlider(slider: Slider): void {
    const v = slider.getValue();
    const x = slider.trackX + slider.trackW * v;
    slider.thumb.setPosition(x, slider.trackY);
    slider.fill.width = slider.trackW * v;
    slider.valueLabel.setText(`${Math.round(v * 100)}%`);
  }
}
