import * as Phaser from 'phaser';
import { addText } from '../ui/text';
import { audio } from '../audio/manager';
import { createRoom, joinRoom, isValidRoomCode, type RoomClient } from '../net/room';
import { DEFAULT_RULES, type MatchConfig } from '../state/gameState';
import { friendlyTxError } from '../chain';

type Mode = 'menu' | 'create' | 'join' | 'connecting' | 'host-ready' | 'guest-waiting';

const TURN_OPTIONS = [0, 10, 20, 30];
// Bounds for the board steppers. Match LobbyScene; normalizeMatchConfig
// also caps width/height at 32 server-side as a safety net.
const SIZE_MIN = 4;
const SIZE_MAX = 20;

export class OnlineLobbyScene extends Phaser.Scene {
  private mode: Mode = 'menu';
  private layer!: Phaser.GameObjects.Container;
  private typedCode = '';
  private room: RoomClient | null = null;
  private keyHandler: ((ev: KeyboardEvent) => void) | null = null;
  // Host-side picks (only meaningful when this client is the host).
  private boardWidth = 10;
  private boardHeight = 10;
  private bombCount = 15;
  private turnSeconds = 0;
  // Guarded so a late arriving event can't trigger a second transition.
  private transitioning = false;

  constructor() {
    super('OnlineLobby');
  }

