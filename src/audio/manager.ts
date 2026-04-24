import * as Phaser from 'phaser';

// Canonical list — mirrors scripts/sfx-manifest.ts. Adding a new SFX means
// appending to the manifest AND this array.
export const SFX_IDS = [
  'click',
  'success',
  'fail',
  'danger',
  'core-triggered',
  'win',
  'lose',
  'reveal-pop',
  'stabilize-pulse',
  'turn-switch',
] as const;
export type SfxId = (typeof SFX_IDS)[number];

// Canonical list — mirrors scripts/bgm-manifest.ts.
export const BGM_IDS = [
  'menu-quiet-invitation',
  'system-awakening',
  'stage1-still-water',
  'stage2-flow',
  'fail-fading-signal',
  'retry-return',
  'trace-calculated-path',
  'glitch-fractured-rhythm',
  'proof-perfect-form',
  'fork-rising-pressure',
  'patch-cracks-in-silence',
  'root-authority',
  'engineer-beyond-form',
  'engineer-villain-battle',
  'critical-last-breath',
  'victory-fanfare',
] as const;
export type BgmId = (typeof BGM_IDS)[number];

// Mirrors `Champion.id` values in src/state/arcade.ts.
export type ChampionKey =
  | 'iris'
  | 'trace'
  | 'glitch'
  | 'proof'
  | 'fork'
  | 'patch'
  | 'root'
  | 'engineer';

export function championBgm(id: ChampionKey): BgmId {
  switch (id) {
    case 'iris':
      return 'stage1-still-water';
    case 'trace':
      return 'trace-calculated-path';
    case 'glitch':
      return 'glitch-fractured-rhythm';
    case 'proof':
      return 'proof-perfect-form';
    case 'fork':
      return 'fork-rising-pressure';
    case 'patch':
      return 'patch-cracks-in-silence';
    case 'root':
      return 'root-authority';
    case 'engineer':
      // The battle itself — menacing boss theme. The post-defeat monologue
      // and NARRATOR_ENDGAME use `engineer-beyond-form` separately (that
      // track's "vast empty" vibe fits the reveal, not the fight).
      return 'engineer-villain-battle';
  }
}

// Per-SFX volume trim. The raw mp3s don't come out loudness-matched, so some
// cues need attenuation (danger loops under gameplay, win/lose over the end
// banner). Missing entries default to 1.0.
const SFX_BASE_VOLUME: Partial<Record<SfxId, number>> = {
  'core-triggered': 0.9,
  danger: 0.35,
  win: 1.0,
  lose: 0.8,
  click: 0.6,
  'reveal-pop': 0.7,
  'stabilize-pulse': 0.8,
  'turn-switch': 0.6,
  fail: 0.7,
  success: 0.85,
};

// Typed view onto a Phaser sound with the mutable volume property the tween
// animates. BaseSound has it at runtime but the TS type is abstract.
type MutableSound = Phaser.Sound.BaseSound & { volume: number };

// How much of the track's tail we overlap with the next instance when looping.
// MP3s carry encoder-delay silence at the head of every file, so Phaser's
// native `loop: true` audibly gaps at every loop boundary. Instead we schedule
// a second instance to start `BGM_CROSSFADE_MS` before the current one ends
// and ramp volumes across the overlap — the mix masks the silence.
const BGM_CROSSFADE_MS = 900;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

// localStorage is unavailable in some WebView contexts (private mode, etc.) —
// wrap both read and write so the app still runs if storage throws.
function loadGain(key: string, fallback: number): number {
  try {
    const raw = window.localStorage?.getItem(key);
    if (raw === null || raw === undefined) return fallback;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? clamp01(n) : fallback;
  } catch {
    return fallback;
  }
}

function persistGain(key: string, value: number): void {
  try {
    window.localStorage?.setItem(key, String(value));
  } catch {
    // ignore
  }
}

class AudioManager {
  private game: Phaser.Game | null = null;
  private currentBgm: MutableSound | null = null;
  private currentBgmKey: BgmId | null = null;
  // Crossfade timer handle. Uses setTimeout (game-lifetime) rather than a
  // scene-scoped Phaser timer so a mid-track scene transition (e.g. clearing
  // a dialogue into a match) doesn't cancel the pending loop crossfade.
  private bgmLoopTimer: number | null = null;
  private preCriticalKey: BgmId | null = null;
  private dangerLoop: MutableSound | null = null;

  // Engine-baseline mix. BGM sits under SFX by a healthy margin so dialogue/SFX
  // cut through without me duck-mixing per event.
  private readonly bgmBase = 0.4;
  private readonly sfxBase = 0.7;

