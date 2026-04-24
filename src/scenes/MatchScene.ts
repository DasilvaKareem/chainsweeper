import * as Phaser from 'phaser';
import {
  createMatch,
  reveal,
  mark,
  skipTurn,
  idx,
  applyChainReveal,
  forceEnd,
  type GameState,
  type MatchConfig,
  type PlayerType,
} from '../state/gameState';
import { aiMove } from '../state/ai';
import { ChatterPicker } from '../state/dialogue';
import type { Champion } from '../state/arcade';
import {
  TUTOR_SPEAKER,
  TUTOR_ROLE,
  type TutorStep,
} from '../state/tutorial';
import { addText } from '../ui/text';
import { haptic } from '../ui/haptic';
import { audio, championBgm, type BgmId, type ChampionKey } from '../audio/manager';
import type { RoomClient, NetMove } from '../net/room';
import { playerState } from '../state/player';
import type { ChainClient } from '../chain';
import { friendlyTxError } from '../chain';

const GAP = 2;
// Base board margin top. Bumped per-match in `computeBoardMarginTop` so the
// HUD stack (title / turn / timer / per-player score rows) always has room —
// multi-player floors need more vertical space than solo floors.
const BOARD_MARGIN_TOP = 120;
const BOARD_MARGIN_TOP_NARROW = 130;
const BOARD_MARGIN_BOTTOM = 60;
const BOARD_MARGIN_BOTTOM_NARROW = 90;
// Vertical anchors for the left HUD column. Keeping these as constants so
// the timer bar and the per-player score rows can't drift back into each
// other. Each row is a separate Text object so long player lists don't run
// past the board margin.
const HUD_TURN_Y = 58;          // turn label (24px font)
const HUD_TIMER_LABEL_Y = 96;   // "YOU" tag above the timer bar
const HUD_TIMER_BAR_Y = 112;    // timer bar centerline
const HUD_SCORES_START_Y = 132; // first player's row
const HUD_ROW_HEIGHT = 20;      // gap between player rows
const BOARD_MARGIN_X = 40;
const BOARD_MARGIN_X_NARROW = 10;
const TILE_MIN = 26;
const TILE_MIN_NARROW = 20;
const TILE_MAX = 56;
const NARROW_BREAKPOINT = 620;
const LONG_PRESS_MS = 420;

function isNarrow(width: number): boolean {
  return width < NARROW_BREAKPOINT;
}

const NUMBER_COLORS = [
  '#000000', '#6eb4ff', '#7de57d', '#ff7b7b', '#c48cff',
  '#ffbd4a', '#4ad6e0', '#b0b0b0', '#9e9e9e',
];

const PLAYER_COLORS = [0xf4a62a, 0x2ac9f4, 0xa6f42a, 0xf42ac9];

// Per-character border color for the in-match chatter portrait. Picked to
// echo each Floor Master's voice (IRIS cool/procedural, GLITCH hot pink
// anomaly, PROOF gold certainty, etc.). Also covers the MC avatars and the
// tutor so every speaker has a distinct ring.
const CHARACTER_BORDER_COLORS: Record<string, number> = {
  iris: 0x6eb4ff,
  trace: 0xa78bfa,
  glitch: 0xf472b6,
  proof: 0xf4d04a,
  fork: 0xef5a3a,
  patch: 0x2ee08a,
  root: 0xdc2626,
  engineer: 0xe5e7eb,
  init0: 0x7c8497,
  mc_boy: 0x2ac9f4,
  mc_girl: 0xf42ac9,
};
const CHATTER_PORTRAIT_SIZE = 96;
// Bottom edge of the chatter text. Portrait sits above this, text hangs just
// below it, so bumping this raises the whole chatter assembly.
const CHATTER_TEXT_OFFSET_FROM_BOTTOM = 100;

export interface MatchCreateData {
  config: MatchConfig;
  champion?: Champion;
  // Battle-royale cameos. Aligned with playerTypes starting at index 2 —
  // index 0 = human, index 1 = primary `champion`, indices 2+ draw from
  // this array. Missing / undefined entries fall back to anonymous AI.
  aiChampions?: Champion[];
  floorLabel?: string;
  tutor?: {
    script: TutorStep[];
    onSkip?: () => { scene: string; data?: unknown };
  };
  // Return { scene, data } describing where to go when the player clicks
  // Continue on the end banner. MatchScene performs the actual scene.start.
  onComplete?: (result: { scores: number[]; winner: number | null }) => {
    scene: string;
    data?: unknown;
  };
  // Online (networked) match context. When present, the scene flips into
  // "send moves over DO, apply on echo" mode — local input builds a NetMove
  // and ships it; the reducer only ever runs on echoed moves so both clients
  // stay in lockstep. mySeat is the player index this client occupies.
  online?: {
    room: RoomClient;
    mySeat: number;
    // When present, the match is on-chain (SKALE + BITE). Reveals go through
    // the contract; Revealed events drive local state. The DO room stays
    // subscribed for presence/disconnect detection only.
    chain?: { client: ChainClient; matchId: string };
  };
}

export class MatchScene extends Phaser.Scene {
  private state!: GameState;
  private tileSize = 44;
  private tileGfx: Phaser.GameObjects.Graphics[] = [];
  private tileText: (Phaser.GameObjects.Text | null)[] = [];
  private tileLockIcon: (Phaser.GameObjects.Image | null)[] = [];
  private tileCoreSprite: (Phaser.GameObjects.Sprite | null)[] = [];
  private tileHitAreas: Phaser.GameObjects.Rectangle[] = [];
  // Optional BG scene dressing — champion/tutor backdrop behind the board.
  // Stored as refs so handleResize() can rescale them without a scene restart.
  private bgImage?: Phaser.GameObjects.Image;
  private bgOverlay?: Phaser.GameObjects.Rectangle;
  // Match-side portraits — MC on the left gutter, active-turn champion on
  // the right. Rendered behind HUD text so top-left score rows still read;
  // skipped on narrow viewports where the board already fills the scene.
  private mcMatchImg?: Phaser.GameObjects.Image;
  private championMatchImg?: Phaser.GameObjects.Image;
  // One Text per player — colored per-seat and stacked vertically below the
  // timer. Replaces the older single-line hudText which ran off the right
  // edge on 3–4 player floors.
  private hudRows: Phaser.GameObjects.Text[] = [];
  private turnText!: Phaser.GameObjects.Text;
  private toastText!: Phaser.GameObjects.Text;
  // Dual timer bars in vs mode — P0 on left ("my side"), active opponent on
  // right. Single-player runs only render the left bar. The inactive bar is
  // dimmed while its player isn't on turn.
  private timerLeftBg?: Phaser.GameObjects.Rectangle;
  private timerLeftFg?: Phaser.GameObjects.Rectangle;
  private timerLeftLabel?: Phaser.GameObjects.Text;
  private timerRightBg?: Phaser.GameObjects.Rectangle;
  private timerRightFg?: Phaser.GameObjects.Rectangle;
  private timerRightLabel?: Phaser.GameObjects.Text;
  private turnDeadline = 0;
  private playerTypes: PlayerType[] = [];
  private aiPending = false;
  // Parent scene tells Match "when the match ends, go to this scene with this
  // data". We used to accept a callback here, but that captured the parent's
  // `this` and its scene plugin — which was already shut down by the time the
  // callback ran, so `scene.start` silently no-op'd. Returning a transition
  // descriptor lets MatchScene do the dispatch with its own (valid) plugin.
  private onComplete?: (result: { scores: number[]; winner: number | null }) => {
    scene: string;
    data?: unknown;
  };
  private champion?: Champion;
  private aiChampions: Champion[] = [];
  private floorLabel?: string;
  private chatter = new ChatterPicker();
  private chatterName?: Phaser.GameObjects.Text;
  private chatterLine?: Phaser.GameObjects.Text;
  // Square bust-up portrait next to the chatter text. Border graphic carries
  // the character-specific accent color; the image itself is masked so only
  // the head + shoulders show inside the square.
  private chatterPortrait?: Phaser.GameObjects.Image;
  private chatterPortraitBorder?: Phaser.GameObjects.Graphics;
  private chatterPortraitBg?: Phaser.GameObjects.Rectangle;
  // Breathing alpha tween on the border so the speaker's ring draws the eye.
  // Held as a ref so it can be stopped when the chatter hides (otherwise the
  // yoyo would fight the fade-out tween).
  private chatterPulseTween?: Phaser.Tweens.Tween;
  private chatterHideAt = 0;
  private nextMidMatchAt = 0;
  private tutorScript?: TutorStep[];
  private tutorIdx = 0;
  // Pulsing ring overlay that points at a specific tile during guided tutorial
  // steps. Only present when the current TutorStep has a `target`.
  private tutorHighlight?: Phaser.GameObjects.Graphics;
  private tutorHighlightTween?: Phaser.Tweens.Tween;
  private tutorTarget?: { x: number; y: number };
  // Same deal as onComplete — returns a transition descriptor instead of
  // dispatching a scene change on a stale plugin.
  private onTutorSkip?: () => { scene: string; data?: unknown };
  private hintLeftText?: Phaser.GameObjects.Text;
  private hintRightText?: Phaser.GameObjects.Text;
  // Classic-minesweeper elapsed clock. Counts up from 0, freezes on end.
  private elapsedText?: Phaser.GameObjects.Text;
  private skipButtonBg?: Phaser.GameObjects.Rectangle;
  private skipButtonLabel?: Phaser.GameObjects.Text;
  // Touch-only mode: when on, a single tap quarantines instead of revealing.
  // Toggle lives in the bottom-right of narrow layouts so the thumb can flip
  // modes without needing to hold a tile down for the long-press threshold.
  private quarantineMode = false;
  private modeToggleBg?: Phaser.GameObjects.Rectangle;
  private modeToggleLabel?: Phaser.GameObjects.Text;
  private createData?: MatchCreateData;
  private endBannerShown = false;
  // Timestamp at which the match mounted. Belt-and-suspenders: the end banner
  // refuses to show earlier than ~500ms after this, which blocks any stray
  // event from a previous scene (held keys, queued pointerup) from triggering
  // a phantom "match ended" immediately on mount.
  private matchStartedAt = 0;
  // Per-player time spent on their own turns (ms). Committed on each turn
  // transition using turnStartedAt as the reference point.
  private perPlayerMs: number[] = [];
  private turnStartedAt = 0;
  // Danger-loop SFX is active while a human is on turn with <30% time left.
  // Latched so we only fire start/stop on transitions.
  private lowTimeActive = false;
  // Mark count for the currently-acting AI within its ongoing turn. Since
  // marks no longer advance the turn, a smart AI with many forced Cores
  // could mark-spam forever. Cap = 2, then the AI is forced into its reveal
  // branch. Resets when the turn actually rotates to a new player.
  private aiMarksThisTurn = 0;
  // Online multiplayer context; undefined for local/arcade matches.
  private online?: { room: RoomClient; mySeat: number; chain?: { client: ChainClient; matchId: string } };
  // Chain-mode event subscriptions — called to unsubscribe on scene shutdown.
  private chainUnsubs: Array<() => void> = [];
  // While true, user input is locked — we've sent a move and are waiting
  // for the server echo before applying it. Cleared on every applyMove().
  private pendingMove = false;
  // Set when a match ends by forfeit (opponent disconnect, not natural end).
  // Takes over the end-banner title so it reads correctly in that case.
  private forfeitReason: string | null = null;
  // Latched so network errors don't stack multiple "Connection Lost" modals.
  private disconnectShown = false;

  constructor() {
    super('Match');
  }

