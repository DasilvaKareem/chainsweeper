import * as Phaser from 'phaser';
import {
  arcadeRun,
  ARCADE_LEVELS,
  CHAMPION_HEALTH,
  CHARACTER_CLASH,
  CHARACTER_POST_LOSS,
  CHARACTER_POST_WIN,
  NARRATOR_BEFORE,
  NARRATOR_ENDGAME,
  NARRATOR_FINAL,
  dialogueIntroBeats,
  dialogueSpeaker,
  type ArcadeLevel,
  type Champion,
  type NarratorBeat,
} from '../state/arcade';
import {
  FLOOR_1_TUTORIAL,
  FLOOR_1_TUTORIAL_SEED,
  FLOOR_2_TUTORIAL,
  INIT_0_INTRO_PAGES,
  TUTOR_SPEAKER,
  TUTOR_ROLE,
  TUTOR_ID,
  type TutorStep,
} from '../state/tutorial';
import type { MatchConfig } from '../state/gameState';
import { addText } from '../ui/text';
import { sysBeats, type DialogueBeat } from '../state/dialogue';
import { audio, championBgm, type ChampionKey } from '../audio/manager';

// Orchestrator scene for arcade mode. Never renders the game itself — it runs
// in two modes based on entry data:
//
//   create({})                 → show intro dialogue for current level → start match
//   create({ restart: true })  → reset run and start from level 1
//   create({ result })         → post-match: show win/loss dialogue → next action
//
// Persistent run state lives in `arcadeRun` singleton.
export interface ArcadeEntry {
  restart?: boolean;
  result?: { scores: number[]; winner: number | null };
  finishedLevelId?: number;
  endgameStep?: 'endgame' | 'final';
  // Interstitial stage flags. Each stage that fires spreads the *whole* entry
  // forward plus sets its own flag — so a later stage's callback carries all
  // previous flags too. The earlier bug was each stage only setting its own
  // flag, which let a later stage's re-entry forget that earlier stages ran.
  skipNarrator?: boolean;
  skipInit0?: boolean;
  skipClash?: boolean;
}

export class ArcadeRunScene extends Phaser.Scene {
  constructor() {
    super('ArcadeRun');
  }

  create(data: ArcadeEntry = {}) {
    if (data.restart) arcadeRun.reset();

    // Endgame chain — plays after the top floor is cleared: ENDGAME → FINAL → Menu.
    if (data.endgameStep === 'endgame') {
      audio.playBgm('engineer-beyond-form');
      this.playNarratorBeat(NARRATOR_ENDGAME, { scene: 'ArcadeRun', data: { endgameStep: 'final' } satisfies ArcadeEntry });
      return;
    }
    if (data.endgameStep === 'final') {
      audio.playBgm('engineer-beyond-form');
      this.playNarratorBeat(NARRATOR_FINAL, { scene: 'Menu' }, 'Return to Menu');
      return;
    }

    if (data.result !== undefined && data.finishedLevelId !== undefined) {
      this.handleResult(data.finishedLevelId, data.result);
      return;
    }

    if (arcadeRun.isComplete()) {
      this.showCompletion();
      return;
    }
    const level = arcadeRun.current();
    if (!level) { this.scene.start('Menu'); return; }

    // Interstitial pipeline. Each stage marks itself "seen" on the singleton
    // BEFORE launching the next scene so that the return trip skips it even
    // though the only hint we have is "we're back at ArcadeRun.create()".
    //
    // Order:
    //   1. Narrator beat (world voice, sets the stage)
    //   2. INIT-0 intro (your personal guide — only once, before Floor 1)
    //   3. Clash (champion trash talk — vs-AI floors only)
    //   4. Intro dialogue + match

    // Helper: build the scene-data for the NEXT re-entry after a stage fires.
    // Spread the current entry (minus restart, which only fires once) and set
    // the new stage flag. This way, each continue carries ALL previous flags.
    const nextEntry = (extra: Partial<ArcadeEntry>): ArcadeEntry => {
      const { restart: _r, ...rest } = data;
      return { ...rest, ...extra };
    };

    if (!data.skipNarrator) {
      const beat = NARRATOR_BEFORE[level.id];
      if (beat) {
        audio.playBgm('system-awakening');
        this.playNarratorBeat(beat, {
          scene: 'ArcadeRun',
          data: nextEntry({ skipNarrator: true }),
        });
        return;
      }
    }

    if (!data.skipInit0 && level.id === 1) {
      audio.playBgm('system-awakening');
      this.playInit0Intro(nextEntry({ skipNarrator: true, skipInit0: true }));
      return;
    }

    if (!data.skipClash) {
      const clashBeats = this.clashBeatsFor(level);
      if (clashBeats) {
        this.playClash(level, clashBeats, nextEntry({
          skipNarrator: true,
          skipInit0: true,
          skipClash: true,
        }));
        return;
      }
    }

    // Floors 1–2 skip the standard intro dialogue and jump straight into
    // INIT-0-narrated tutorial matches. Floor 1 runs a scripted deterministic
    // board; Floor 2 is a random 5×5 calibration run with a much lighter
    // chatter track.
    if (level.id === 1) {
      this.startTutorial(level, FLOOR_1_TUTORIAL, FLOOR_1_TUTORIAL_SEED);
      return;
    }
    if (level.id === 2) {
      this.startTutorial(level, FLOOR_2_TUTORIAL, null);
      return;
    }

    this.showIntro(level);
  }