  // User-adjustable gain multipliers from the Settings scene. Persisted to
  // localStorage so preferences survive reloads. Multiply into the base mix
  // (bgmBase * bgmGain * masterGain for music, etc.) so "default" (1.0) keeps
  // the old behavior and users can trim independently.
  private masterGain = loadGain('cs:vol:master', 1);
  private bgmGain = loadGain('cs:vol:bgm', 1);
  private sfxGain = loadGain('cs:vol:sfx', 1);

  // Effective volume multipliers used by the playback paths. Kept as methods
  // rather than getters so tests can mock them cleanly.
  private get bgmVolume(): number { return this.bgmBase * this.bgmGain * this.masterGain; }
  private get sfxVolume(): number { return this.sfxBase * this.sfxGain * this.masterGain; }

  getMasterGain(): number { return this.masterGain; }
  getBgmGain(): number { return this.bgmGain; }
  getSfxGain(): number { return this.sfxGain; }

  setMasterGain(v: number): void {
    this.masterGain = clamp01(v);
    persistGain('cs:vol:master', this.masterGain);
    this.applyRunningVolumes();
  }
  setBgmGain(v: number): void {
    this.bgmGain = clamp01(v);
    persistGain('cs:vol:bgm', this.bgmGain);
    this.applyRunningVolumes();
  }
  setSfxGain(v: number): void {
    this.sfxGain = clamp01(v);
    persistGain('cs:vol:sfx', this.sfxGain);
    this.applyRunningVolumes();
  }

  // Push the current effective volumes onto any sounds currently playing. SFX
  // one-shots are already gone by the time you slide, but BGM and the danger
  // loop are long-lived and need to reflect the new mix immediately.
  private applyRunningVolumes(): void {
    if (this.currentBgm) {
      (this.currentBgm as unknown as { volume: number }).volume = this.bgmVolume;
    }
    if (this.dangerLoop) {
      const base = SFX_BASE_VOLUME.danger ?? 0.35;
      (this.dangerLoop as unknown as { volume: number }).volume = base * this.sfxVolume;
    }
  }

  init(game: Phaser.Game): void {
    this.game = game;
  }

  preloadAll(scene: Phaser.Scene): void {
    for (const id of SFX_IDS) {
      scene.load.audio(`sfx:${id}`, `assets/audio/sfx/${id}.mp3`);
    }
    for (const id of BGM_IDS) {
      scene.load.audio(`bgm:${id}`, `assets/audio/bgm/${id}.mp3`);
    }
  }

  sfx(id: SfxId, opts: { volume?: number } = {}): void {
    const mgr = this.soundManager();
    if (!mgr) return;
    const base = SFX_BASE_VOLUME[id] ?? 1;
    const volume = (opts.volume ?? 1) * base * this.sfxVolume;
    mgr.play(`sfx:${id}`, { volume });
  }

  playBgm(id: BgmId, opts: { fadeMs?: number; volume?: number; maxDurationMs?: number } = {}): void {
    if (this.currentBgmKey === id && this.currentBgm?.isPlaying) return;
    const mgr = this.soundManager();
    if (!mgr) return;
    const fadeMs = opts.fadeMs ?? 800;
    const target = (opts.volume ?? 1) * this.bgmVolume;
    this.stopBgm(fadeMs);
    // Handle looping manually via crossfade rather than `loop: true` — see
    // BGM_CROSSFADE_MS comment for why.
    const next = mgr.add(`bgm:${id}`, { loop: false, volume: 0 }) as MutableSound;
    next.play();
    this.fadeSound(next, target, fadeMs);
    this.currentBgm = next;
    this.currentBgmKey = id;
    if (opts.maxDurationMs && opts.maxDurationMs > 0) {
      // One-shot playback — no crossfade loop. Schedule a fade-out that
      // lands right at `maxDurationMs` so short cues (victory fanfare) don't
      // run past their welcome, and overlap with the next BGM is eliminated.
      const fadeOutMs = Math.min(600, Math.max(200, opts.maxDurationMs / 4));
      const fireAt = Math.max(0, opts.maxDurationMs - fadeOutMs);
      this.bgmLoopTimer = window.setTimeout(() => {
        this.bgmLoopTimer = null;
        if (this.currentBgm !== next || this.currentBgmKey !== id) return;
        this.stopBgm(fadeOutMs);
      }, fireAt);
    } else {
      this.scheduleBgmCrossfade(next, id, target);
    }
  }