  create(data: MatchCreateData) {
    this.createData = data;
    this.endBannerShown = false;
    this.matchStartedAt = this.time.now;
    this.state = createMatch(data.config);
    this.onComplete = data.onComplete;
    this.champion = data.champion;
    this.aiChampions = data.aiChampions ?? [];
    this.floorLabel = data.floorLabel;
    this.tutorScript = data.tutor?.script;
    this.onTutorSkip = data.tutor?.onSkip;
    this.tutorIdx = 0;
    this.chatter.reset();
    this.online = data.online;
    this.pendingMove = false;
    this.forfeitReason = null;
    this.disconnectShown = false;
    this.playerTypes =
      data.config.playerTypes ??
      Array.from({ length: data.config.players }, () => ({ kind: 'human' as const }));
    this.aiPending = false;
    this.tileGfx = [];
    this.tileText = [];
    this.tileLockIcon = [];
    this.tileCoreSprite = [];
    this.tileHitAreas = [];
    this.perPlayerMs = new Array(this.playerTypes.length).fill(0);
    this.turnStartedAt = this.time.now;
    this.tileSize = this.computeTileSize();

    this.cameras.main.setBackgroundColor('#0b0d12');

    // Optional BG scene dressing. Picks `bg_<champion.id>` for vs-AI floors,
    // `bg_init0` for the tutor-driven Floor 1, else nothing. Heavy overlay so
    // the board tiles and HUD remain the clear focal point.
    const bgId = this.champion?.id ?? (this.tutorScript ? 'init0' : null);
    if (bgId) {
      const bgKey = `bg_${bgId}`;
      if (this.textures.exists(bgKey)) {
        const { width, height } = this.scale;
        const tex = this.textures.get(bgKey).getSourceImage() as HTMLImageElement;
        const scale = Math.max(width / tex.width, height / tex.height);
        this.bgImage = this.add.image(width / 2, height / 2, bgKey).setScale(scale);
        this.bgOverlay = this.add.rectangle(0, 0, width, height, 0x0b0d12, 0.72).setOrigin(0, 0);
      }
    }

    // MC + active-player portraits in the gutters on either side of the
    // board. Rendered before the HUD so top-left score rows still read on
    // top. Builds after buildBoard() so the gutter math can use tileSize.
    this.buildMatchPortraits();

    // Top-left: floor + opponent context, then turn, then score summary.
    if (this.floorLabel) {
      addText(this, 24, 20, this.floorLabel, {
        fontSize: '12px',
        color: '#6eb4ff',
        fontStyle: 'bold',
      });
    }
    const opponentLine = this.buildOpponentSummary();
    if (opponentLine) {
      addText(this, 24, 36, opponentLine, {
        fontSize: '12px',
        color: '#7c8497',
      });
    }
    this.turnText = addText(this, 24, HUD_TURN_Y, '', {
      fontSize: '24px',
      color: '#e8ecf1',
    });
    // One row per player, colored by seat. Filled in by renderHud().
    this.hudRows = [];
    for (let i = 0; i < this.playerTypes.length; i++) {
      const row = addText(this, 24, HUD_SCORES_START_Y + i * HUD_ROW_HEIGHT, '', {
        fontSize: '14px',
        color: '#' + PLAYER_COLORS[i].toString(16).padStart(6, '0'),
        fontStyle: 'bold',
      });
      this.hudRows.push(row);
    }

    this.hintLeftText = addText(this, this.scale.width - 24, 20, 'Left-click: reveal', {
      fontSize: '13px',
      color: '#4a5063',
    }).setOrigin(1, 0);
    this.hintRightText = addText(this, this.scale.width - 24, 38, 'Right-click OR Shift+click: quarantine', {
      fontSize: '13px',
      color: '#4a5063',
    }).setOrigin(1, 0);
    this.elapsedText = addText(this, this.scale.width - 24, 60, '0:00', {
      fontSize: '20px',
      color: '#f4a62a',
      fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
      fontStyle: 'bold',
    }).setOrigin(1, 0);

    this.toastText = addText(this, this.scale.width / 2, 88, '', {
      fontSize: '16px',
      color: '#ff9e6e',
    }).setOrigin(0.5).setAlpha(0);

    this.buildBoard();

    if (this.state.turnSeconds > 0) {
      this.buildTimers();
      this.resetTurnTimer();
    }

    this.buildChatterBox();
    this.applyNarrowLayout();
    this.buildModeToggleButton();
    // Admin force-win would desync a networked match — disable online.
    if (!this.online) this.buildAdminButton();
    this.renderAll();
    this.input.mouse?.disableContextMenu();

    this.scale.on('resize', this.handleResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off('resize', this.handleResize, this);
      // Danger loop is scene-scoped — if we bail mid-match (retry, tutor skip,
      // window close) silence it so it doesn't bleed into menu/dialogue audio.
      audio.stopDangerLoop();
      this.lowTimeActive = false;
      // Release the multiplayer room. Anything downstream of the match (result
      // screens, menu) talks to the backend through a fresh room, if at all.
      this.online?.room.close();
      // Unsubscribe chain listeners — polling against a dead scene would leak.
      for (const unsub of this.chainUnsubs) unsub();
      this.chainUnsubs = [];
      this.online = undefined;
    });

    if (this.online) this.bindOnlineRoom();
    if (this.online?.chain) this.bindChainEvents();

    if (this.tutorScript) {
      this.buildSkipButton();
      this.time.delayedCall(500, () => this.showTutorStep());
    } else if (this.champion) {
      this.time.delayedCall(600, () => this.sayMidMatch());
    }
    this.nextMidMatchAt = this.time.now + 14000 + Math.random() * 6000;

    // Kick off the floor's BGM. Champion theme when we have one, otherwise
    // the gentle default for solo/lobby matches.
    const bgm: BgmId = this.champion
      ? championBgm(this.champion.id as ChampionKey)
      : 'stage1-still-water';
    audio.playBgm(bgm);
    this.lowTimeActive = false;