  // Shared entry for the two tutorial floors. `seed` locks the board layout
  // (used by Floor 1 so the script can reference specific tiles); pass null
  // for Floor 2's calibration run to get a fresh random layout every attempt.
  private startTutorial(level: ArcadeLevel, script: TutorStep[], seed: number | null) {
    const config: MatchConfig = {
      width: level.width,
      height: level.height,
      coreCount: level.coreCount,
      players: 1,
      seed: seed ?? Math.floor(Math.random() * 0xffffffff),
      playerTypes: [{ kind: 'human' }],
      turnSeconds: level.turnSeconds,
    };
    this.scene.start('Match', {
      config,
      floorLabel: `FLOOR ${level.id} · ${level.title.toUpperCase()} · TUTORIAL`,
      tutor: {
        script,
        // Skipping a tutorial floor advances the run past that floor only;
        // MatchScene then re-enters ArcadeRun which picks up the next floor.
        onSkip: () => {
          arcadeRun.advance();
          return { scene: 'ArcadeRun' };
        },
      },
      onComplete: (result: { scores: number[]; winner: number | null }) => ({
        scene: 'ArcadeRun',
        data: { result, finishedLevelId: level.id } satisfies ArcadeEntry,
      }),
    });
  }

  // Assemble the per-seat HP array for a level. Slot 0 is always the human
  // at the match default (3). Slot 1 looks up the primary champion; 2+ walk
  // through `aiChampions` in declaration order. Anonymous AI slots stay at
  // the default — only named champions inherit the boss curve.
  private buildStartingHealth(level: ArcadeLevel): number[] {
    const DEFAULT = 3;
    const lookup = (champ?: Champion): number =>
      champ ? CHAMPION_HEALTH[champ.id] ?? DEFAULT : DEFAULT;
    const arr = new Array(level.playerTypes.length).fill(DEFAULT);
    for (let i = 1; i < arr.length; i++) {
      if (level.playerTypes[i]?.kind !== 'ai') continue;
      if (i === 1) arr[i] = lookup(level.champion);
      else arr[i] = lookup(level.aiChampions?.[i - 2]);
    }
    return arr;
  }

  private clashBeatsFor(level: ArcadeLevel): DialogueBeat[] | null {
    if (!level.champion) return null;
    // Only trigger a clash when there's actually an opponent on the board.
    const hasAi = level.playerTypes.some((p) => p.kind === 'ai');
    if (!hasAi) return null;
    return CHARACTER_CLASH[level.champion.id] ?? null;
  }

  private playClash(level: ArcadeLevel, beats: DialogueBeat[], nextData: ArcadeEntry) {
    if (!level.champion) return;
    audio.playBgm(championBgm(level.champion.id as ChampionKey));
    this.scene.launch('Dialogue', {
      title: `CLASH · Floor ${level.id}`,
      speaker: `${level.champion.name} · ${level.champion.role}`,
      speakerId: level.champion.id,
      beats,
      continueLabel: 'Face them',
      onContinue: () => {
        this.scene.stop('Dialogue');
        this.scene.start('ArcadeRun', nextData);
      },
    });
  }

  // Launch VN scene with a narrator beat. On Continue, VN itself dispatches the
  // returned scene descriptor — using ArcadeRun's own scene plugin here would
  // fail silently because ArcadeRun has already been shut down by scene.start('VN').
  private playNarratorBeat(
    beat: NarratorBeat,
    next: { scene: string; data?: unknown },
    continueLabel = 'Continue',
  ) {
    this.scene.start('VN', {
      speakerLabel: beat.label,
      body: beat.body,
      backgroundKey: 'bg_narrator',
      continueLabel,
      onContinue: () => next,
    });
  }