  // Schedule the crossfade into the next loop. Runs `BGM_CROSSFADE_MS` before
  // the current track ends; spawns a fresh instance at volume 0, ramps it up
  // as the old instance ramps down, then chains its own crossfade.
  private scheduleBgmCrossfade(sound: MutableSound, id: BgmId, target: number): void {
    this.cancelBgmLoopTimer();
    // `sound.duration` is in seconds and is accurate once the audio is
    // decoded (our preload step guarantees that by the time this fires).
    const durMs = sound.duration * 1000;
    // Guard: some browsers report 0 before the audio context resumes. Skip
    // scheduling rather than spawning a runaway crossfade chain.
    if (!isFinite(durMs) || durMs <= BGM_CROSSFADE_MS + 200) return;
    const fireInMs = durMs - BGM_CROSSFADE_MS;
    this.bgmLoopTimer = window.setTimeout(() => {
      this.bgmLoopTimer = null;
      // Cancel the chain if BGM was stopped or swapped while we were waiting.
      if (this.currentBgm !== sound || this.currentBgmKey !== id) return;
      const mgr = this.soundManager();
      if (!mgr) return;
      const next = mgr.add(`bgm:${id}`, { loop: false, volume: 0 }) as MutableSound;
      next.play();
      this.fadeSound(next, target, BGM_CROSSFADE_MS);
      this.fadeSound(sound, 0, BGM_CROSSFADE_MS, () => {
        sound.stop();
        sound.destroy();
      });
      this.currentBgm = next;
      this.scheduleBgmCrossfade(next, id, target);
    }, fireInMs);
  }

  private cancelBgmLoopTimer(): void {
    if (this.bgmLoopTimer !== null) {
      window.clearTimeout(this.bgmLoopTimer);
      this.bgmLoopTimer = null;
    }
  }

  stopBgm(fadeMs = 400): void {
    this.cancelBgmLoopTimer();
    const snd = this.currentBgm;
    if (!snd) return;
    this.currentBgm = null;
    this.currentBgmKey = null;
    this.fadeSound(snd, 0, fadeMs, () => {
      snd.stop();
      snd.destroy();
    });
  }

  // Swap BGM → critical-last-breath, remembering the prior track so
  // exitCritical() can restore it. No-op if already in critical mode.
  enterCritical(): void {
    if (this.currentBgmKey === 'critical-last-breath') return;
    this.preCriticalKey = this.currentBgmKey;
    this.playBgm('critical-last-breath', { fadeMs: 600 });
  }

  exitCritical(): void {
    if (this.currentBgmKey !== 'critical-last-breath') return;
    const prev = this.preCriticalKey;
    this.preCriticalKey = null;
    if (prev) this.playBgm(prev, { fadeMs: 600 });
    else this.stopBgm(600);
  }

  startDangerLoop(): void {
    if (this.dangerLoop?.isPlaying) return;
    const mgr = this.soundManager();
    if (!mgr) return;
    const base = SFX_BASE_VOLUME.danger ?? 0.35;
    this.dangerLoop = mgr.add('sfx:danger', {
      loop: true,
      volume: base * this.sfxVolume,
    }) as MutableSound;
    this.dangerLoop.play();
  }

  stopDangerLoop(): void {
    const snd = this.dangerLoop;
    if (!snd) return;
    this.dangerLoop = null;
    snd.stop();
    snd.destroy();
  }

  // Wipe all audio state — used on scene transitions that should guarantee
  // silence (match shutdown before a VN monologue, for example).
  silenceAll(fadeMs = 400): void {
    this.stopBgm(fadeMs);
    this.stopDangerLoop();
    this.preCriticalKey = null;
  }

  private soundManager(): Phaser.Sound.BaseSoundManager | null {
    return this.game?.sound ?? null;
  }

  // Scene-independent volume ramp. Original implementation used Phaser's
  // scene.tweens; fine in steady state, but during a scene transition the
  // active scene dies mid-fade and the tween (plus its onComplete that was
  // supposed to stop/destroy the sound) is killed. Result: the sound keeps
  // playing forever at partial volume. setInterval runs off the game loop
  // and survives scene swaps, so fades — and the stop/destroy callbacks
  // that hang off them — always finish.
  private fadeSound(
    sound: MutableSound,
    to: number,
    ms: number,
    onComplete?: () => void,
  ): void {
    if (ms <= 0 || !isFinite(ms)) {
      sound.volume = to;
      onComplete?.();
      return;
    }
    const from = sound.volume;
    const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const timer = window.setInterval(() => {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const t = Math.min(1, (now - start) / ms);
      sound.volume = from + (to - from) * t;
      if (t >= 1) {
        window.clearInterval(timer);
        onComplete?.();
      }
    }, 16);
  }
}

export const audio = new AudioManager();
