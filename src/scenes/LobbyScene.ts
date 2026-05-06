import * as Phaser from 'phaser';
import { DEFAULT_RULES, type MatchConfig, type Rules } from '../state/gameState';
import { addText } from '../ui/text';
import { audio } from '../audio/manager';

const NARROW_BREAKPOINT = 720;
// Bounds for the steppers. Width/height go up to 20 (still fits on a mobile
// portrait screen with the in-match HUD); bombs is clamped against the
// current grid area at change time so we never end up with bombs >= cells.
const SIZE_MIN = 4;
const SIZE_MAX = 20;

export class LobbyScene extends Phaser.Scene {
  private boardWidth = 10;
  private boardHeight = 10;
  private bombCount = 15;
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
      y = this.renderSizeRow(colX, y);
      y += 8;
      y = this.renderBombsRow(colX, y);
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
      // Two-column layout (desktop). Left = sizing + match knobs; right =
      // optional rule toggles.
      const leftX = cx - 240;
      const rightX = cx + 20;
      let ly = 130;
      ly = this.renderSizeRow(leftX, ly);
      ly += 10;
      ly = this.renderBombsRow(leftX, ly);
      ly += 10;
      ly = this.renderPlayersRow(leftX, ly);
      ly += 10;
      ly = this.renderTimerRow(leftX, ly);

      let ry = 130;
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

  // Inline width + height steppers on a single row. Bombs gets its own row
  // because it has a wider value (up to triple-digit) and needs its own
  // label so non-obvious clamping behaviour is discoverable.
  private renderSizeRow(x: number, y: number): number {
    addText(this, x, y, 'Board size', { fontSize: '14px', color: '#7c8497' });
    const stepperY = y + 26;
    let cx = x;
    const wStep = this.makeStepper(cx, stepperY, 'W', this.boardWidth, SIZE_MIN, SIZE_MAX, (v) => {
      this.boardWidth = v;
      // Keep bombs valid against the new area before redraw.
      this.bombCount = clamp(this.bombCount, 1, v * this.boardHeight - 1);
      this.scene.restart();
    });
    cx += wStep.width + 12;
    const hStep = this.makeStepper(cx, stepperY, 'H', this.boardHeight, SIZE_MIN, SIZE_MAX, (v) => {
      this.boardHeight = v;
      this.bombCount = clamp(this.bombCount, 1, this.boardWidth * v - 1);
      this.scene.restart();
    });
    return stepperY + Math.max(wStep.height, hStep.height) + 6;
  }

  private renderBombsRow(x: number, y: number): number {
    const max = this.boardWidth * this.boardHeight - 1;
    addText(this, x, y, 'Bombs', { fontSize: '14px', color: '#7c8497' });
    const stepperY = y + 26;
    const step = this.makeStepper(x, stepperY, '', this.bombCount, 1, max, (v) => {
      this.bombCount = v;
      this.scene.restart();
    });
    return stepperY + step.height + 6;
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

  // [-]  prefix value  [+]  — three-button stepper. Disabled buttons render
  // dimmed and don't fire the onChange callback. Returns the rendered size
  // so callers can advance the layout cursor.
  private makeStepper(
    x: number,
    y: number,
    prefix: string,
    value: number,
    min: number,
    max: number,
    onChange: (next: number) => void,
  ): { width: number; height: number } {
    const btnW = 32;
    const valueW = 70;
    const h = 32;
    const gap = 6;
    const totalW = btnW + gap + valueW + gap + btnW;

    const decX = x;
    const valueX = x + btnW + gap;
    const incX = valueX + valueW + gap;

    const decEnabled = value > min;
    const incEnabled = value < max;

    this.makeStepperBtn(decX, y, btnW, h, '−', decEnabled, () => onChange(value - 1));
    const valueLabel = prefix ? `${prefix} ${value}` : `${value}`;
    this.add.rectangle(valueX, y, valueW, h, 0x12151f).setStrokeStyle(1, 0x2a3a5a).setOrigin(0, 0);
    addText(this, valueX + valueW / 2, y + h / 2, valueLabel, {
      fontSize: '15px',
      color: '#e8ecf1',
    }).setOrigin(0.5);
    this.makeStepperBtn(incX, y, btnW, h, '+', incEnabled, () => onChange(value + 1));

    return { width: totalW, height: h };
  }

  private makeStepperBtn(
    x: number,
    y: number,
    w: number,
    h: number,
    label: string,
    enabled: boolean,
    onClick: () => void,
  ) {
    const bg = this.add.rectangle(x, y, w, h, enabled ? 0x2a6df4 : 0x14171e)
      .setStrokeStyle(1, enabled ? 0x4f8bff : 0x2a2e38)
      .setOrigin(0, 0);
    addText(this, x + w / 2, y + h / 2, label, {
      fontSize: '18px',
      color: enabled ? '#ffffff' : '#4a5063',
      fontStyle: 'bold',
    }).setOrigin(0.5);
    if (!enabled) return;
    bg.setInteractive({ useHandCursor: true });
    bg.on('pointerover', () => bg.setFillStyle(0x3b7bff));
    bg.on('pointerout', () => bg.setFillStyle(0x2a6df4));
    bg.on('pointerdown', onClick);
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
    const config: MatchConfig = {
      width: this.boardWidth,
      height: this.boardHeight,
      // Re-clamp at start time too — guards against any race where a
      // previously-valid bomb count outpaced a width/height shrink.
      coreCount: clamp(this.bombCount, 1, this.boardWidth * this.boardHeight - 1),
      players: this.players,
      seed: Math.floor(Math.random() * 0xffffffff),
      rules: { ...this.rules },
      turnSeconds: this.turnSeconds,
    };
    this.scene.start('Match', { config });
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