  create() {
    audio.playBgm('menu-quiet-invitation');
    this.transitioning = false;
    this.renderMode('menu');

    this.scale.on('resize', this.handleResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off('resize', this.handleResize, this);
      this.detachKeyboard();
      // Don't close the room if we're transitioning into MatchScene — the
      // match will (eventually) need the same WS for move sync.
      if (!this.transitioning) {
        this.room?.close();
        this.room = null;
      }
    });
  }

  private handleResize = () => this.renderMode(this.mode);

  private renderMode(next: Mode) {
    this.mode = next;
    this.layer?.destroy();
    this.detachKeyboard();
    this.layer = this.add.container(0, 0);

    const { width, height } = this.scale;
    const cx = width / 2;

    const title = addText(this, cx, height * 0.14, 'Online Match', {
      fontSize: '38px',
      color: '#e8ecf1',
    }).setOrigin(0.5);
    this.layer.add(title);

    const subtitle = addText(this, cx, height * 0.14 + 42, 'ON-CHAIN · REALTIME', {
      fontSize: '12px',
      color: '#6eb4ff',
      fontStyle: 'bold',
    }).setOrigin(0.5);
    this.layer.add(subtitle);

    if (next === 'menu') this.renderMenu(cx, height);
    else if (next === 'create') this.renderCreate(cx, height);
    else if (next === 'join') this.renderJoin(cx, height);
    else if (next === 'connecting') this.renderConnecting(cx, height);
    else if (next === 'host-ready') this.renderHostReady(cx, height);
    else if (next === 'guest-waiting') this.renderGuestWaiting(cx, height);

    this.makeButton(
      cx,
      height - 60,
      next === 'menu' ? 'Back to Menu' : 'Back',
      0x3a3f55,
      220,
      () => {
        if (next === 'menu') {
          this.scene.start('Menu');
        } else {
          this.room?.close();
          this.room = null;
          this.typedCode = '';
          this.renderMode('menu');
        }
      },
    );
  }

  private renderMenu(cx: number, height: number) {
    this.makeButton(cx, height * 0.48, 'Create Match', 0x2a6df4, 260, async () => {
      this.renderMode('connecting');
      try {
        this.room = await createRoom();
        this.attachRoomEvents();
        this.renderMode('create');
      } catch (err) {
        console.error('[online] createRoom failed', err);
        this.showError(`Failed to create match — ${friendlyTxError(err)}`);
      }
    });
    this.makeButton(cx, height * 0.48 + 72, 'Join Match', 0x2a6df4, 260, () => {
      this.typedCode = '';
      this.renderMode('join');
    });
  }

  // Bound to the room on both host and guest. Dispatches into the scene's
  // mode machine; all network-driven transitions live here.
  private attachRoomEvents() {
    this.room?.onEvent((ev) => {
      if (ev.type === 'match-start') {
        // A second player is present. Host moves to the settings screen;
        // guest waits for the host's match-config message.
        if (this.room?.isHost) {
          if (this.mode !== 'host-ready') this.renderMode('host-ready');
        } else {
          if (this.mode !== 'guest-waiting') this.renderMode('guest-waiting');
        }
      } else if (ev.type === 'opponent-left') {
        // Only surface the disconnect if we haven't already started the match.
        if (!this.transitioning) {
          const { width, height } = this.scale;
          this.flashToast(width / 2, height * 0.78, 'Opponent disconnected', '#ff7a7a');
          if (this.room?.isHost && this.mode === 'host-ready') this.renderMode('create');
          else if (!this.room?.isHost && this.mode === 'guest-waiting') this.renderMode('menu');
        }
      } else if (ev.type === 'match-config') {
        this.handleMatchConfig(ev.config);
      } else if (ev.type === 'error') {
        if (!this.transitioning) this.showError(ev.message);
      }
    });
  }

  // Validates and starts the match. Called on both clients when the DO
  // echoes the host-sent config — the echo is what guarantees both players
  // transition on the same signal.
  private handleMatchConfig(raw: unknown) {
    if (this.transitioning) return;
    if (!this.room) return;
    const config = normalizeMatchConfig(raw);
    if (!config) {
      this.showError('Received invalid match config');
      return;
    }

    const mySeat = this.room.isHost ? 0 : 1;
    this.transitioning = true;
    const online = { room: this.room, mySeat };
    this.scene.start('Match', { config, online });
  }

  private renderCreate(cx: number, height: number) {
    const code = this.room?.code ?? '------';

    const shareLabel = addText(this, cx, height * 0.34, 'Share this code with your opponent', {
      fontSize: '16px',
      color: '#c0c7d6',
    }).setOrigin(0.5);
    this.layer.add(shareLabel);

    const codeText = addText(this, cx, height * 0.44, code.split('').join(' '), {
      fontSize: '52px',
      color: '#f4a62a',
      fontFamily: 'ui-monospace, Menlo, Monaco, Consolas, monospace',
      fontStyle: 'bold',
    }).setOrigin(0.5);
    this.layer.add(codeText);

    const status = addText(this, cx, height * 0.54, 'Waiting for opponent…', {
      fontSize: '16px',
      color: '#7c8497',
    }).setOrigin(0.5);
    this.layer.add(status);

    this.tweens.add({
      targets: status,
      alpha: 0.45,
      yoyo: true,
      repeat: -1,
      duration: 900,
      ease: 'Sine.easeInOut',
    });

    this.makeButton(cx, height * 0.66, 'Copy Code', 0x2a6df4, 220, () => {
      navigator.clipboard?.writeText(code).catch(() => {});
      this.flashToast(cx, height * 0.66 + 44, 'Copied');
    });
  }

  private renderJoin(cx: number, height: number) {
    const enterLabel = addText(this, cx, height * 0.34, 'Enter match code', {
      fontSize: '16px',
      color: '#c0c7d6',
    }).setOrigin(0.5);
    this.layer.add(enterLabel);

    const slotBox = this.add.container(cx, height * 0.44);
    this.layer.add(slotBox);
    const slotW = 44;
    const slotGap = 10;
    const totalW = slotW * 6 + slotGap * 5;
    const slotTexts: Phaser.GameObjects.Text[] = [];
    const slotBgs: Phaser.GameObjects.Rectangle[] = [];
    for (let i = 0; i < 6; i++) {
      const x = -totalW / 2 + i * (slotW + slotGap) + slotW / 2;
      const bg = this.add.rectangle(x, 0, slotW, 60, 0x1c2030)
        .setStrokeStyle(2, 0x475172);
      const t = addText(this, x, 0, '', {
        fontSize: '30px',
        color: '#f4a62a',
        fontFamily: 'ui-monospace, Menlo, Monaco, Consolas, monospace',
        fontStyle: 'bold',
      }).setOrigin(0.5);
      slotBox.add([bg, t]);
      slotBgs.push(bg);
      slotTexts.push(t);
    }

    const hint = addText(this, cx, height * 0.44 + 60, 'Type the 6-character code', {
      fontSize: '12px',
      color: '#7c8497',
    }).setOrigin(0.5);
    this.layer.add(hint);

    const joinBtn = this.makeButton(cx, height * 0.58, 'Join', 0x2a6df4, 220, async () => {
      const code = this.typedCode;
      if (!isValidRoomCode(code)) return;
      this.renderMode('connecting');
      try {
        this.room = await joinRoom(code);
        this.attachRoomEvents();
        // If the host was alone, we wait for them to also receive match-start
        // (which happens as soon as their socket sees opponent-joined). Our
        // client receives room-state listing both players — the connect
        // promise auto-fires match-start on that case.
      } catch (err) {
        console.error('[online] joinRoom failed', err);
        this.showError(`Failed to join match — ${friendlyTxError(err)}`);
      }
    });

    const refresh = () => {
      for (let i = 0; i < 6; i++) {
        slotTexts[i].setText(this.typedCode[i] ?? '');
        const active = i === this.typedCode.length;
        slotBgs[i].setStrokeStyle(2, active ? 0x4f8bff : 0x475172);
      }
      const ready = isValidRoomCode(this.typedCode);
      joinBtn.setAlpha(ready ? 1 : 0.45);
    };
    refresh();

    this.keyHandler = (ev: KeyboardEvent) => {
      if (ev.key === 'Backspace') {
        this.typedCode = this.typedCode.slice(0, -1);
        refresh();
        ev.preventDefault();
      } else if (ev.key === 'Enter') {
        if (isValidRoomCode(this.typedCode)) joinBtn.emit('pointerdown');
      } else if (/^[a-zA-Z0-9]$/.test(ev.key) && this.typedCode.length < 6) {
        this.typedCode += ev.key.toUpperCase();
        refresh();
      }
    };
    window.addEventListener('keydown', this.keyHandler);
  }

  private renderConnecting(cx: number, height: number) {
    const label = addText(this, cx, height * 0.50, 'Connecting…', {
      fontSize: '22px',
      color: '#c0c7d6',
    }).setOrigin(0.5);
    this.layer.add(label);
    this.tweens.add({
      targets: label,
      alpha: 0.4,
      yoyo: true,
      repeat: -1,
      duration: 700,
      ease: 'Sine.easeInOut',
    });
  }

  // Host sees this once the opponent connects. Adjustable board size +
  // bombs + turn timer; rules are defaulted (MVP). Casual-only — ranked
  // (on-chain) was removed from the online flow, so this is purely a
  // DO-mediated match.
  private renderHostReady(cx: number, height: number) {
    addText(this, cx, height * 0.22, 'Opponent connected', {
      fontSize: '14px',
      color: '#7cf0a0',
      fontStyle: 'bold',
    }).setOrigin(0.5);

    // Board size (W + H steppers on one centred row).
    const sizeLabel = addText(this, cx, height * 0.30, 'Board size', {
      fontSize: '14px',
      color: '#7c8497',
    }).setOrigin(0.5);
    this.layer.add(sizeLabel);
    this.renderSizeSteppers(cx, height * 0.30 + 26);

    // Bombs stepper.
    const bombsLabel = addText(this, cx, height * 0.42, 'Bombs', {
      fontSize: '14px',
      color: '#7c8497',
    }).setOrigin(0.5);
    this.layer.add(bombsLabel);
    const maxBombs = this.boardWidth * this.boardHeight - 1;
    this.renderStepper(cx, height * 0.42 + 26, '', this.bombCount, 1, maxBombs, (v) => {
      this.bombCount = v;
      this.renderMode('host-ready');
    });

    // Turn timer row.
    const timerLabel = addText(this, cx, height * 0.54, 'Turn timer', {
      fontSize: '14px',
      color: '#7c8497',
    }).setOrigin(0.5);
    this.layer.add(timerLabel);
    this.renderChipRow(cx, height * 0.54 + 26, TURN_OPTIONS.map((t) => ({
      label: t === 0 ? 'Off' : `${t}s`,
      active: () => this.turnSeconds === t,
      onClick: () => { this.turnSeconds = t; this.renderMode('host-ready'); },
    })));

    this.makeButton(cx, height * 0.70, 'Start Match', 0x2a6df4, 260, () => {
      // Re-clamp bombs against the current grid in case width/height shrank
      // after the user last touched the bombs stepper.
      const coreCount = clamp(this.bombCount, 1, this.boardWidth * this.boardHeight - 1);
      const config: MatchConfig = {
        width: this.boardWidth,
        height: this.boardHeight,
        coreCount,
        players: 2,
        seed: Math.floor(Math.random() * 0xffffffff),
        rules: { ...DEFAULT_RULES },
        turnSeconds: this.turnSeconds,
      };
      // DO echo lands on both clients → handleMatchConfig fires the
      // transition simultaneously.
      this.room?.sendMatchConfig(config);
    });
  }

  // Two steppers (W, H) rendered side-by-side, centred on cx. Bomb count
  // is auto-clamped against the new grid area whenever either changes.
  private renderSizeSteppers(cx: number, y: number) {
    const stepperW = 32 + 6 + 70 + 6 + 32; // matches renderStepper layout
    const gap = 16;
    const totalW = stepperW * 2 + gap;
    const leftX = cx - totalW / 2;
    this.renderStepper(leftX + stepperW / 2, y, 'W', this.boardWidth, SIZE_MIN, SIZE_MAX, (v) => {
      this.boardWidth = v;
      this.bombCount = clamp(this.bombCount, 1, v * this.boardHeight - 1);
      this.renderMode('host-ready');
    });
    const rightX = leftX + stepperW + gap + stepperW / 2;
    this.renderStepper(rightX, y, 'H', this.boardHeight, SIZE_MIN, SIZE_MAX, (v) => {
      this.boardHeight = v;
      this.bombCount = clamp(this.bombCount, 1, this.boardWidth * v - 1);
      this.renderMode('host-ready');
    });
  }

  // [-] prefix value [+] stepper. Centred on (cx, y). Disabled buttons
  // dim and don't fire onChange.
  private renderStepper(
    cx: number,
    y: number,
    prefix: string,
    value: number,
    min: number,
    max: number,
    onChange: (next: number) => void,
  ) {
    const btnW = 32;
    const valueW = 70;
    const h = 32;
    const gap = 6;
    const totalW = btnW + gap + valueW + gap + btnW;
    const leftEdge = cx - totalW / 2;
    const decX = leftEdge + btnW / 2;
    const valueX = leftEdge + btnW + gap + valueW / 2;
    const incX = leftEdge + btnW + gap + valueW + gap + btnW / 2;

    this.renderStepperBtn(decX, y, btnW, h, '−', value > min, () => onChange(value - 1));
    const bg = this.add.rectangle(valueX, y, valueW, h, 0x12151f).setStrokeStyle(1, 0x2a3a5a);
    const text = addText(this, valueX, y, prefix ? `${prefix} ${value}` : `${value}`, {
      fontSize: '15px',
      color: '#e8ecf1',
    }).setOrigin(0.5);
    this.layer.add(bg);
    this.layer.add(text);
    this.renderStepperBtn(incX, y, btnW, h, '+', value < max, () => onChange(value + 1));
  }

  private renderStepperBtn(
    x: number,
    y: number,
    w: number,
    h: number,
    label: string,
    enabled: boolean,
    onClick: () => void,
  ) {
    const bg = this.add.rectangle(x, y, w, h, enabled ? 0x2a6df4 : 0x14171e)
      .setStrokeStyle(1, enabled ? 0x4f8bff : 0x2a2e38);
    const text = addText(this, x, y, label, {
      fontSize: '18px',
      color: enabled ? '#ffffff' : '#4a5063',
      fontStyle: 'bold',
    }).setOrigin(0.5);
    this.layer.add(bg);
    this.layer.add(text);
    if (!enabled) return;
    bg.setInteractive({ useHandCursor: true });
    bg.on('pointerover', () => bg.setFillStyle(0x3b7bff));
    bg.on('pointerout', () => bg.setFillStyle(0x2a6df4));
    bg.on('pointerdown', onClick);
  }

  private renderGuestWaiting(cx: number, height: number) {
    addText(this, cx, height * 0.36, 'Joined match', {
      fontSize: '14px',
      color: '#7cf0a0',
      fontStyle: 'bold',
    }).setOrigin(0.5);

    const label = addText(this, cx, height * 0.50, 'Waiting for host to start…', {
      fontSize: '22px',
      color: '#c0c7d6',
    }).setOrigin(0.5);
    this.layer.add(label);
    this.tweens.add({
      targets: label,
      alpha: 0.4,
      yoyo: true,
      repeat: -1,
      duration: 900,
      ease: 'Sine.easeInOut',
    });
  }

  private renderChipRow(
    cx: number,
    y: number,
    chips: Array<{ label: string; active: () => boolean; onClick: () => void }>,
  ) {
    // Pre-measure so we can center the row. Chip width is driven by label.
    const padX = 14;
    const gap = 10;
    const widths = chips.map((c) => {
      const tmp = addText(this, 0, 0, c.label, { fontSize: '15px' });
      const w = tmp.width + padX * 2;
      tmp.destroy();
      return w;
    });
    const totalW = widths.reduce((a, b) => a + b, 0) + gap * (chips.length - 1);
    let x = cx - totalW / 2;
    chips.forEach((c, i) => {
      const w = widths[i];
      const isActive = c.active();
      const container = this.add.container(x + w / 2, y);
      const bg = this.add.rectangle(0, 0, w, 32, isActive ? 0x2a6df4 : 0x1c2030)
        .setStrokeStyle(1, isActive ? 0x4f8bff : 0x475172);
      const text = addText(this, 0, 0, c.label, {
        fontSize: '15px',
        color: isActive ? '#ffffff' : '#c0c7d6',
      }).setOrigin(0.5);
      container.add([bg, text]);
      bg.setInteractive({ useHandCursor: true });
      bg.on('pointerover', () => !isActive && bg.setFillStyle(0x252b3f));
      bg.on('pointerout', () => !isActive && bg.setFillStyle(0x1c2030));
      bg.on('pointerdown', c.onClick);
      this.layer.add(container);
      x += w + gap;
    });
  }

  private detachKeyboard() {
    if (this.keyHandler) {
      window.removeEventListener('keydown', this.keyHandler);
      this.keyHandler = null;
    }
  }

  private showError(message: string) {
    this.renderMode('menu');
    const { width, height } = this.scale;
    this.flashToast(width / 2, height * 0.62, message, '#ff7a7a');
  }

  private flashToast(x: number, y: number, text: string, color = '#6eb4ff') {
    const toast = addText(this, x, y, text, { fontSize: '14px', color })
      .setOrigin(0.5)
      .setAlpha(0);
    this.tweens.add({
      targets: toast,
      alpha: 1,
      duration: 150,
      yoyo: true,
      hold: 1100,
      onComplete: () => toast.destroy(),
    });
  }

  private makeButton(x: number, y: number, label: string, fill: number, width: number, onClick: () => void) {
    const container = this.add.container(x, y);
    const bg = this.add.rectangle(0, 0, width, 48, fill).setStrokeStyle(2, 0x4f8bff);
    const text = addText(this, 0, 0, label, { fontSize: '18px', color: '#ffffff' }).setOrigin(0.5);
    container.add([bg, text]);
    bg.setInteractive({ useHandCursor: true });
    bg.on('pointerover', () => bg.setFillStyle(fill + 0x111111));
    bg.on('pointerout', () => bg.setFillStyle(fill));
    bg.on('pointerdown', onClick);
    this.layer.add(container);
    return bg;
  }
}