  // Floor 0 — INIT-0 direct-to-player intro. VN dispatches the scene.start
  // itself with the next-entry payload we hand back in onContinue.
  private playInit0Intro(nextData: ArcadeEntry) {
    this.scene.start('VN', {
      speaker: { name: TUTOR_SPEAKER, role: TUTOR_ROLE, id: TUTOR_ID },
      body: INIT_0_INTRO_PAGES,
      continueLabel: 'Enter the Grid',
      onContinue: () => ({ scene: 'ArcadeRun', data: nextData }),
    });
  }

  private showIntro(level: ArcadeLevel) {
    if (level.champion) {
      audio.playBgm(championBgm(level.champion.id as ChampionKey));
    }
    this.scene.launch('Dialogue', {
      title: `Floor ${level.id} · ${level.title}`,
      speaker: dialogueSpeaker(level),
      speakerId: level.champion?.id,
      beats: dialogueIntroBeats(level),
      continueLabel: 'Enter Floor',
      onContinue: () => {
        this.scene.stop('Dialogue');
        this.startMatch(level);
      },
    });
  }

  private startMatch(level: ArcadeLevel) {
    // Per-slot starting health. Slot 0 = human (default 3). Slot 1 = primary
    // champion AI. Slots 2+ = aiChampions, in order. Anonymous AI slots (no
    // champion attached) fall back to the default, not the boss curve.
    const startingHealth = this.buildStartingHealth(level);
    const config: MatchConfig = {
      width: level.width,
      height: level.height,
      coreCount: level.coreCount,
      players: level.playerTypes.length,
      seed: Math.floor(Math.random() * 0xffffffff),
      playerTypes: level.playerTypes,
      turnSeconds: level.turnSeconds,
      rules: level.rules,
      startingHealth,
    };
    this.scene.start('Match', {
      config,
      champion: level.champion,
      aiChampions: level.aiChampions,
      floorLabel: `FLOOR ${level.id} · ${level.title.toUpperCase()}`,
      onComplete: (result: { scores: number[]; winner: number | null }) => {
        // Trust the reducer's winner. winner === 0 means player 0 is the sole
        // alive/top scorer — that's a genuine win, solo OR vs-AI. Anything
        // else (winner === null or !== 0) is a loss, including solo
        // eliminations where the old `solo ? true` short-circuit was wrong.
        const won = result.winner === 0;
        if (won) {
          return {
            scene: 'ArcadeRun',
            data: { result, finishedLevelId: level.id } satisfies ArcadeEntry,
          };
        }
        arcadeRun.retry();
        const lossBody = level.champion ? CHARACTER_POST_LOSS[level.champion.id] : null;
        if (lossBody && level.champion) {
          return {
            scene: 'VN',
            data: {
              speaker: { name: level.champion.name, role: level.champion.role, id: level.champion.id },
              body: lossBody,
              continueLabel: 'Return to Menu',
              onContinue: () => ({ scene: 'Menu' }),
            },
          };
        }
        return { scene: 'Menu' };
      },
    });
  }

  private handleResult(levelId: number, result: { scores: number[]; winner: number | null }) {
    const level = ARCADE_LEVELS.find((l) => l.id === levelId);
    if (!level) { this.scene.start('Menu'); return; }

    // Trust the reducer's `winner`. winner === 0 means player 0 is the sole
    // alive/top scorer — a genuine win, solo OR vs-AI. `solo ? true` would
    // wrongly count an eliminated solo player as a win and advance the run.
    const won = result.winner === 0;

    if (won) {
      arcadeRun.advance();
      this.showWin(level, result);
    } else {
      arcadeRun.retry();
      this.showLoss(level, result);
    }
  }

