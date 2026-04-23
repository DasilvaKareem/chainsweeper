import * as Phaser from 'phaser';
import { addText } from '../ui/text';
import { audio } from '../audio/manager';
import { createRoom, joinRoom, isValidRoomCode, type RoomClient } from '../net/room';
import { DEFAULT_RULES, type MatchConfig } from '../state/gameState';
import { ChainClient, deriveMatchId, encryptBoard, BITE_SANDBOX_2, CONTRACTS } from '../chain';

type Mode = 'menu' | 'create' | 'join' | 'connecting' | 'host-ready' | 'guest-waiting';

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

const TURN_OPTIONS = [0, 10, 20, 30];

export class OnlineLobbyScene extends Phaser.Scene {
  private mode: Mode = 'menu';
  private layer!: Phaser.GameObjects.Container;
  private typedCode = '';
  private room: RoomClient | null = null;
  private keyHandler: ((ev: KeyboardEvent) => void) | null = null;
  // Host-side picks (only meaningful when this client is the host).
  private presetIdx = 1;
  private turnSeconds = 0;
  // Ranked = on-chain. Host's choice; guest inherits via match-config envelope.
  private ranked = false;
  // Cached wallet client so we only prompt to connect once per lobby session.
  private chainClient: ChainClient | null = null;
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
        this.showError((err as Error).message ?? 'Failed to create match');
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
  // transition on the same signal. If the envelope carries chain info, the
  // guest also needs to join the match on-chain before transitioning.
  private async handleMatchConfig(raw: unknown) {
    if (this.transitioning) return;
    if (!this.room) return;
    const parsed = normalizeMatchConfig(raw);
    if (!parsed) {
      this.showError('Received invalid match config');
      return;
    }

    const mySeat = this.room.isHost ? 0 : 1;
    let chainCtx: { client: ChainClient; matchId: string } | undefined;

    if (parsed.chain) {
      // Guest still needs to call joinMatch on-chain; host already created it
      // and doesn't need to re-join. Skipping the re-prompt for host keeps the
      // UX crisp (one wallet popup for createMatch + nothing else here).
      if (this.room.isHost) {
        if (!this.chainClient) {
          this.showError('Internal: host missing chain client');
          return;
        }
        chainCtx = { client: this.chainClient, matchId: parsed.chain.matchId };
      } else {
        this.renderMode('connecting');
        try {
          if (!this.chainClient) this.chainClient = await ChainClient.connect();
          await this.chainClient.joinMatch(parsed.chain.matchId);
          chainCtx = { client: this.chainClient, matchId: parsed.chain.matchId };
        } catch (err) {
          this.showError((err as Error).message ?? 'Failed to join on-chain match');
          return;
        }
      }
    }

    this.transitioning = true;
    const online = { room: this.room, mySeat, chain: chainCtx };
    this.scene.start('Match', { config: parsed.config, online });
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
        this.showError((err as Error).message ?? 'Failed to join match');
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

  // Host sees this once the opponent connects. Compact pickers for board
  // size + turn timer. Rules are defaulted for MVP — can be expanded later.
  private renderHostReady(cx: number, height: number) {
    addText(this, cx, height * 0.28, 'Opponent connected', {
      fontSize: '14px',
      color: '#7cf0a0',
      fontStyle: 'bold',
    }).setOrigin(0.5);

    // Board row
    const boardLabel = addText(this, cx, height * 0.36, 'Board', {
      fontSize: '14px',
      color: '#7c8497',
    }).setOrigin(0.5);
    this.layer.add(boardLabel);
    this.renderChipRow(cx, height * 0.36 + 26, PRESETS.map((p, i) => ({
      label: p.label,
      active: () => this.presetIdx === i,
      onClick: () => { this.presetIdx = i; this.renderMode('host-ready'); },
    })));

    // Turn timer row (disabled in ranked mode — the on-chain contract has no
    // skipTurn function yet, so timer-driven skips can't be settled on-chain).
    if (!this.ranked) {
      const timerLabel = addText(this, cx, height * 0.48, 'Turn timer', {
        fontSize: '14px',
        color: '#7c8497',
      }).setOrigin(0.5);
      this.layer.add(timerLabel);
      this.renderChipRow(cx, height * 0.48 + 26, TURN_OPTIONS.map((t) => ({
        label: t === 0 ? 'Off' : `${t}s`,
        active: () => this.turnSeconds === t,
        onClick: () => { this.turnSeconds = t; this.renderMode('host-ready'); },
      })));
    }

    // Ranked toggle — flips the match from DO-only to on-chain (SKALE + BITE).
    const rankedLabel = addText(this, cx, height * 0.56, 'Mode', {
      fontSize: '14px',
      color: '#7c8497',
    }).setOrigin(0.5);
    this.layer.add(rankedLabel);
    this.renderChipRow(cx, height * 0.56 + 26, [
      {
        label: 'Casual',
        active: () => !this.ranked,
        onClick: () => { this.ranked = false; this.turnSeconds = 0; this.renderMode('host-ready'); },
      },
      {
        label: 'Ranked · on-chain',
        active: () => this.ranked,
        onClick: () => { this.ranked = true; this.turnSeconds = 0; this.renderMode('host-ready'); },
      },
    ]);

    this.makeButton(cx, height * 0.72, 'Start Match', 0x2a6df4, 260, async () => {
      const preset = PRESETS[this.presetIdx];
      const coreCount = Math.max(1, Math.round(preset.width * preset.height * preset.coreDensity));
      const seed = Math.floor(Math.random() * 0xffffffff);
      const config: MatchConfig = {
        width: preset.width,
        height: preset.height,
        coreCount,
        players: 2,
        seed,
        rules: { ...DEFAULT_RULES },
        turnSeconds: this.turnSeconds,
      };

      if (!this.ranked) {
        // DO-only path: rely on the match-config echo so both clients land on
        // MatchScene together.
        this.room?.sendMatchConfig(config);
        return;
      }

      // Ranked path: wallet + chain createMatch, THEN broadcast the envelope
      // with chain.matchId so the guest can joinMatch on-chain. We deliberately
      // zero out the seed in the broadcast config — the real seed stays host-
      // local. Both clients use the public config as a placeholder board; the
      // authoritative state comes from chain Revealed events.
      const { width, height: scH } = this.scale;
      this.flashToast(width / 2, scH * 0.80, 'Connecting wallet…', '#6eb4ff');
      try {
        if (!this.chainClient) this.chainClient = await ChainClient.connect();
        this.flashToast(width / 2, scH * 0.80, 'Encrypting board…', '#6eb4ff');
        const salt = crypto.randomUUID();
        const matchId = deriveMatchId(this.room!.code, salt);
        const { cipherCells } = await encryptBoard(BITE_SANDBOX_2.rpcUrl, CONTRACTS.match, config);
        this.flashToast(width / 2, scH * 0.80, 'Posting match to chain…', '#6eb4ff');
        await this.chainClient.createMatch(matchId, config.width, config.height, config.coreCount, cipherCells);

        const publicConfig = { ...config, seed: 0, chain: { matchId } };
        this.room?.sendMatchConfig(publicConfig);
      } catch (err) {
        this.flashToast(width / 2, scH * 0.80, (err as Error).message ?? 'Chain setup failed', '#ff7a7a');
      }
    });
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

interface ParsedMatchConfig {
  config: MatchConfig;
  chain?: { matchId: string };
}

// Defensive validation — the config crosses the wire as `unknown` and we
// don't trust the shape. Coerce into a clean MatchConfig + optional chain
// info, or return null. The chain info, when present, flips the match into
// on-chain/Ranked mode downstream.
function normalizeMatchConfig(raw: unknown): ParsedMatchConfig | null {
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

  let chain: ParsedMatchConfig['chain'];
  const rawChain = r.chain;
  if (rawChain && typeof rawChain === 'object') {
    const mid = (rawChain as { matchId?: unknown }).matchId;
    if (typeof mid === 'string' && /^0x[a-fA-F0-9]{64}$/.test(mid)) {
      chain = { matchId: mid };
    }
  }

  return {
    config: { width, height, coreCount, players, seed, rules, turnSeconds },
    chain,
  };
}