// Defensive validation — the config crosses the wire as `unknown` and we
// don't trust the shape. Coerce into a clean MatchConfig or return null.
function normalizeMatchConfig(raw: unknown): MatchConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const width = num(r.width);
  const height = num(r.height);
  const coreCount = num(r.coreCount);
  const players = num(r.players);
  const seed = num(r.seed);
  if (width === null || height === null || coreCount === null || players === null || seed === null) return null;
  if (width < 4 || height < 4 || width > 32 || height > 32) return null;
  if (players < 2 || players > 4) return null;
  if (coreCount < 1 || coreCount >= width * height) return null;

  const turnSeconds = typeof r.turnSeconds === 'number' ? r.turnSeconds : 0;
  const rulesIn = (r.rules && typeof r.rules === 'object') ? r.rules as Record<string, unknown> : {};
  const rules = {
    gentleman: rulesIn.gentleman === true,
    soreLoser: rulesIn.soreLoser === true,
    soreLoserLead: typeof rulesIn.soreLoserLead === 'number' ? rulesIn.soreLoserLead : DEFAULT_RULES.soreLoserLead,
    limitedBomb: rulesIn.limitedBomb === true,
    limitedBombThreshold: typeof rulesIn.limitedBombThreshold === 'number' ? rulesIn.limitedBombThreshold : DEFAULT_RULES.limitedBombThreshold,
  };

  return { width, height, coreCount, players, seed, rules, turnSeconds };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