  private showWin(level: ArcadeLevel, result: { scores: number[]; winner: number | null }) {
    const lastLevel = arcadeRun.isComplete();
    const monologue = level.champion ? CHARACTER_POST_WIN[level.champion.id] : null;
    const nextEntry: ArcadeEntry = lastLevel ? { endgameStep: 'endgame' } : {};

    // Helper: jump to the champion's VN monologue. Called either directly (no
    // outro present) or from the outro DialogueScene's onContinue.
    const goToMonologue = () => {
      if (!monologue || !level.champion) return;
      // Engineer's defeat monologue wants the ambient-empty track, NOT his
      // villain battle theme — the fight is over and he's being terminated.
      const monologueBgm = level.champion.id === 'engineer'
        ? 'engineer-beyond-form'
        : championBgm(level.champion.id as ChampionKey);
      audio.playBgm(monologueBgm);
      this.scene.start('VN', {
        speaker: level.champion,
        body: monologue,
        continueLabel: lastLevel ? 'End of Trials' : 'Next Floor',
        onContinue: () => ({ scene: 'ArcadeRun', data: nextEntry }),
      });
    };

    // Preferred flow when both exist: quick champion outro (1-3 lines in the
    // match afterglow) → full VN monologue → next floor. Gives each win a
    // two-beat closer instead of jump-cutting from match end to philosophy.
    // Victory fanfare plays during the outro as a one-shot — capped at 15s
    // so it can't loop past the outro and bleed into the next track.
    if (level.outro && level.outro.length > 0 && monologue && level.champion) {
      audio.playBgm('victory-fanfare', { maxDurationMs: 15000 });
      this.scene.launch('Dialogue', {
        title: `Floor ${level.id} Cleared`,
        speaker: `${level.champion.name} · ${level.champion.role}`,
        speakerId: level.champion.id,
        beats: level.outro,
        continueLabel: 'Monologue  ▸',
        onContinue: () => {
          this.scene.stop('Dialogue');
          // Kill the victory fanfare explicitly before the monologue track
          // starts. Without this, the fanfare's tail crossfades under the
          // champion's introspective monologue — tonally wrong.
          audio.stopBgm(300);
          goToMonologue();
        },
      });
      return;
    }

    // Monologue only (no outro authored) — straight to VN as before.
    if (monologue && level.champion) {
      goToMonologue();
      return;
    }

    // Neither: generic "Floor Cleared" card (e.g. Floor 1 solo tutorial).
    const next = lastLevel ? null : ARCADE_LEVELS[arcadeRun.levelIndex];
    const scoreLine = `Score: ${result.scores.join(' · ')}`;
    const finalBeats: DialogueBeat[] = level.outro
      ? [...level.outro, ...sysBeats([scoreLine])]
      : sysBeats(['Floor cleared.', scoreLine]);

    this.scene.launch('Dialogue', {
      title: lastLevel ? 'System Trials Complete' : `Floor ${level.id} Cleared`,
      speaker: next ? `Next: Floor ${next.id} · ${next.title}` : 'Trials complete',
      speakerId: level.champion?.id,
      beats: finalBeats,
      continueLabel: lastLevel ? 'Finish' : 'Next Floor',
      onContinue: () => {
        this.scene.stop('Dialogue');
        if (lastLevel) this.scene.start('ArcadeRun', { endgameStep: 'endgame' });
        else this.scene.start('ArcadeRun');
      },
    });
  }

  private showLoss(level: ArcadeLevel, result: { scores: number[]; winner: number | null }) {
    audio.playBgm('fail-fading-signal');
    const solo = level.playerTypes.length === 1;
    const scoreLine = `Final score: ${result.scores.join(' · ')}.`;
    // Solo floors (like Floor 1 tutorial) have no opponent — don't lie about
    // one. Vs floors get the usual "Opponent won" framing.
    const failLine = solo
      ? 'You ran out of health. Retry the trial?'
      : `Opponent won. ${scoreLine}`;
    const secondLine = solo ? 'The Grid reassembles the board.' : 'Retry this floor, or abort run?';
    this.scene.launch('Dialogue', {
      title: `Floor ${level.id} Failed`,
      speaker: dialogueSpeaker(level),
      speakerId: level.champion?.id,
      beats: sysBeats([failLine, secondLine]),
      continueLabel: 'Retry',
      onContinue: () => {
        this.scene.stop('Dialogue');
        // Flag pre-match content (narrator + clash) as already seen so retries
        // drop the player straight into the match. Without this, every retry
        // replays the multi-page intro — an infinite narrator loop for anyone
        // stuck on a floor.
        // Flag narrator + clash as already seen so retries drop straight into
        // the match instead of replaying intro content (old field names were
        // `resumedAfter*` typos that didn't match ArcadeEntry).
        this.scene.start('ArcadeRun', {
          skipNarrator: true,
          skipClash: true,
        } satisfies ArcadeEntry);
      },
    });

    // Secondary quit button under the dialogue overlay.
    const y = this.scale.height - 36;
    const btn = this.add.rectangle(this.scale.width / 2, y, 160, 30, 0x1c2030)
      .setStrokeStyle(1, 0x475172)
      .setInteractive({ useHandCursor: true });
    addText(this, this.scale.width / 2, y, 'Quit to Menu', {
      fontSize: '13px',
      color: '#c8cfdc',
    }).setOrigin(0.5);
    btn.on('pointerdown', () => {
      this.scene.stop('Dialogue');
      this.scene.start('Menu');
    });
  }

  private showCompletion() {
    this.scene.launch('Dialogue', {
      title: 'System Trials Complete',
      speaker: 'Architect Protocol initialized',
      beats: sysBeats([`Cleared ${arcadeRun.wins} floors with ${arcadeRun.losses} retries.`]),
      continueLabel: 'Back to Menu',
      onContinue: () => {
        this.scene.stop('Dialogue');
        this.scene.start('Menu');
      },
    });
  }
}
