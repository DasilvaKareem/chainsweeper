import * as Phaser from 'phaser';
import { DEFAULT_RULES, type MatchConfig, type Rules } from '../state/gameState';
import { addText } from '../ui/text';
import { audio } from '../audio/manager';

interface Preset {
  label: string;
  width: number;
  height: number;
  coreDensity: number;
}

const PRESETS: Preset[] = [
  { label: 'Small  8×8',   width: 8,  height: 8,  coreDensity: 0.14 },
  { label: 'Medium 10×10', width: 10, height: 10, coreDensity: 0.15 },
  { label: 'Large  14×12', width: 14, height: 12, coreDensity: 0.17 },
];

const NARROW_BREAKPOINT = 720;

export class LobbyScene extends Phaser.Scene {
  private presetIdx = 1;
  private players = 2;
  private turnSeconds = 0;
  private rules: Rules = { ...DEFAULT_RULES };

  constructor() {
    super('Lobby');
  }

  create() {
    audio.playBgm('menu-quiet-invitation');
    const { width, height } = this.scale;
    const narrow = width < NARROW_BREAKPOINT;
    const cx = width / 2;

    addText(this, cx, narrow ? 48 : 70, 'Match Settings', {
      fontSize: narrow ? '26px' : '38px',
      color: '#e8ecf1',
    }).setOrigin(0.5);

    const lineH = 54;
    const ruleChipW = Math.min(320, width - 40);

    if (narrow) {
      // Single-column stack.
      const colX = 20;
      let y = 96;
      y = this.renderBoardRow(colX, y);
      y += 8;
      y = this.renderPlayersRow(colX, y);
      y += 8;
      y = this.renderTimerRow(colX, y);
      y += 14;
      y = this.renderRuleToggle(colX, y, 'Gentleman',
        () => this.rules.gentleman,
        (v) => { this.rules.gentleman = v; }, ruleChipW);
      y = this.renderRuleToggle(colX, y, `Sore Loser (≥${this.rules.soreLoserLead})`,
        () => this.rules.soreLoser,
        (v) => { this.rules.soreLoser = v; }, ruleChipW);
      y = this.renderRuleToggle(colX, y, `Limited Bomb (≤${this.rules.limitedBombThreshold} safe)`,
        () => this.rules.limitedBomb,
        (v) => { this.rules.limitedBomb = v; }, ruleChipW);
    } else {
      // Two-column layout (desktop).
      const leftX = cx - 240;
      const rightX = cx + 20;
      let ly = 150;
      ly = this.renderBoardRow(leftX, ly);
      ly += 10;
      ly = this.renderPlayersRow(leftX, ly);
      ly += 10;
      ly = this.renderTimerRow(leftX, ly);

      let ry = 150;
      ry = this.renderRuleToggle(rightX, ry, 'Gentleman',
        () => this.rules.gentleman,
        (v) => { this.rules.gentleman = v; }, 320);
      ry += lineH - 42;
      ry = this.renderRuleToggle(rightX, ry, `Sore Loser (≥${this.rules.soreLoserLead})`,
        () => this.rules.soreLoser,
        (v) => { this.rules.soreLoser = v; }, 320);
      ry += lineH - 42;
      ry = this.renderRuleToggle(rightX, ry, `Limited Bomb (≤${this.rules.limitedBombThreshold} safe)`,
        () => this.rules.limitedBomb,
        (v) => { this.rules.limitedBomb = v; }, 320);
    }

    // Footer buttons — adapt to width.
    const footerY = height - (narrow ? 48 : 80);
    const btnW = Math.min(220, (width - 60) / 2);
    const innerGap = narrow ? 12 : 40;
    const backCx = cx - btnW / 2 - innerGap / 2;
    const startCx = cx + btnW / 2 + innerGap / 2;
    this.makeButton(backCx, footerY, 'Back', 0x3a3f55, btnW, () => this.scene.start('Menu'));
    this.makeButton(startCx, footerY, 'Start Match', 0x2a6df4, btnW, () => this.startMatch());

    this.scale.on('resize', this.handleResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off('resize', this.handleResize, this);
    });
  }

  private handleResize() {
    // Cheap approach: the scene already restarts on every toggle and its
    // state is preserved in class fields, so just restart to relayout.
    this.scene.restart();
  }

  private renderBoardRow(x: number, y: number): number {
    addText(this, x, y, 'Board', { fontSize: '14px', color: '#7c8497' });
    const chipY = y + 26;
    let cx = x;
    PRESETS.forEach((p, i) => {
      const chip = this.makeChip(cx, chipY, p.label, () => this.presetIdx === i, () => {
        this.presetIdx = i;
        this.scene.restart();
      });
      cx += chip.width + 10;
    });
    return chipY + 32;
  }

  private renderPlayersRow(x: number, y: number): number {
    addText(this, x, y, 'Players', { fontSize: '14px', color: '#7c8497' });
    const chipY = y + 26;
    let cx = x;
    for (const n of [2, 3, 4]) {
      const chip = this.makeChip(cx, chipY, `${n}`, () => this.players === n, () => {
        this.players = n;
        this.scene.restart();
      });
      cx += chip.width + 10;
    }
    return chipY + 32;
  }

  private renderTimerRow(x: number, y: number): number {
    addText(this, x, y, 'Turn timer', { fontSize: '14px', color: '#7c8497' });
    const chipY = y + 26;
    let cx = x;
    for (const t of [0, 10, 20, 30]) {
      const label = t === 0 ? 'Off' : `${t}s`;
      const chip = this.makeChip(cx, chipY, label, () => this.turnSeconds === t, () => {
        this.turnSeconds = t;
        this.scene.restart();
      });
      cx += chip.width + 10;
    }
    return chipY + 32;
  }

  private renderRuleToggle(x: number, y: number, label: string, get: () => boolean, set: (v: boolean) => void, chipW: number): number {
    const on = get();
    const chip = this.makeChip(x, y, label, () => on, () => {
      set(!on);
      this.scene.restart();
    }, chipW);
    return y + chip.height + 10;
  }

  private makeChip(
    x: number,
    y: number,
    label: string,
    isActive: () => boolean,
    onClick: () => void,
    minWidth = 0,
  ) {
    const active = isActive();
    const padX = 14;
    const tmp = addText(this, 0, 0, label, { fontSize: '15px' });
    const w = Math.max(minWidth, tmp.width + padX * 2);
    const h = 32;
    tmp.destroy();

    const container = this.add.container(x, y);
    const bg = this.add.rectangle(0, 0, w, h, active ? 0x2a6df4 : 0x1c2030)
      .setStrokeStyle(1, active ? 0x4f8bff : 0x475172)
      .setOrigin(0, 0);
    const text = addText(this, w / 2, h / 2, label, {
      fontSize: '15px',
      color: active ? '#ffffff' : '#c0c7d6',
    }).setOrigin(0.5);
    container.add([bg, text]);
    bg.setInteractive({ useHandCursor: true });
    bg.on('pointerover', () => !active && bg.setFillStyle(0x252b3f));
    bg.on('pointerout', () => !active && bg.setFillStyle(0x1c2030));
    bg.on('pointerdown', onClick);
    return { width: w, height: h };
  }

  private makeButton(x: number, y: number, label: string, fill: number, width: number, onClick: () => void) {
    const bg = this.add.rectangle(x, y, width, 48, fill).setStrokeStyle(2, 0x4f8bff);
    addText(this, x, y, label, {
      fontSize: '18px',
      color: '#ffffff',
    }).setOrigin(0.5);
    bg.setInteractive({ useHandCursor: true });
    bg.on('pointerdown', onClick);
  }

  private startMatch() {
    const preset = PRESETS[this.presetIdx];
    const coreCount = Math.max(1, Math.round(preset.width * preset.height * preset.coreDensity));
    const config: MatchConfig = {
      width: preset.width,
      height: preset.height,
      coreCount,
      players: this.players,
      seed: Math.floor(Math.random() * 0xffffffff),
      rules: { ...this.rules },
      turnSeconds: this.turnSeconds,
    };
    this.scene.start('Match', { config });
  }
}