    this.maybeRunAiTurn();
  }

  private buildSkipButton() {
    const { x, y } = this.skipButtonAnchor();
    this.skipButtonBg = this.add.rectangle(x, y, 160, 30, 0x1c2030)
      .setOrigin(1, 0.5)
      .setStrokeStyle(1, 0x475172)
      .setInteractive({ useHandCursor: true });
    this.skipButtonLabel = addText(this, x - 80, y, 'Skip Tutorial', {
      fontSize: '13px',
      color: '#c8cfdc',
    }).setOrigin(0.5);
    this.skipButtonBg.on('pointerover', () => this.skipButtonBg?.setFillStyle(0x252b3f));
    this.skipButtonBg.on('pointerout', () => this.skipButtonBg?.setFillStyle(0x1c2030));
    this.skipButtonBg.on('pointerdown', () => this.skipTutorial());
  }

  // Narrow: anchor top-right under the timer so it's clear of the chatter
  // block at the bottom. Wide: keep the familiar bottom-right corner — the
  // chatter is short enough there that they don't collide.
  private skipButtonAnchor(): { x: number; y: number } {
    const w = this.scale.width;
    const h = this.scale.height;
    if (isNarrow(w)) return { x: w - 24, y: 52 };
    return { x: w - 24, y: h - 28 };
  }

  // Dev/admin cheat — bottom-left button that force-wins the match for P0.
  // Skips actual play (for iterating on arcade flow / champion dialogue) by
  // flipping match status to ended with winner=0, then firing the normal
  // end-banner path so onComplete routes through ArcadeRun unchanged.
  private buildAdminButton() {
    const x = 16;
    const y = this.scale.height - 22;
    const bg = this.add.rectangle(x, y, 96, 26, 0x241a2e)
      .setOrigin(0, 0.5)
      .setStrokeStyle(1, 0x5a3f72)
      .setInteractive({ useHandCursor: true })
      .setDepth(500);
    const label = addText(this, x + 48, y, '[ADMIN WIN]', {
      fontSize: '10px',
      color: '#b48cff',
      fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(501);
    bg.on('pointerover', () => bg.setFillStyle(0x33223f));
    bg.on('pointerout', () => bg.setFillStyle(0x241a2e));
    bg.on('pointerdown', () => this.adminWin());
    // Silence unused-locals lint — label is held by the scene.
    void label;
  }

  private adminWin() {
    if (this.state.status !== 'playing') return;
    // Force-end the match. P0 as winner routes through ArcadeRun's post-match
    // win path → champion post-win monologue → next floor.
    this.state = {
      ...this.state,
      status: 'ended',
      winner: 0,
    };
    // Silence the danger loop in case it was active — belt-and-suspenders,
    // since we're skipping the natural end path that would have stopped it.
    audio.stopDangerLoop();
    this.lowTimeActive = false;
    this.goToResult();
  }

  private buildOpponentSummary(): string {
    const ai = this.playerTypes.filter((p) => p.kind === 'ai');
    if (ai.length === 0) return 'Solo tutorial — clear every safe tile to win.';
    // Collect every named champion facing the player. Battle royale floors
    // render the full cameo list; 1v1 falls back to "vs {primary}".
    const names: string[] = [];
    if (this.champion) names.push(this.champion.name);
    for (const c of this.aiChampions) names.push(c.name);
    if (names.length > 0) {
      const diff = ai.some((p) => p.kind === 'ai' && p.difficulty === 'smart') ? 'smart' : 'reactive';
      return `vs ${names.join(' + ')} · ${diff}`;
    }
    return `${ai.length} AI opponent${ai.length > 1 ? 's' : ''}`;
  }

  // Which champion sits at the given player index? Index 0 is the human
  // (null); index 1 is the primary champion; indices 2+ pull from the
  // aiChampions cameo list. Returns null when the slot is anonymous AI.
  private championForPlayer(i: number): Champion | null {
    if (i === 0) return null;
    if (i === 1) return this.champion ?? null;
    return this.aiChampions[i - 2] ?? null;
  }

  // Compute the space on either side of the centered board. Returns null if
  // the gutter is too narrow to render a readable portrait (phones, tight
  // desktops) — the caller falls back to the portrait-less layout.
  private gutterGeometry(): { gutter: number; maxW: number; maxH: number } | null {
    const { width, height } = this.scale;
    if (isNarrow(width)) return null;
    const boardW = this.state.width * (this.tileSize + GAP) - GAP;
    const gutter = (width - boardW) / 2;
    if (gutter < 180) return null;
    return {
      gutter,
      // Slightly tighter than VN / dialogue sizing — the board owns the
      // scene, portraits are accent dressing.
      maxW: gutter - 48,
      maxH: height * 0.6,
    };
  }

  private buildMatchPortraits() {
    const geo = this.gutterGeometry();
    if (!geo) return;
    const { height } = this.scale;

    // Left — MC. Texture is fixed for the match (player can't change mid-run).
    const mcKey = `portrait_${playerState.mcKey}`;
    if (this.textures.exists(mcKey)) {
      const tex = this.textures.get(mcKey).getSourceImage() as HTMLImageElement;
      const scale = Math.min(geo.maxW / tex.width, geo.maxH / tex.height);
      this.mcMatchImg = this.add.image(geo.gutter / 2, height / 2, mcKey)
        .setScale(scale)
        .setAlpha(0.4);
      this.tweens.add({
        targets: this.mcMatchImg,
        scaleX: scale * 1.012,
        scaleY: scale * 1.012,
        yoyo: true,
        repeat: -1,
        duration: 2800,
        ease: 'Sine.easeInOut',
      });
    }

    // Right — active-player champion. Texture swaps on each turn via
    // updateMatchPortraits. Seed with the primary champion so something's
    // there from frame one. On tutor floors there's no champion, so fall
    // back to INIT-0 — the tutor narrator — instead of leaving the gutter
    // empty and looking asymmetric.
    const rightId = this.champion?.id ?? (this.tutorScript ? 'init0' : null);
    if (rightId) {
      const key = `portrait_${rightId}`;
      if (this.textures.exists(key)) {
        const tex = this.textures.get(key).getSourceImage() as HTMLImageElement;
        const scale = Math.min(geo.maxW / tex.width, geo.maxH / tex.height);
        const { width } = this.scale;
        this.championMatchImg = this.add.image(width - geo.gutter / 2, height / 2, key)
          .setScale(scale)
          .setAlpha(0.4);
        this.tweens.add({
          targets: this.championMatchImg,
          scaleX: scale * 1.012,
          scaleY: scale * 1.012,
          yoyo: true,
          repeat: -1,
          duration: 3000,
          ease: 'Sine.easeInOut',
        });
      }
    }
    this.updateMatchPortraits();
  }

  // Core-hit reaction — red damage tint + quick horizontal jitter on the
  // side whose player tripped the Core. Tint auto-clears, x position snaps
  // back. Fired from the hitCore branch of handleReveal.
  private reactPortraitOnHit(side: 'mc' | 'champion') {
    const img = side === 'mc' ? this.mcMatchImg : this.championMatchImg;
    if (!img) return;
    // Red flash — tint then clear. Using a chained tween with alpha-held
    // tint keeps the effect single-owner so overlapping hits don't stack.
    img.setTint(0xff4040);
    this.time.delayedCall(320, () => img.clearTint());
    // Horizontal shake — ±10px, three half-cycles, snap back on complete.
    const baseX = img.x;
    this.tweens.add({
      targets: img,
      x: baseX + 10,
      yoyo: true,
      repeat: 2,
      duration: 60,
      ease: 'Sine.easeInOut',
      onComplete: () => img.setX(baseX),
    });
  }

  // Per-turn: dim the side whose turn it isn't, brighten the active side.
  // Right portrait texture swaps to the acting champion for battle-royale
  // floors where multiple cameos take turns.
  private updateMatchPortraits() {
    if (!this.mcMatchImg && !this.championMatchImg) return;
    const p = this.state.currentPlayer;
    const mcTurn = p === 0;
    if (this.mcMatchImg) {
      this.tweens.add({
        targets: this.mcMatchImg,
        alpha: mcTurn ? 0.9 : 0.4,
        duration: 220,
        ease: 'Sine.easeOut',
      });
    }
    if (this.championMatchImg) {
      // Pick who the right portrait should show. Active champion takes it
      // on their turn; otherwise fall back to the primary champion so the
      // right side isn't just blank on the human's turn.
      const active = this.championForPlayer(p);
      const target = !mcTurn && active ? active : this.champion;
      if (target) {
        const key = `portrait_${target.id}`;
        if (this.textures.exists(key) && this.championMatchImg.texture.key !== key) {
          const geo = this.gutterGeometry();
          if (geo) {
            const tex = this.textures.get(key).getSourceImage() as HTMLImageElement;
            const scale = Math.min(geo.maxW / tex.width, geo.maxH / tex.height);
            this.championMatchImg.setTexture(key).setScale(scale);
          }
        }
      }
      this.tweens.add({
        targets: this.championMatchImg,
        alpha: mcTurn ? 0.4 : 0.9,
        duration: 220,
        ease: 'Sine.easeOut',
      });
    }
  }

  private buildChatterBox() {
    const speakerName = this.tutorScript
      ? `${TUTOR_SPEAKER} · ${TUTOR_ROLE}`
      : this.champion?.name;
    if (!speakerName) return;
    const portraitId = this.tutorScript ? 'init0' : this.champion?.id;
    const portraitKey = portraitId ? `portrait_${portraitId}` : null;
    const hasPortrait = !!(portraitKey && this.textures.exists(portraitKey));
    const narrow = isNarrow(this.scale.width);
    // On narrow viewports portrait + text can't sit side-by-side without the
    // text getting clipped, so we stack portrait above and shrink it.
    const size = narrow ? 64 : CHATTER_PORTRAIT_SIZE;
    const offset = narrow ? 180 : CHATTER_TEXT_OFFSET_FROM_BOTTOM;
    const x = 24;
    const y = this.scale.height - offset;
    const textX = narrow ? x : (hasPortrait ? x + size + 14 : x);

    if (hasPortrait && portraitKey && portraitId) {
      const color = CHARACTER_BORDER_COLORS[portraitId] ?? 0x6eb4ff;
      const boxX = x;
      // Narrow: portrait sits above the name, bottom 10px from name baseline.
      // Wide: portrait bottom aligns with the chatter text block (name + line
      // ≈ 36px tall) so the bust shows prominently beside the text.
      const boxY = narrow ? y - size - 10 : y - (size - 36);
      const cx = boxX + size / 2;
      const DEPTH = 900;
      // Solid dark backing so the MC's gutter portrait (which overlaps this
      // x-band at reduced alpha) can't bleed through the transparent pixels
      // around the character. Depth puts the whole chatter portrait stack
      // above the gutter portraits unambiguously.
      this.chatterPortraitBg = this.add
        .rectangle(cx, boxY + size / 2, size, size, 0x0b0d12, 1)
        .setAlpha(0)
        .setDepth(DEPTH);
      const img = this.add.image(cx, boxY, portraitKey).setOrigin(0.5, 0).setAlpha(0);
      const tex = this.textures.get(portraitKey).getSourceImage() as HTMLImageElement;
      // Bust-up crop: take a square from the upper half of the source (where
      // head + shoulders live for a vertical character illustration) and
      // zoom it to fill the box. Using `setCrop` instead of a geometry mask
      // avoids a second draw path and keeps the image on top of the bg
      // without stencil-buffer ordering quirks.
      const cropSide = Math.min(tex.width, Math.round(tex.height * 0.5));
      const cropX = Math.max(0, Math.round((tex.width - cropSide) / 2));
      img.setCrop(cropX, 0, cropSide, cropSide);
      const scale = size / cropSide;
      img.setScale(scale);
      // With origin (0.5, 0) and position (cx, boxY), the cropped square's
      // top-center aligns with (cx, boxY) — exactly the top of the box —
      // because the crop is horizontally centered and starts at y=0.
      img.setDepth(DEPTH + 1);
      this.chatterPortrait = img;
      const border = this.add.graphics().setAlpha(0).setDepth(DEPTH + 2);
      border.lineStyle(3, color, 1);
      border.strokeRect(boxX, boxY, size, size);
      // Inner 1px highlight for a subtle bevel so the border reads on any bg.
      border.lineStyle(1, 0xffffff, 0.25);
      border.strokeRect(boxX + 2, boxY + 2, size - 4, size - 4);
      this.chatterPortraitBorder = border;
    }

    this.chatterName = addText(this, textX, y, speakerName, {
      fontSize: '12px',
      color: '#6eb4ff',
      fontStyle: 'bold',
    }).setAlpha(0);
    // Narrow: portrait is stacked above, so text gets the full width.
    // Wide: text sits beside the portrait so we reserve the portrait band.
    const wrapWidth = narrow
      ? this.scale.width - 48
      : Math.min(
          560 - (hasPortrait ? size + 14 : 0),
          this.scale.width - 60 - (hasPortrait ? size + 14 : 0),
        );
    this.chatterLine = addText(this, textX, y + 18, '', {
      fontSize: '17px',
      color: '#e8ecf1',
      wordWrap: { width: wrapWidth },
    }).setAlpha(0);
  }

  private startChatterPulse() {
    if (!this.chatterPortraitBorder) return;
    this.chatterPulseTween?.stop();
    this.chatterPulseTween = this.tweens.add({
      targets: this.chatterPortraitBorder,
      alpha: 0.55,
      duration: 900,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }

  private chatterFadeTargets(): Phaser.GameObjects.GameObject[] {
    const t: Phaser.GameObjects.GameObject[] = [];
    if (this.chatterName) t.push(this.chatterName);
    if (this.chatterLine) t.push(this.chatterLine);
    if (this.chatterPortrait) t.push(this.chatterPortrait);
    if (this.chatterPortraitBorder) t.push(this.chatterPortraitBorder);
    if (this.chatterPortraitBg) t.push(this.chatterPortraitBg);
    return t;
  }

  private showTutorStep() {
    if (!this.tutorScript || !this.chatterName || !this.chatterLine) return;
    const step = this.tutorScript[this.tutorIdx];
    if (!step) return;
    const fadeTargets = this.chatterFadeTargets();
    this.tweens.killTweensOf(fadeTargets);
    this.chatterLine.setText(step.text);
    for (const t of fadeTargets) (t as unknown as Phaser.GameObjects.Components.Alpha).setAlpha(1);
    this.startChatterPulse();
    this.chatterHideAt = 0; // persistent for tutor — no auto-fade
    if (step.target) {
      this.showTutorHighlight(step.target.x, step.target.y);
    } else {
      this.clearTutorHighlight();
    }
    if (step.waitFor === 'none' && step.delay) {
      this.time.delayedCall(step.delay, () => this.advanceTutor('none'));
    }
  }

  private advanceTutor(trigger: 'revealed' | 'marked' | 'end' | 'none') {
    if (!this.tutorScript) return;
    const step = this.tutorScript[this.tutorIdx];
    if (!step) return;
    if (step.waitFor !== trigger) return;
    this.tutorIdx += 1;
    if (this.tutorIdx >= this.tutorScript.length) {
      // Last step consumed. Fade the tutor line away.
      this.clearTutorHighlight();
      this.chatterPulseTween?.stop();
      this.chatterPulseTween = undefined;
      this.tweens.add({
        targets: this.chatterFadeTargets(),
        alpha: 0,
        duration: 500,
      });
      return;
    }
    this.showTutorStep();
  }

  // During guided tutorial steps with a `target`, only the target tile accepts
  // the matching action. Returns true when the click should be blocked.
  private isTutorBlocked(x: number, y: number, kind: 'reveal' | 'mark'): boolean {
    if (!this.tutorScript) return false;
    const step = this.tutorScript[this.tutorIdx];
    if (!step || !step.target) return false;
    const expectReveal = step.waitFor === 'revealed';
    const expectMark = step.waitFor === 'marked';
    if (kind === 'reveal' && !expectReveal) return true;
    if (kind === 'mark' && !expectMark) return true;
    return step.target.x !== x || step.target.y !== y;
  }

  private showTutorHighlight(x: number, y: number) {
    // Same tile as previous beat — just redraw in case tileSize shifted, keep
    // the pulse phase going so the ring doesn't visibly blink on narration
    // advance.
    const samePosition =
      this.tutorTarget && this.tutorTarget.x === x && this.tutorTarget.y === y;
    this.tutorTarget = { x, y };
    if (!this.tutorHighlight) {
      this.tutorHighlight = this.add.graphics();
      // Above tile graphics (default depth 0) but below toast/HUD text.
      this.tutorHighlight.setDepth(500);
    }
    this.drawTutorHighlight();
    if (samePosition && this.tutorHighlightTween) return;
    this.tutorHighlightTween?.stop();
    this.tutorHighlight.setAlpha(1);
    this.tutorHighlightTween = this.tweens.add({
      targets: this.tutorHighlight,
      alpha: 0.35,
      duration: 600,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
    // Pulse-in shockwave: an expanding ring that fades out over half a second,
    // drawing the eye to the new hint location. Skipped when the target didn't
    // change (e.g., consecutive narration beats on the same tile) so the
    // shockwave doesn't fire repeatedly.
    this.spawnTutorHighlightBurst(x, y);
    audio.sfx('click');
  }

  private spawnTutorHighlightBurst(x: number, y: number) {
    const origin = this.boardOrigin();
    const s = this.tileSize;
    const cx = origin.x + x * (s + GAP) + s / 2;
    const cy = origin.y + y * (s + GAP) + s / 2;
    const burst = this.add.graphics();
    burst.setDepth(499);
    const startR = s * 0.6;
    const endR = s * 1.8;
    burst.setAlpha(0.9);
    this.tweens.addCounter({
      from: 0,
      to: 1,
      duration: 650,
      ease: 'Cubic.easeOut',
      onUpdate: (tw) => {
        const t = tw.getValue() as number;
        const r = startR + (endR - startR) * t;
        burst.clear();
        burst.lineStyle(3, 0xf4d04a, 1);
        burst.strokeCircle(cx, cy, r);
        burst.setAlpha(0.9 * (1 - t));
      },
      onComplete: () => burst.destroy(),
    });
  }

  private drawTutorHighlight() {
    if (!this.tutorHighlight || !this.tutorTarget) return;
    const origin = this.boardOrigin();
    const s = this.tileSize;
    const px = origin.x + this.tutorTarget.x * (s + GAP);
    const py = origin.y + this.tutorTarget.y * (s + GAP);
    const g = this.tutorHighlight;
    g.clear();
    g.lineStyle(4, 0xf4d04a, 1);
    g.strokeRoundedRect(px - 3, py - 3, s + 6, s + 6, 6);
    g.lineStyle(2, 0xffffff, 0.55);
    g.strokeRoundedRect(px + 1, py + 1, s - 2, s - 2, 4);
  }

  private clearTutorHighlight() {
    this.tutorTarget = undefined;
    this.tutorHighlightTween?.stop();
    this.tutorHighlightTween = undefined;
    this.tutorHighlight?.clear();
  }

  private sayMidMatch() {
    if (this.tutorScript) return; // tutor owns the chatter line in tutorial mode
    if (!this.champion || !this.chatterLine) return;
    const line = this.chatter.pick(this.champion.id, 'midMatch');
    if (line) this.showChatter(line);
  }

  private sayReaction() {
    if (this.tutorScript) return;
    if (!this.champion || !this.chatterLine) return;
    const line = this.chatter.pick(this.champion.id, 'reactions');
    if (line) this.showChatter(line);
  }

  private showChatter(line: string) {
    if (!this.chatterName || !this.chatterLine) return;
    this.chatterLine.setText(line);
    const fadeTargets = this.chatterFadeTargets();
    this.tweens.killTweensOf(fadeTargets);
    this.chatterName.setAlpha(0.9);
    this.chatterLine.setAlpha(1);
    this.chatterPortrait?.setAlpha(1);
    this.chatterPortraitBorder?.setAlpha(1);
    this.chatterPortraitBg?.setAlpha(1);
    this.startChatterPulse();
    this.chatterHideAt = this.time.now + 3400;
    // Push the next ambient line out so we don't immediately overwrite.
    this.nextMidMatchAt = Math.max(this.nextMidMatchAt, this.time.now + 9000);
  }

  private tickChatter(time: number) {
    if (!this.champion) return;
    if (this.chatterHideAt > 0 && time > this.chatterHideAt) {
      this.chatterHideAt = 0;
      this.chatterPulseTween?.stop();
      this.chatterPulseTween = undefined;
      this.tweens.add({
        targets: this.chatterFadeTargets(),
        alpha: 0,
        duration: 500,
        ease: 'Cubic.easeIn',
      });
    }
    if (this.state.status === 'playing' && time > this.nextMidMatchAt) {
      this.nextMidMatchAt = time + 12000 + Math.random() * 8000;
      this.sayMidMatch();
    }
  }

  private currentIsAi(): boolean {
    const t = this.playerTypes[this.state.currentPlayer];
    return !!t && t.kind === 'ai';
  }

  // Bucketed think-time distribution. Uniform random reads as robotic — real
  // people take varied pauses, mostly short but occasionally agonizing.
  // Breakdown: 20% snap decisions, 55% normal thought, 20% slow read, 5%
  // long pause. Smart AIs decide ~20% faster (they recognize the pattern
  // immediately); random AIs take ~20% longer (less confident, more stalling).
  private aiThinkDelay(difficulty: 'random' | 'smart'): number {
    const r = Math.random();
    let ms: number;
    if (r < 0.20)      ms = 300 + Math.random() * 400;   // snap: 300–700
    else if (r < 0.75) ms = 700 + Math.random() * 800;   // normal: 700–1500
    else if (r < 0.95) ms = 1500 + Math.random() * 1000; // slow: 1500–2500
    else               ms = 2500 + Math.random() * 1000; // long pause: 2500–3500
    const multiplier = difficulty === 'smart' ? 0.8 : 1.2;
    return Math.floor(ms * multiplier);
  }

  private maybeRunAiTurn() {
    if (this.state.status !== 'playing') return;
    if (!this.currentIsAi()) return;
    if (this.aiPending) return;
    this.aiPending = true;
    const t = this.playerTypes[this.state.currentPlayer];
    if (t.kind !== 'ai') return;
    const difficulty = t.difficulty;
    // After the first mark this turn, shorten the follow-up delay — the AI
    // is "continuing the same thought," not making a fresh decision.
    const baseDelay = this.aiThinkDelay(difficulty);
    let delay = this.aiMarksThisTurn > 0 ? Math.floor(baseDelay * 0.5) : baseDelay;
    // Marks don't reset the turn clock — the AI's entire think-mark-mark-reveal
    // chain has to fit inside turnSeconds or update() skips them. On big maps
    // with lots of forced cores (many candidate marks) this used to fire before
    // the AI ever committed a reveal. Clamp think delay to the remaining turn
    // budget so the AI always acts in time, and disallow further marking once
    // the budget no longer fits another think+reveal cycle.
    const BUFFER_MS = 250;     // network + render slack so the skip doesn't race the move
    const MIN_DELAY = 80;      // keep a beat of apparent thinking even under pressure
    const remaining = this.state.turnSeconds > 0
      ? Math.max(0, this.turnDeadline - this.time.now)
      : Infinity;
    if (remaining !== Infinity) {
      const budget = Math.max(MIN_DELAY, remaining - BUFFER_MS);
      delay = Math.min(delay, budget);
    }
    // Allow a mark only if we'd still have time left to think+reveal afterward.
    // Estimate: another ~baseDelay*0.5 + BUFFER for the follow-up action.
    const followUpEstimate = Math.floor(baseDelay * 0.5) + BUFFER_MS;
    const hasRoomForMark = remaining === Infinity || (remaining - delay) >= followUpEstimate;
    const allowMark = this.aiMarksThisTurn < 2 && hasRoomForMark;
    this.time.delayedCall(delay, () => {
      this.aiPending = false;
      if (this.state.status !== 'playing') return;
      if (!this.currentIsAi()) return;
      const move = aiMove(this.state, difficulty, { allowMark });
      if (move.kind === 'reveal') this.handleReveal(move.x, move.y);
      else if (move.kind === 'mark') this.handleMark(move.x, move.y);
      else this.handleTimeout();
    });
  }

  private handleTimeout() {
    const actor = this.state.currentPlayer;
    const prevPlayer = this.state.currentPlayer;
    const prevCritical = this.anyHumanCritical();
    this.state = skipTurn(this.state);
    this.commitTurnTime(actor);
    this.renderAll();
    this.resetTurnTimer();
    this.applyAudioTransitions(prevPlayer, prevCritical);
    if (this.state.status === 'ended') this.goToResult();
    else this.maybeRunAiTurn();
  }

  // On-chain event subscriptions. Reveals come from Revealed events — both
  // our own (echoed back after the CTX decrypts) and the opponent's. End-of-
  // match also fires through MatchEnded so we don't rely on local
  // safe-remaining derivation (unreliable with placeholder isCore values).
  private bindChainEvents() {
    if (!this.online?.chain) return;
    const { client, matchId } = this.online.chain;

    this.chainUnsubs.push(client.onRevealed(matchId, (ev) => {
      this.pendingMove = false;
      if (this.state.status !== 'playing') return;
      const prevPlayer = this.state.currentPlayer;
      const prevCritical = this.anyHumanCritical();
      this.state = applyChainReveal(this.state, ev.player, ev.x, ev.y, ev.wasCore, ev.adjacency);
      if (ev.wasCore) {
        audio.sfx('core-triggered');
        this.cameras.main.shake(220, 0.006);
        const hp = this.state.health[ev.player];
        const msg = hp === 0
          ? `💥 Player ${ev.player + 1} eliminated`
          : `💥 Core hit — P${ev.player + 1}: ${hp} HP`;
        this.flashToast(msg);
      } else if (ev.player === this.online?.mySeat) {
        audio.sfx('reveal-pop');
      }
      this.renderAll();
      this.applyAudioTransitions(prevPlayer, prevCritical);
      if (this.state.status === 'ended') this.goToResult();
    }));

    this.chainUnsubs.push(client.onMatchEnded(matchId, (ev) => {
      // Authoritative end signal from the contract (clean-board finish with
      // score comparison). HP-based ends already flipped status via applyChainReveal.
      if (this.state.status === 'ended') return;
      this.state = forceEnd(this.state, ev.winnerSeat);
      this.renderAll();
      this.goToResult();
    }));
  }

  // Subscribes MatchScene to room traffic. Replaces any listener the lobby
  // scene had attached (the room exposes a single-slot onEvent).
  private bindOnlineRoom() {
    if (!this.online) return;
    this.online.room.onEvent((ev) => {
      if (ev.type === 'move') {
        this.applyMove(ev.move);
      } else if (ev.type === 'opponent-left') {
        this.handleOpponentLeft();
      } else if (ev.type === 'error') {
        this.handleConnectionError(ev.message);
      }
    });
  }

  // Opponent dropped mid-match. Treat as a forfeit: local player wins by
  // default and the match transitions to the end banner with the forfeit
  // title. If the match had already ended naturally, just show a toast.
  private handleOpponentLeft() {
    if (!this.online) return;
    if (this.state.status === 'ended') {
      this.flashToast('Opponent disconnected');
      return;
    }
    this.forfeitReason = 'Opponent disconnected';
    this.state = { ...this.state, status: 'ended', winner: this.online.mySeat };
    this.renderAll();
    this.goToResult();
  }

  // Our own socket died (stale heartbeat, network drop, tab backgrounded
  // long enough to time out). Match is unrecoverable — show a dead-end modal
  // with a single Menu button.
  private handleConnectionError(message: string) {
    if (this.disconnectShown) return;
    // If the end banner is up, or a forfeit-triggered end is in flight (state
    // already flipped to 'ended' by handleOpponentLeft), the user already has
    // a Back-to-Menu exit — stacking a second modal is just noise.
    if (this.endBannerShown) return;
    if (this.state.status === 'ended') return;
    this.disconnectShown = true;
    this.showDisconnectModal(message);
  }

  private showDisconnectModal(message: string) {
    const { width, height } = this.scale;
    const DEPTH = 1100;
    // Dim the board so the user stops trying to interact with stale state.
    const dim = this.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.82)
      .setDepth(DEPTH)
      .setInteractive();
    dim.on('pointerdown', () => { /* swallow */ });
    this.add.rectangle(width / 2, height / 2, 380, 200, 0x12151f)
      .setStrokeStyle(2, 0xff6e6e)
      .setDepth(DEPTH + 1);
    addText(this, width / 2, height / 2 - 46, 'Connection Lost', {
      fontSize: '24px', color: '#ff9e9e', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(DEPTH + 2);
    addText(this, width / 2, height / 2 - 12, message || 'The match is over.', {
      fontSize: '14px', color: '#c0c7d6',
      wordWrap: { width: 340 }, align: 'center',
    }).setOrigin(0.5).setDepth(DEPTH + 2);
    const btnBg = this.add.rectangle(width / 2, height / 2 + 48, 200, 44, 0x2a6df4)
      .setStrokeStyle(2, 0x4f8bff)
      .setDepth(DEPTH + 1)
      .setInteractive({ useHandCursor: true });
    addText(this, width / 2, height / 2 + 48, 'Back to Menu', {
      fontSize: '15px', color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(DEPTH + 2);
    btnBg.on('pointerover', () => btnBg.setFillStyle(0x3b7bff));
    btnBg.on('pointerout', () => btnBg.setFillStyle(0x2a6df4));
    btnBg.on('pointerup', () => this.scene.start('Menu'));
  }

  // Single funnel for every state-mutating action. Online matches send over
  // the wire and wait for the echo to apply; local matches apply immediately.
  // This keeps reducer ordering identical on both clients.
  private dispatchMove(move: NetMove) {
    if (this.online) {
      if (this.pendingMove) return;
      this.pendingMove = true;
      this.online.room.sendMove(move);
    } else {
      this.applyMove(move);
    }
  }

  private applyMove(move: NetMove) {
    this.pendingMove = false;
    if (move.kind === 'reveal') this.applyReveal(move.x, move.y, move.elapsedMs);
    else if (move.kind === 'mark') this.applyMark(move.x, move.y);
    else if (move.kind === 'skip') this.applySkip();
  }

  // Timer-driven skip: penalty toast + fail SFX + turn advance. Separate from
  // handleTimeout (which is AI's own "pass"); that one is intentionally silent.
  private applySkip() {
    if (this.state.status !== 'playing') return;
    const who = this.state.currentPlayer;
    const humanTimedOut = this.playerTypes[who]?.kind === 'human';
    const prevPlayer = this.state.currentPlayer;
    const prevCritical = this.anyHumanCritical();
    this.state = skipTurn(this.state);
    this.commitTurnTime(who);
    const penalty = this.state.maxHealth > 0 ? ' — -1 HP' : '';
    this.flashToast(`Player ${who + 1} timed out${penalty}`);
    if (humanTimedOut) {
      audio.sfx('fail');
      this.sayReaction();
    }
    this.renderAll();
    this.resetTurnTimer();
    this.applyAudioTransitions(prevPlayer, prevCritical);
    if (this.state.status === 'ended') this.goToResult();
    else this.maybeRunAiTurn();
  }

  // Returns true when any still-alive human player is sitting at 1 HP with the
  // health system on. The "critical-last-breath" BGM swap hinges on this — we
  // want the heartbeat theme whenever the person at the keyboard is one mistake
  // from elimination, but NOT for AI opponents.
  private anyHumanCritical(): boolean {
    if (this.state.maxHealth <= 0) return false;
    for (let i = 0; i < this.playerTypes.length; i++) {
      if (this.playerTypes[i]?.kind !== 'human') continue;
      if (this.state.eliminated[i]) continue;
      if (this.state.health[i] === 1) return true;
    }
    return false;
  }

  // Call after every reducer application that can advance the turn. Handles
  // cross-cutting side effects: turn-switch SFX when currentPlayer changed,
  // BGM swap to/from critical-last-breath when a human crossed the 1-HP
  // threshold, and resetting the AI mark-per-turn counter so the next actor
  // starts fresh.
  private applyAudioTransitions(prevPlayer: number, prevCritical: boolean) {
    if (this.state.currentPlayer !== prevPlayer && this.state.status === 'playing') {
      audio.sfx('turn-switch');
      this.aiMarksThisTurn = 0;
    }
    const nowCritical = this.anyHumanCritical();
    if (nowCritical && !prevCritical) {
      audio.enterCritical();
    } else if (!nowCritical && prevCritical) {
      audio.exitCritical();
    }
  }

  update(time: number) {
    this.tickChatter(time);
    if (this.elapsedText && this.state.status === 'playing') {
      const sec = Math.max(0, Math.floor((time - this.matchStartedAt) / 1000));
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      this.elapsedText.setText(`${m}:${s.toString().padStart(2, '0')}`);
    }
    if (this.state.turnSeconds <= 0 || this.state.status !== 'playing') return;
    const remaining = Math.max(0, this.turnDeadline - time);
    const ratio = remaining / (this.state.turnSeconds * 1000);
    const isP0Turn = this.state.currentPlayer === 0;
    const lowTime = ratio < 0.3;
    const DIM = 0x3a3f55;

    if (this.timerLeftFg && this.timerLeftBg) {
      if (isP0Turn) {
        this.timerLeftFg.width = this.timerLeftBg.width * ratio;
        this.timerLeftFg.fillColor = lowTime ? 0xff6e6e : 0xf4a62a;
      } else {
        this.timerLeftFg.width = this.timerLeftBg.width;
        this.timerLeftFg.fillColor = DIM;
      }
    }
    if (this.timerRightFg && this.timerRightBg) {
      if (!isP0Turn) {
        this.timerRightFg.width = this.timerRightBg.width * ratio;
        const activeColor = PLAYER_COLORS[this.state.currentPlayer] ?? 0x6eb4ff;
        this.timerRightFg.fillColor = lowTime ? 0xff6e6e : activeColor;
        // Keep the right label in sync with whoever is currently acting.
        this.timerRightLabel?.setText(this.opponentLabel());
      } else {
        this.timerRightFg.width = this.timerRightBg.width;
        this.timerRightFg.fillColor = DIM;
      }
    }
    if (remaining <= 0) {
      const who = this.state.currentPlayer;
      // Online: only the actor whose clock ran out broadcasts the skip; every
      // other client waits for the echo. Timer clocks drift slightly between
      // clients, so letting all of them dispatch would produce duplicate skips.
      if (this.online && who !== this.online.mySeat) return;
      if (this.pendingMove) return;
      this.dispatchMove({ kind: 'skip' });
      return;
    }

    // Danger loop — only while a human is ticking down in the low-time band.
    const humanTicking = this.playerTypes[this.state.currentPlayer]?.kind === 'human';
    const shouldDanger =
      this.state.turnSeconds > 0 &&
      this.state.status === 'playing' &&
      humanTicking &&
      lowTime;
    if (shouldDanger && !this.lowTimeActive) {
      this.lowTimeActive = true;
      audio.startDangerLoop();
    } else if (!shouldDanger && this.lowTimeActive) {
      this.lowTimeActive = false;
      audio.stopDangerLoop();
    }
  }

  private resetTurnTimer() {
    this.turnDeadline = this.time.now + this.state.turnSeconds * 1000;
  }

  // Credit the elapsed wall time to `player` and reset the per-turn clock.
  // Called after any reducer that advances the turn, using the pre-advance
  // player index so time lands on whoever was actually thinking.
  private commitTurnTime(player: number) {
    const now = this.time.now;
    this.perPlayerMs[player] = (this.perPlayerMs[player] ?? 0) + (now - this.turnStartedAt);
    this.turnStartedAt = now;
  }

  private buildTimers() {
    const multi = this.playerTypes.length >= 2;
    const { barW, by } = this.timerGeometry();
    const leftX = 24;

    this.timerLeftLabel = addText(this, leftX, HUD_TIMER_LABEL_Y, 'YOU', {
      fontSize: '11px',
      color: '#f4a62a',
      fontStyle: 'bold',
    });
    this.timerLeftBg = this.add.rectangle(leftX, by, barW, 6, 0x2a2f44).setOrigin(0, 0.5);
    this.timerLeftFg = this.add.rectangle(leftX, by, barW, 6, 0xf4a62a).setOrigin(0, 0.5);

    if (multi) {
      const rightX = this.scale.width - 24 - barW;
      this.timerRightLabel = addText(this, rightX + barW, HUD_TIMER_LABEL_Y, this.opponentLabel(), {
        fontSize: '11px',
        color: '#6eb4ff',
        fontStyle: 'bold',
      }).setOrigin(1, 0);
      this.timerRightBg = this.add.rectangle(rightX, by, barW, 6, 0x2a2f44).setOrigin(0, 0.5);
      this.timerRightFg = this.add.rectangle(rightX, by, barW, 6, 0x3a3f55).setOrigin(0, 0.5);
    }
  }

  private timerGeometry(): { barW: number; by: number } {
    const narrow = isNarrow(this.scale.width);
    const multi = this.playerTypes.length >= 2;
    // Timer bar anchored at the constant HUD_TIMER_BAR_Y — sits below the
    // turn label and above the per-player score rows with no overlap.
    const by = HUD_TIMER_BAR_Y;
    // In vs mode, two bars share the width with a gap in the middle.
    // Solo gets a single wider bar hugging the left.
    const desktopW = multi ? 240 : 320;
    const narrowW = multi
      ? Math.min((this.scale.width - 60) / 2, 170)
      : Math.min(this.scale.width - 48, 240);
    return { barW: narrow ? narrowW : desktopW, by };
  }

  private opponentLabel(): string {
    const cp = this.state.currentPlayer;
    if (cp === 0) return 'OPPONENT';
    const champ = this.championForPlayer(cp);
    if (champ) return champ.name.toUpperCase();
    return `PLAYER ${cp + 1}`;
  }

  // Board top margin = bottom of the HUD score rows + a small buffer. Grows
  // with player count so 3+ player floors don't push score rows into tiles.
  private computeBoardMarginTop(): number {
    const narrow = isNarrow(this.scale.width);
    const base = narrow ? BOARD_MARGIN_TOP_NARROW : BOARD_MARGIN_TOP;
    const rows = this.playerTypes.length;
    const hudBottom = HUD_SCORES_START_Y + rows * HUD_ROW_HEIGHT + 12;
    return Math.max(base, hudBottom);
  }

  private computeTileSize(): number {
    const narrow = isNarrow(this.scale.width);
    const marginX = narrow ? BOARD_MARGIN_X_NARROW : BOARD_MARGIN_X;
    const marginTop = this.computeBoardMarginTop();
    const marginBottom = narrow ? BOARD_MARGIN_BOTTOM_NARROW : BOARD_MARGIN_BOTTOM;
    const tileMin = narrow ? TILE_MIN_NARROW : TILE_MIN;
    const availW = this.scale.width - marginX * 2;
    const availH = this.scale.height - marginTop - marginBottom;
    const byW = (availW - GAP * (this.state.width - 1)) / this.state.width;
    const byH = (availH - GAP * (this.state.height - 1)) / this.state.height;
    return Math.max(tileMin, Math.min(TILE_MAX, Math.floor(Math.min(byW, byH))));
  }

  private boardOrigin() {
    const marginTop = this.computeBoardMarginTop();
    const w = this.state.width * (this.tileSize + GAP) - GAP;
    return {
      x: Math.round((this.scale.width - w) / 2),
      y: marginTop,
    };
  }

  private handleResize() {
    if (!this.state) return;
    this.tileSize = this.computeTileSize();
    this.repositionHud();
    this.repositionTiles();
    this.repositionChatter();
    this.repositionSkipButton();
    this.repositionModeToggle();
    this.rescaleBackdrop();
    this.repositionMatchPortraits();
    this.applyNarrowLayout();
    this.renderAll();
    this.drawTutorHighlight();
  }

  private repositionMatchPortraits() {
    const geo = this.gutterGeometry();
    const { width, height } = this.scale;
    if (!geo) {
      // Viewport shrunk past the breakpoint — hide if present.
      this.mcMatchImg?.setVisible(false);
      this.championMatchImg?.setVisible(false);
      return;
    }
    if (this.mcMatchImg) {
      const tex = this.mcMatchImg.texture.getSourceImage() as HTMLImageElement;
      const scale = Math.min(geo.maxW / tex.width, geo.maxH / tex.height);
      this.mcMatchImg.setVisible(true)
        .setPosition(geo.gutter / 2, height / 2)
        .setScale(scale);
    }
    if (this.championMatchImg) {
      const tex = this.championMatchImg.texture.getSourceImage() as HTMLImageElement;
      const scale = Math.min(geo.maxW / tex.width, geo.maxH / tex.height);
      this.championMatchImg.setVisible(true)
        .setPosition(width - geo.gutter / 2, height / 2)
        .setScale(scale);
    }
  }

  private rescaleBackdrop() {
    if (!this.bgImage) return;
    const { width, height } = this.scale;
    const tex = this.bgImage.texture.getSourceImage() as HTMLImageElement;
    const scale = Math.max(width / tex.width, height / tex.height);
    this.bgImage.setPosition(width / 2, height / 2).setScale(scale);
    this.bgOverlay?.setSize(width, height);
  }

  private applyNarrowLayout() {
    const w = this.scale.width;
    const narrow = isNarrow(w);
    if (narrow) {
      this.hintLeftText
        ?.setText('Tap: reveal · Long-press: quarantine')
        .setOrigin(0, 0)
        .setPosition(24, 122)
        .setVisible(true);
      this.hintRightText?.setVisible(false);
      this.elapsedText?.setOrigin(1, 0).setPosition(w - 24, 20);
    } else {
      this.hintLeftText
        ?.setText('Left-click: reveal')
        .setOrigin(1, 0)
        .setPosition(w - 24, 20)
        .setVisible(true);
      this.hintRightText
        ?.setOrigin(1, 0)
        .setPosition(w - 24, 38)
        .setVisible(true);
      this.elapsedText?.setOrigin(1, 0).setPosition(w - 24, 60);
    }
  }

  private repositionHud() {
    const w = this.scale.width;
    const narrow = isNarrow(w);
    this.toastText.setPosition(w / 2, narrow ? 148 : 88);
    // Keep per-player rows anchored — resize otherwise strands them in stale
    // positions if the scene was laid out at a different width earlier.
    for (let i = 0; i < this.hudRows.length; i++) {
      this.hudRows[i].setPosition(24, HUD_SCORES_START_Y + i * HUD_ROW_HEIGHT);
    }
    this.turnText.setPosition(24, HUD_TURN_Y);
    if (this.timerLeftBg && this.timerLeftFg) {
      const { barW, by } = this.timerGeometry();
      const leftX = 24;
      this.timerLeftBg.setPosition(leftX, by);
      this.timerLeftBg.width = barW;
      this.timerLeftFg.setPosition(leftX, by);
      this.timerLeftLabel?.setPosition(leftX, HUD_TIMER_LABEL_Y);
      if (this.timerRightBg && this.timerRightFg) {
        const rightX = w - 24 - barW;
        this.timerRightBg.setPosition(rightX, by);
        this.timerRightBg.width = barW;
        this.timerRightFg.setPosition(rightX, by);
        this.timerRightLabel?.setPosition(rightX + barW, HUD_TIMER_LABEL_Y);
      }
      // fg.width is driven by update() every frame via the ratio, so no reset needed.
    }
  }

  private repositionTiles() {
    const origin = this.boardOrigin();
    for (let y = 0; y < this.state.height; y++) {
      for (let x = 0; x < this.state.width; x++) {
        const i = idx(x, y, this.state.width);
        const px = origin.x + x * (this.tileSize + GAP);
        const py = origin.y + y * (this.tileSize + GAP);
        this.tileGfx[i].setPosition(px, py);
        const hit = this.tileHitAreas[i];
        hit.setPosition(px + this.tileSize / 2, py + this.tileSize / 2);
        hit.setSize(this.tileSize, this.tileSize);
        const area = hit.input?.hitArea as Phaser.Geom.Rectangle | undefined;
        if (area) {
          area.width = this.tileSize;
          area.height = this.tileSize;
        }
        const lock = this.tileLockIcon[i];
        if (lock) {
          const cx = px + this.tileSize / 2;
          const cy = py + this.tileSize / 2;
          lock.setPosition(cx, cy);
          lock.setScale(Math.max(1, Math.round(this.tileSize * 0.45) / 16));
        }
        const core = this.tileCoreSprite[i];
        if (core) {
          core.setPosition(px + this.tileSize / 2, py + this.tileSize / 2);
          core.setScale((this.tileSize * 0.85) / 32);
        }
      }
    }
  }

  private repositionChatter() {
    if (!this.chatterName || !this.chatterLine) return;
    const x = 24;
    const narrow = isNarrow(this.scale.width);
    const size = narrow ? 64 : CHATTER_PORTRAIT_SIZE;
    const offset = narrow ? 180 : CHATTER_TEXT_OFFSET_FROM_BOTTOM;
    const y = this.scale.height - offset;
    const hasPortrait = !!this.chatterPortrait;
    const textX = narrow ? x : (hasPortrait ? x + size + 14 : x);
    this.chatterName.setPosition(textX, y);
    this.chatterLine.setPosition(textX, y + 18);
    const wrapPad = hasPortrait ? size + 14 : 0;
    this.chatterLine.setStyle({
      wordWrap: {
        width: narrow
          ? this.scale.width - 48
          : Math.min(560 - wrapPad, this.scale.width - 60 - wrapPad),
      },
    });
    if (hasPortrait) {
      const boxX = x;
      const boxY = narrow ? y - size - 10 : y - (size - 36);
      const cx = boxX + size / 2;
      // Resize bg + portrait in case we crossed the narrow/wide boundary
      // (rotation, window resize) — otherwise they'd stay at their original
      // dimensions and mismatch the border's redraw.
      this.chatterPortraitBg?.setPosition(cx, boxY + size / 2).setSize(size, size);
      if (this.chatterPortrait) {
        this.chatterPortrait.setPosition(cx, boxY);
        const tex = this.chatterPortrait.texture.getSourceImage() as HTMLImageElement;
        const cropSide = Math.min(tex.width, Math.round(tex.height * 0.5));
        this.chatterPortrait.setScale(size / cropSide);
      }
      if (this.chatterPortraitBorder) {
        const portraitId = this.tutorScript ? 'init0' : this.champion?.id;
        const color = (portraitId && CHARACTER_BORDER_COLORS[portraitId]) ?? 0x6eb4ff;
        const g = this.chatterPortraitBorder;
        g.clear();
        g.lineStyle(3, color, 1);
        g.strokeRect(boxX, boxY, size, size);
        g.lineStyle(1, 0xffffff, 0.25);
        g.strokeRect(boxX + 2, boxY + 2, size - 4, size - 4);
      }
    }
  }

  private repositionSkipButton() {
    if (!this.skipButtonBg || !this.skipButtonLabel) return;
    const { x, y } = this.skipButtonAnchor();
    this.skipButtonBg.setPosition(x, y);
    this.skipButtonLabel.setPosition(x - 80, y);
  }

  // FLAG-mode toggle. Only built on narrow layouts — desktop has right-click
  // so an on-screen toggle would just be visual noise there.
  private buildModeToggleButton() {
    if (!isNarrow(this.scale.width)) return;
    const { x, y } = this.modeToggleAnchor();
    this.modeToggleBg = this.add.rectangle(x, y, 96, 48, 0x1c2030)
      .setOrigin(0.5)
      .setStrokeStyle(2, 0x475172)
      .setInteractive({ useHandCursor: true })
      .setDepth(600);
    this.modeToggleLabel = addText(this, x, y, '⚑ FLAG', {
      fontSize: '14px',
      color: '#c8cfdc',
      fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(601);
    this.modeToggleBg.on('pointerdown', () => {
      this.setQuarantineMode(!this.quarantineMode);
    });
    this.updateModeToggleVisuals();
  }

  // Anchor: floats above the chatter block, right edge of the screen. 220px
  // above the bottom keeps it clear of the chatter portrait on narrow.
  private modeToggleAnchor(): { x: number; y: number } {
    const w = this.scale.width;
    const h = this.scale.height;
    return { x: w - 58, y: h - 220 };
  }

  private repositionModeToggle() {
    const narrow = isNarrow(this.scale.width);
    if (!narrow) {
      this.modeToggleBg?.setVisible(false);
      this.modeToggleLabel?.setVisible(false);
      return;
    }
    if (!this.modeToggleBg) {
      this.buildModeToggleButton();
      return;
    }
    this.modeToggleBg.setVisible(true);
    this.modeToggleLabel?.setVisible(true);
    const { x, y } = this.modeToggleAnchor();
    this.modeToggleBg.setPosition(x, y);
    this.modeToggleLabel?.setPosition(x, y);
  }

  private setQuarantineMode(on: boolean) {
    this.quarantineMode = on;
    haptic('selection');
    this.updateModeToggleVisuals();
  }

  private updateModeToggleVisuals() {
    if (!this.modeToggleBg || !this.modeToggleLabel) return;
    if (this.quarantineMode) {
      this.modeToggleBg.setFillStyle(0x7a2e2e).setStrokeStyle(2, 0xef5a3a);
      this.modeToggleLabel.setText('⚑ ON').setColor('#ffe1d6');
    } else {
      this.modeToggleBg.setFillStyle(0x1c2030).setStrokeStyle(2, 0x475172);
      this.modeToggleLabel.setText('⚑ FLAG').setColor('#c8cfdc');
    }
  }

  private buildBoard() {
    const origin = this.boardOrigin();
    for (let y = 0; y < this.state.height; y++) {
      for (let x = 0; x < this.state.width; x++) {
        const px = origin.x + x * (this.tileSize + GAP);
        const py = origin.y + y * (this.tileSize + GAP);

        const g = this.add.graphics();
        g.setPosition(px, py);
        this.tileGfx.push(g);
        this.tileText.push(null);
        this.tileLockIcon.push(null);
        this.tileCoreSprite.push(null);

        const hit = this.add.rectangle(
          px + this.tileSize / 2,
          py + this.tileSize / 2,
          this.tileSize,
          this.tileSize,
          0,
          0,
        );
        hit.setInteractive({ cursor: "url('/assets/cursors/probe.png') 8 8, pointer" });
        hit.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
          if (this.currentIsAi() || this.aiPending) return;
          if (this.online && this.state.currentPlayer !== this.online.mySeat) return;
          if (this.pendingMove) return;
          const ev = pointer.event as (PointerEvent | MouseEvent | undefined);
          const shift = !!(ev as MouseEvent | undefined)?.shiftKey;
          if (pointer.rightButtonDown() || shift) {
            this.handleMark(x, y);
            return;
          }
          // FLAG mode — any primary click/tap flags immediately. Checked BEFORE
          // the touch-vs-mouse branch so it works in the simulator (mouse) and
          // on physical touch devices equally.
          if (this.quarantineMode) {
            haptic('warning');
            this.handleMark(x, y);
            return;
          }
          // Touch detection — pointer.wasTouch is Phaser's normalized signal;
          // PointerEvent.pointerType is the native fallback. Either way, touch
          // goes into the tap/long-press path.
          const pWasTouch = (pointer as { wasTouch?: boolean }).wasTouch === true;
          const ptype = (ev as PointerEvent | undefined)?.pointerType;
          const isTouch = pWasTouch || ptype === 'touch' || ptype === 'pen';
          if (!isTouch) {
            this.handleReveal(x, y);
            return;
          }
          let resolved = false;
          const longPress = this.time.delayedCall(LONG_PRESS_MS, () => {
            if (resolved) return;
            resolved = true;
            // Threshold crossed — user held long enough for a flag. Buzz so
            // they feel the transition from "tap" to "hold" without having to
            // wait for the visual result.
            haptic('warning');
            this.handleMark(x, y);
          });
          const onUp = () => {
            if (resolved) return;
            resolved = true;
            longPress.remove();
            this.handleReveal(x, y);
          };
          const onCancel = () => {
            if (resolved) return;
            resolved = true;
            longPress.remove();
          };
          hit.once('pointerup', onUp);
          hit.once('pointerout', onCancel);
          hit.once('pointerupoutside', onCancel);
        });
        this.tileHitAreas.push(hit);
      }
    }
  }

  // Input entry point. Packages a NetMove and routes it through dispatchMove
  // so online and offline share the same path. In online mode, the local side
  // effects are deferred until the server echoes the move back. In chain mode
  // the reveal is a tx + BITE CTX; the Revealed event is what commits state.
  private handleReveal(x: number, y: number) {
    if (this.state.status !== 'playing') return;
    if (this.online && this.state.currentPlayer !== this.online.mySeat) return;
    if (this.pendingMove) return;
    if (this.isTutorBlocked(x, y, 'reveal')) {
      this.flashToast('INIT-0: Click the highlighted tile.');
      return;
    }

    if (this.online?.chain) {
      this.pendingMove = true;
      this.flashToast('Submitting reveal…');
      const { client, matchId } = this.online.chain;
      client.reveal(matchId, x, y).catch((err) => {
        console.error('[match] chain reveal failed', err);
        this.pendingMove = false;
        this.flashToast(`Reveal — ${friendlyTxError(err)}`);
      });
      return;
    }

    // DO / local path — reducer runs from echoed move.
    const elapsedMs = this.time.now - this.turnStartedAt;
    this.dispatchMove({ kind: 'reveal', x, y, elapsedMs });
  }

  private applyReveal(x: number, y: number, elapsedMs: number) {
    if (this.state.status !== 'playing') return;
    const actor = this.state.currentPlayer;
    const actorIsHuman = this.playerTypes[actor]?.kind === 'human';
    const prevPlayer = this.state.currentPlayer;
    const prevCritical = this.anyHumanCritical();
    const prevCombo = this.state.combos[actor] ?? 0;
    const result = reveal(this.state, x, y, elapsedMs);
    if (result.state === this.state) return;
    this.state = result.state;
    this.commitTurnTime(actor);
    if (result.violation === 'gentleman') {
      audio.sfx('fail');
      this.flashToast('Gentleman violation — opponents +1');
      if (actorIsHuman) this.sayReaction();
    } else if (result.violation === 'soreLoser') {
      audio.sfx('fail');
      this.flashToast('Sore loser — too safe; opponents +1');
      if (actorIsHuman) this.sayReaction();
    } else if (result.hitCore) {
      audio.sfx('core-triggered');
      // Small camera shake — sells the "corruption detonated" moment without
      // stealing enough frames to disrupt input or timer reads.
      this.cameras.main.shake(220, 0.006);
      // Portrait reaction — whoever hit the Core gets the red flash + shake.
      // Seat 0 = MC on the left; everyone else renders on the right.
      this.reactPortraitOnHit(actor === 0 ? 'mc' : 'champion');
      const hp = this.state.health[actor];
      const msg = this.state.maxHealth > 0
        ? (hp === 0 ? `💥 Player ${actor + 1} eliminated` : `💥 Core hit — P${actor + 1}: ${hp} HP left`)
        : '💥 Core hit';
      this.flashToast(msg);
      if (actorIsHuman) this.sayReaction();
    } else if (result.revealed.length > 1) {
      // Chain / flood-fill — more tiles cracked open in one click.
      audio.sfx('stabilize-pulse');
    } else if (result.revealed.length === 1) {
      audio.sfx('reveal-pop');
    }
    // Human combo flash — fires when a fast click actually extended the chain.
    // No toast if combo merely held (normal bucket) — that would be noise.
    if (actorIsHuman && result.combo > prevCombo && result.pointsAwarded > 0) {
      const mult = (1 + 0.2 * result.combo).toFixed(1);
      this.flashToast(`+${result.pointsAwarded} · combo ×${mult}`);
      audio.sfx('success');
    }
    this.renderAll();
    this.resetTurnTimer();
    this.applyAudioTransitions(prevPlayer, prevCritical);

    if (actorIsHuman) this.advanceTutor('revealed');

    if (this.state.status === 'ended') {
      this.advanceTutor('end');
      this.goToResult();
    } else {
      this.maybeRunAiTurn();
    }
  }

  private handleMark(x: number, y: number) {
    if (this.state.status !== 'playing') return;
    if (this.online && this.state.currentPlayer !== this.online.mySeat) return;
    // Marks have no contract counterpart — they're local UX. In ranked/chain
    // mode we disable them rather than letting them desync across clients.
    if (this.online?.chain) return;
    if (this.pendingMove) return;
    if (this.isTutorBlocked(x, y, 'mark')) {
      this.flashToast('INIT-0: Quarantine the highlighted tile.');
      return;
    }
    this.dispatchMove({ kind: 'mark', x, y });
  }

  private applyMark(x: number, y: number) {
    if (this.state.status !== 'playing') return;
    const actor = this.state.currentPlayer;
    const actorIsHuman = this.playerTypes[actor]?.kind === 'human';
    const result = mark(this.state, x, y);
    if (!result.changed) return;
    this.state = result.state;
    audio.sfx('click');
    // Marks no longer end the turn — don't commit turn time, don't reset the
    // turn timer, and don't fire turn-change audio transitions. The clock
    // keeps ticking for whoever's turn it actually is.
    // Track AI mark count on the actor's side so maybeRunAiTurn can cap it.
    if (!actorIsHuman) this.aiMarksThisTurn += 1;
    this.renderAll();
    if (actorIsHuman) this.advanceTutor('marked');
    // AI keeps going on the same turn until it commits a reveal / times out.
    this.maybeRunAiTurn();
  }

  private flashToast(msg: string) {
    this.toastText.setText(msg);
    this.toastText.setAlpha(1);
    this.tweens.add({
      targets: this.toastText,
      alpha: 0,
      duration: 1400,
      ease: 'Cubic.easeIn',
    });
  }

  private renderAll() {
    for (let y = 0; y < this.state.height; y++) {
      for (let x = 0; x < this.state.width; x++) {
        this.renderTile(x, y);
      }
    }
    this.renderHud();
  }

  private renderTile(x: number, y: number) {
    const i = idx(x, y, this.state.width);
    const cell = this.state.board[i];
    const g = this.tileGfx[i];
    const s = this.tileSize;
    g.clear();

    if (cell.state === 'revealed') {
      this.setTileLock(i, x, y, false);
      if (cell.isCore) {
        g.fillStyle(0x4a1722, 1);
        g.fillRoundedRect(0, 0, s, s, 4);
        g.lineStyle(1, 0x7a2a36, 1);
        g.strokeRoundedRect(0, 0, s, s, 4);
        this.clearTileLabel(i);
        this.setTileCoreSprite(i, x, y);
      } else {
        g.fillStyle(0x1c2030, 1);
        g.fillRoundedRect(0, 0, s, s, 4);
        g.lineStyle(1, 0x2a2f44, 1);
        g.strokeRoundedRect(0, 0, s, s, 4);
        this.clearTileCoreSprite(i);
        if (cell.adjacent > 0) {
          this.setTileLabel(i, x, y, String(cell.adjacent), {
            color: NUMBER_COLORS[cell.adjacent] ?? '#ffffff',
            fontSize: `${Math.round(s * 0.5)}px`,
            fontStyle: 'bold',
          });
        } else {
          this.clearTileLabel(i);
        }
      }
      return;
    }

    const ownerTint = cell.markedBy !== null ? PLAYER_COLORS[cell.markedBy] : null;
    g.fillStyle(0x2f3a55, 1);
    g.fillRoundedRect(0, 0, s, s, 4);
    g.lineStyle(1, 0x475172, 1);
    g.strokeRoundedRect(0, 0, s, s, 4);
    this.clearTileCoreSprite(i);

    if (cell.state === 'marked' && ownerTint !== null) {
      const pad = Math.max(6, Math.round(s * 0.2));
      g.fillStyle(ownerTint, 1);
      g.fillTriangle(pad, pad, pad, s - pad, s - pad, s / 2);
      this.clearTileLabel(i);
      this.setTileLock(i, x, y, false);
    } else {
      this.clearTileLabel(i);
      this.setTileLock(i, x, y, true);
    }
  }

  private setTileCoreSprite(i: number, x: number, y: number) {
    const origin = this.boardOrigin();
    const px = origin.x + x * (this.tileSize + GAP) + this.tileSize / 2;
    const py = origin.y + y * (this.tileSize + GAP) + this.tileSize / 2;
    const scale = (this.tileSize * 0.85) / 32;
    const existing = this.tileCoreSprite[i];
    if (existing) {
      existing.setPosition(px, py);
      existing.setScale(scale);
      return;
    }
    const spr = this.add.sprite(px, py, 'fx_nullcore', 0).setOrigin(0.5);
    spr.setScale(scale);
    spr.play('nullcore_spin');
    this.tileCoreSprite[i] = spr;
  }

  private clearTileCoreSprite(i: number) {
    const s = this.tileCoreSprite[i];
    if (s) {
      s.destroy();
      this.tileCoreSprite[i] = null;
    }
  }

  private setTileLock(i: number, x: number, y: number, visible: boolean) {
    let icon = this.tileLockIcon[i];
    if (!visible) {
      if (icon) {
        icon.destroy();
        this.tileLockIcon[i] = null;
      }
      return;
    }
    const origin = this.boardOrigin();
    const px = origin.x + x * (this.tileSize + GAP) + this.tileSize / 2;
    const py = origin.y + y * (this.tileSize + GAP) + this.tileSize / 2;
    const scale = Math.max(1, Math.round(this.tileSize * 0.45) / 16);
    if (!icon) {
      icon = this.add.image(px, py, 'icon_lock_closed')
        .setOrigin(0.5)
        .setAlpha(0.22)
        .setTint(0x9fb1d6);
      icon.setScale(scale);
      this.tileLockIcon[i] = icon;
    } else {
      icon.setPosition(px, py);
      icon.setScale(scale);
    }
  }

  private clearTileLabel(i: number) {
    const t = this.tileText[i];
    if (t) {
      t.destroy();
      this.tileText[i] = null;
    }
  }

  private setTileLabel(i: number, x: number, y: number, text: string, style: Phaser.Types.GameObjects.Text.TextStyle) {
    const origin = this.boardOrigin();
    const px = origin.x + x * (this.tileSize + GAP) + this.tileSize / 2;
    const py = origin.y + y * (this.tileSize + GAP) + this.tileSize / 2;
    const existing = this.tileText[i];
    if (existing) {
      existing.setText(text);
      existing.setStyle({ fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', ...style });
      existing.setPosition(px, py);
      return;
    }
    const t = addText(this, px, py, text, style).setOrigin(0.5);
    this.tileText[i] = t;
  }

  private renderHud() {
    // Portrait alpha + texture track current-player changes, so update them
    // alongside every HUD refresh (which fires on every state transition).
    this.updateMatchPortraits();
    const p = this.state.currentPlayer;
    const color = '#' + PLAYER_COLORS[p].toString(16).padStart(6, '0');
    const label = this.online
      ? (p === this.online.mySeat ? 'Your turn' : "Opponent's turn")
      : `Turn: Player ${p + 1}`;
    this.turnText.setText(label);
    this.turnText.setColor(color);
    // Per-player row: one line each, colored by seat. Active seat gets a ▸
    // prefix so the turn owner is clear at a glance — useful when there are
    // more than two players and the big `Turn: Player N` label is one of
    // several things competing for attention.
    for (let i = 0; i < this.hudRows.length; i++) {
      const row = this.hudRows[i];
      const s = this.state.scores[i] ?? 0;
      const hearts = this.renderHearts(i);
      const combo = this.state.combos[i] ?? 0;
      const comboTag = combo > 0 ? `  ×${(1 + 0.2 * combo).toFixed(1)}` : '';
      const active = i === p ? '▸ ' : '  ';
      const elim = this.state.eliminated[i] ? '  [out]' : '';
      row.setText(`${active}P${i + 1}  ${s}pt  ${hearts}${comboTag}${elim}`);
      // Dim eliminated players so the active roster stays visually prioritized.
      row.setAlpha(this.state.eliminated[i] ? 0.45 : 1);
    }
  }

  private renderHearts(playerIdx: number): string {
    if (this.state.maxHealth <= 0) return '';
    const hp = this.state.health[playerIdx];
    // Per-player ceiling so a champion buffed to 10 HP shows 10 hearts and
    // the human at 3 HP shows 3 — not a 3/10-looking row that implies the
    // human is already mostly dead.
    const max = this.state.startingHealth[playerIdx] ?? this.state.maxHealth;
    const full = '♥'.repeat(hp);
    const empty = '♡'.repeat(Math.max(0, max - hp));
    return full + empty;
  }

  private goToResult() {
    // Play the outcome sting immediately — waiting for the banner makes the
    // audio feel detached from the ending reveal. Then silence everything so
    // the banner (and the scene that follows it) get a clean slate.
    // In online matches the local player is at mySeat, not necessarily seat 0.
    const localSeat = this.online?.mySeat ?? 0;
    const humanWon = this.state.winner === localSeat;
    audio.sfx(humanWon ? 'win' : 'lose');
    audio.silenceAll(1000);
    // Show end banner after a brief pause so the final reveal registers visually.
    this.time.delayedCall(500, () => this.showEndBanner());
  }

  private formatMs(ms: number): string {
    const totalSec = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  private playerDisplayName(i: number): string {
    if (this.online) return i === this.online.mySeat ? 'You' : 'Opponent';
    if (i === 0) return 'You';
    const champ = this.championForPlayer(i);
    if (champ) return champ.name;
    return `P${i + 1}`;
  }

  private renderEndStats(cx: number, topY: number, panelW: number, depth: number) {
    const rowW = Math.min(440, panelW - 48);
    const left = cx - rowW / 2;
    const rowH = 22;

    // Header row — column labels.
    const cols: Array<[string, number]> = [
      ['Player', 0],
      ['Pts',    rowW * 0.46],
      ['Acc',    rowW * 0.64],
      ['Time',   rowW * 0.86],
    ];
    for (const [label, dx] of cols) {
      addText(this, left + dx, topY, label, {
        fontSize: '11px',
        color: '#4a5063',
        fontStyle: 'bold',
      }).setDepth(depth);
    }

    const players = this.playerTypes.length;
    for (let i = 0; i < players; i++) {
      const rowY = topY + 18 + i * rowH;
      const color = '#' + PLAYER_COLORS[i].toString(16).padStart(6, '0');
      const placed = this.state.markersPlaced[i] ?? 0;
      const correct = this.state.markersCorrect[i] ?? 0;
      const accPct = placed === 0 ? '—' : `${Math.round((correct / placed) * 100)}%`;
      const timeStr = this.formatMs(this.perPlayerMs[i] ?? 0);

      addText(this, left + cols[0][1], rowY, this.playerDisplayName(i), {
        fontSize: '14px', color, fontStyle: 'bold',
      }).setDepth(depth);
      addText(this, left + cols[1][1], rowY, String(this.state.scores[i] ?? 0), {
        fontSize: '14px', color: '#e8ecf1',
      }).setDepth(depth);
      addText(this, left + cols[2][1], rowY, accPct, {
        fontSize: '14px', color: '#c0c7d6',
      }).setDepth(depth);
      addText(this, left + cols[3][1], rowY, timeStr, {
        fontSize: '14px', color: '#c0c7d6',
      }).setDepth(depth);
    }
  }

  private buildEndTitle(): { title: string; sub: string } {
    // Forfeit overrides the natural-end copy — in that case we don't want
    // "Floor Cleared" since the score wasn't actually decisive.
    if (this.forfeitReason) {
      return {
        title: 'Opponent Forfeit',
        sub: `${this.forfeitReason} — you win by default.`,
      };
    }
    const scores = this.state.scores;
    // "Local seat" is the arcade human at 0 or the online player's assigned
    // seat. Every "did I win" / "was I eliminated" check must be relative to
    // this, not hardcoded to slot 0.
    const localSeat = this.online?.mySeat ?? 0;
    const humanEliminated = this.state.eliminated[localSeat];
    const solo = this.playerTypes.length === 1;
    const humanWon = this.state.winner === localSeat || (solo && !humanEliminated);
    const scoreLine = `Score: ${scores.map((s, i) => `P${i + 1} ${s}`).join('  ·  ')}`;

    const opponentsEliminated =
      !solo && this.state.eliminated.every((e, i) => i === localSeat || e);

    if (humanEliminated) {
      const sub = this.tutorScript
        ? 'You hit too many Corruption Cores. Give it another go.'
        : `Out of health — eliminated. ${scoreLine}`;
      return { title: 'Floor Failed', sub };
    }
    if (this.tutorScript) {
      return { title: 'Tutorial Complete', sub: 'Controls calibrated.' };
    }
    if (solo) {
      return { title: 'Floor Cleared', sub: `Board cleared. ${scoreLine}` };
    }
    if (opponentsEliminated) {
      return {
        title: 'Floor Cleared',
        sub: `All opponents eliminated. ${scoreLine}`,
      };
    }
    if (humanWon) {
      return { title: 'Floor Cleared', sub: `Highest score wins. ${scoreLine}` };
    }
    return { title: 'Floor Failed', sub: `Opponent outscored you. ${scoreLine}` };
  }

  private showEndBanner() {
    console.log('[trace] MatchScene.showEndBanner', {
      status: this.state.status,
      winner: this.state.winner,
      tutor: !!this.tutorScript,
      floor: this.floorLabel,
    });
    if (this.endBannerShown) return;
    // Defensive: never show the end banner unless the reducer actually put the
    // match into 'ended'. A stray delayedCall or race condition must not pop
    // this screen mid-match.
    if (this.state.status !== 'ended') return;
    // Belt-and-suspenders: if somehow the match "ended" in the first 500ms
    // after mount, that can't be from real play — it's a bleed-through event.
    // Refuse to fire and log so we can see it in devtools.
    if (this.time.now - this.matchStartedAt < 500) {
      console.warn('[Match] suppressed banner — fired too soon after mount', {
        status: this.state.status,
        winner: this.state.winner,
        health: this.state.health,
        eliminated: this.state.eliminated,
        scores: this.state.scores,
        msSinceMount: this.time.now - this.matchStartedAt,
      });
      return;
    }
    this.endBannerShown = true;

    // Hide the tutor skip button and fade chatter — the banner takes focus.
    this.skipButtonBg?.setVisible(false);
    this.skipButtonLabel?.setVisible(false);
    if (this.chatterName && this.chatterLine) {
      const fadeTargets = this.chatterFadeTargets();
      this.tweens.killTweensOf(fadeTargets);
      for (const t of fadeTargets) (t as unknown as Phaser.GameObjects.Components.Alpha).setAlpha(0);
    }

    const { width, height } = this.scale;
    const { title, sub } = this.buildEndTitle();
    const isFail = title === 'Floor Failed';
    const DEPTH = 1000;

    // Full-screen dim. Made interactive so clicks on the empty area don't
    // bleed through to the board beneath (stops tile hover/click leaks).
    const dim = this.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.72)
      .setDepth(DEPTH)
      .setInteractive();
    dim.on('pointerdown', () => { /* swallow */ });

    const panelW = Math.min(520, width - 40);
    // Stretch panel when we have stats to show so everything fits.
    const showStats = this.state.maxHealth >= 0 && this.perPlayerMs.length > 0;
    const panelH = showStats ? 340 : 280;
    this.add.rectangle(width / 2, height / 2, panelW, panelH, 0x12151f)
      .setStrokeStyle(2, isFail ? 0xff6e6e : 0x2a6df4)
      .setDepth(DEPTH + 1);
    const titleY = height / 2 - (showStats ? 120 : 80);
    addText(this, width / 2, titleY, title, {
      fontSize: '36px',
      color: isFail ? '#ff9e9e' : '#e8ecf1',
      fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(DEPTH + 2);
    addText(this, width / 2, titleY + 48, sub, {
      fontSize: '16px',
      color: '#7c8497',
      wordWrap: { width: panelW - 60 },
      align: 'center',
    }).setOrigin(0.5).setDepth(DEPTH + 2);

    if (showStats) this.renderEndStats(width / 2, titleY + 92, panelW, DEPTH + 2);
    // Silence the unused-locals linter — dim is kept around to hold interactivity.
    void dim;

    // Primary and secondary buttons. Labels depend on outcome.
    // Retry can't be coordinated across clients without extra DO work, so
    // online matches collapse to a single primary button and wire Enter-only.
    const primaryLabel = this.online
      ? 'Back to Menu'
      : (isFail ? 'Abort Run' : 'Continue');
    const secondaryLabel = this.tutorScript ? 'Retry Tutorial' : 'Retry Floor';

    const btnW = 180;
    const btnH = 48;
    const gap = 16;
    const baseY = height / 2 + 58;
    const primaryX = this.online ? width / 2 : width / 2 - btnW / 2 - gap / 2;
    const rightX = width / 2 + btnW / 2 + gap / 2;

    const primaryBg = this.add.rectangle(primaryX, baseY, btnW, btnH, isFail ? 0x3a3f55 : 0x2a6df4)
      .setStrokeStyle(2, isFail ? 0x606680 : 0x4f8bff)
      .setDepth(DEPTH + 3)
      .setInteractive({ useHandCursor: true });
    addText(this, primaryX, baseY, primaryLabel, {
      fontSize: '16px',
      color: '#ffffff',
      fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(DEPTH + 4);
    primaryBg.on('pointerover', () => primaryBg.setFillStyle(isFail ? 0x474d68 : 0x3b7bff));
    primaryBg.on('pointerout', () => primaryBg.setFillStyle(isFail ? 0x3a3f55 : 0x2a6df4));
    primaryBg.on('pointerup', () => {
      // Always route through finalizeMatch so the parent scene (arcade) can
      // decide what happens on loss (e.g. play a champion loss monologue
      // before returning to menu). finalizeMatch calls onComplete with the
      // full result, including winner=null for losses.
      this.finalizeMatch();
    });

    if (!this.online) {
      const retryBg = this.add.rectangle(rightX, baseY, btnW, btnH, 0x1c2030)
        .setStrokeStyle(1, 0x475172)
        .setDepth(DEPTH + 3)
        .setInteractive({ useHandCursor: true });
      addText(this, rightX, baseY, secondaryLabel, {
        fontSize: '16px',
        color: '#c8cfdc',
      }).setOrigin(0.5).setDepth(DEPTH + 4);
      retryBg.on('pointerover', () => retryBg.setFillStyle(0x252b3f));
      retryBg.on('pointerout', () => retryBg.setFillStyle(0x1c2030));
      retryBg.on('pointerup', () => this.retryMatch());
    }

    // Keyboard shortcuts, but only after a short lockout so a key held down
    // from the previous scene (which may fire a "keydown" as soon as this
    // scene's keyboard plugin activates) can't instantly dismiss the banner.
    const bannerArmAt = this.time.now + 500;
    this.input.keyboard?.once('keydown-ENTER', () => {
      if (this.time.now < bannerArmAt) return;
      this.finalizeMatch();
    });
    if (!this.online) {
      this.input.keyboard?.once('keydown-R', () => {
        if (this.time.now < bannerArmAt) return;
        this.retryMatch();
      });
    }
  }

  private finalizeMatch() {
    // Only advance out of the match if the match actually ended. Blocks stray
    // keyboard events (held Enter from a previous scene) from short-circuiting
    // a live game and handing a phantom "win" to the arcade flow.
    console.log('[trace] MatchScene.finalizeMatch', {
      status: this.state.status,
      winner: this.state.winner,
      scores: this.state.scores,
      endBannerShown: this.endBannerShown,
      tutor: !!this.tutorScript,
      floor: this.floorLabel,
    });
    if (this.state.status !== 'ended') return;
    if (!this.endBannerShown) return;
    // Online matches don't have an arcade-flow onComplete; go straight to the
    // main menu. SHUTDOWN closes the room for us.
    if (this.online) {
      this.scene.start('Menu');
      return;
    }
    const result = { scores: this.state.scores, winner: this.state.winner };
    const next = this.onComplete
      ? this.onComplete(result)
      : { scene: 'Result', data: result };
    this.scene.start(next.scene, next.data as object | undefined);
  }

  private skipTutorial() {
    const next = this.onTutorSkip?.() ?? { scene: 'Menu' };
    this.scene.start(next.scene, next.data as object | undefined);
  }

  private retryMatch() {
    if (!this.createData) {
      this.scene.restart();
      return;
    }
    // Tutorial uses a deterministic seed so the retry board matches the script —
    // don't reseed it. Everything else gets a fresh seed for a new layout.
    const newConfig: MatchConfig = this.tutorScript
      ? this.createData.config
      : { ...this.createData.config, seed: Math.floor(Math.random() * 0xffffffff) };
    this.scene.restart({ ...this.createData, config: newConfig });
  }
}
