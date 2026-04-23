import * as Phaser from 'phaser';
import { addText } from '../ui/text';
import type { DialogueBeat, DialogueSpeakerKind } from '../state/dialogue';
import { audio } from '../audio/manager';
import { playerState } from '../state/player';

export interface DialogueData {
  title?: string;
  speaker?: string;
  // Optional character id (e.g. 'iris'). When set and `portrait_<id>` exists in
  // the texture cache, a portrait is rendered on the right side of the scene.
  speakerId?: string;
  beats: DialogueBeat[];
  continueLabel?: string;
  onContinue: () => void;
}

interface BeatStyle {
  color: string;
  textColor: string;
  fillColor: number;
  strokeColor: number;
  offsetX: number;
  align: 'left' | 'right' | 'center';
  italic: boolean;
  defaultLabel?: string;
}

// All beats now render at the same screen position — only the speaker label,
// color, and accent bar change per kind. Previously we offset champion/mc/etc.
// horizontally, which made the MC beat appear on the right while the user's
// eyes were still looking left at the champion beat they just advanced from.
// Result: the MC line was "there" but outside the user's attention zone.
const STYLE: Record<DialogueSpeakerKind, BeatStyle> = {
  champion: {
    color: '#6eb4ff', textColor: '#e8ecf1',
    fillColor: 0x12151f, strokeColor: 0x2a3a5a,
    offsetX: 0, align: 'left', italic: false,
  },
  mc: {
    color: '#ffb86b', textColor: '#f4ead8',
    fillColor: 0x1c1812, strokeColor: 0x6a4a24,
    offsetX: 0, align: 'left', italic: false,
    defaultLabel: 'OPERATOR',
  },
  system: {
    color: '#9aa3b8', textColor: '#c8cfdc',
    fillColor: 0x12151f, strokeColor: 0x2a2f44,
    offsetX: 0, align: 'center', italic: false,
  },
  aside: {
    color: '#6f7a8c', textColor: '#7e8aa0',
    fillColor: 0x0f1218, strokeColor: 0x232737,
    offsetX: 0, align: 'center', italic: true,
  },
};

// Minimum gap between advances — stops held keys from flashing through beats
// and click+key double-taps from firing onContinue twice. 400ms gives the
// fade-in (200ms) time to complete so the beat is actually readable before
// the user can skip past it.
const ADVANCE_COOLDOWN_MS = 400;

export class DialogueScene extends Phaser.Scene {
  private beats: DialogueBeat[] = [];
  private index = 0;
  private continueLabel = 'Continue';
  private onContinueCb: () => void = () => {};
  private consumed = false;           // latches when we fire onContinueCb
  private canAdvanceAt = 0;

  private beatSpeaker?: Phaser.GameObjects.Text;
  private beatPanel?: Phaser.GameObjects.Rectangle;
  private beatBody?: Phaser.GameObjects.Text;
  private btn?: Phaser.GameObjects.Rectangle;
  private btnLabel?: Phaser.GameObjects.Text;
  // Portrait + its resting position / scale. Animation tweens operate against
  // these base values so idle breathing (scale pulse) + talk bumps (y offset)
  // don't compound across beats.
  private portraitImg?: Phaser.GameObjects.Image;
  private portraitBaseY = 0;
  private portraitBaseScale = 1;
  private talkBumpTween?: Phaser.Tweens.Tween;
  // The character id currently shown on the right-side portrait. Swaps per
  // champion beat in battle-royale intros so cameos actually appear.
  private currentPortraitId?: string;
  // MC (player avatar) portrait — mirrors the champion layout on the left
  // side. Same breathing + talk-bump treatment; alpha flips opposite the
  // champion's so whichever side is speaking visibly "takes the scene."
  private mcImg?: Phaser.GameObjects.Image;
  private mcBaseY = 0;
  private mcTalkBumpTween?: Phaser.Tweens.Tween;

  constructor() { super('Dialogue'); }

  create(data: DialogueData) {
    this.beats = data.beats ?? [];
    this.index = 0;
    this.continueLabel = data.continueLabel ?? 'Continue';
    this.onContinueCb = data.onContinue;
    this.consumed = false;
    // 500ms lockout on mount — blocks held keys from the previous scene
    // (OS key-repeat keeps firing keydown as long as the key is held down)
    // from cascading through multiple scenes and auto-advancing everything.
    this.canAdvanceAt = this.time.now + 500;

    const { width, height } = this.scale;
    const cx = width / 2;
    this.cameras.main.setBackgroundColor('#07090d');

    // Optional background image, auto-derived from speakerId. Rendered first
    // so portrait + dialogue panel both layer above it. Dark overlay knocks
    // the brightness down so text stays readable.
    if (data.speakerId) {
      const bgKey = `bg_${data.speakerId}`;
      if (this.textures.exists(bgKey)) {
        const tex = this.textures.get(bgKey).getSourceImage() as HTMLImageElement;
        const scale = Math.max(width / tex.width, height / tex.height);
        this.add.image(width / 2, height / 2, bgKey).setScale(scale);
        this.add.rectangle(0, 0, width, height, 0x07090d, 0.55).setOrigin(0, 0);
      }
    }

    // Optional character portrait, right-anchored. Rendered after BG so it
    // layers above it, but before the dialogue panel so the panel covers the
    // portrait where text appears — portrait peeks out from behind.
    if (data.speakerId) {
      const portraitKey = `portrait_${data.speakerId}`;
      if (this.textures.exists(portraitKey)) {
        const tex = this.textures.get(portraitKey).getSourceImage() as HTMLImageElement;
        const maxH = Math.min(height * 0.85, 760);
        const scale = maxH / tex.height;
        const portraitW = tex.width * scale;
        const px = width - 24 - portraitW / 2;
        const py = height / 2;
        // Start off-screen to the right so the portrait slides in on mount.
        const portrait = this.add.image(px + portraitW + 60, py, portraitKey)
          .setScale(scale)
          .setAlpha(0);
        this.portraitImg = portrait;
        this.portraitBaseY = py;
        this.portraitBaseScale = scale;
        this.currentPortraitId = data.speakerId;
        // Entry: slide in + fade up to starting-alpha (0.6 — renderBeat bumps
        // this when a champion beat becomes active).
        this.tweens.add({
          targets: portrait,
          x: px,
          alpha: 0.6,
          duration: 440,
          ease: 'Cubic.easeOut',
        });
        // Idle breathing — slow scale yoyo. Always on. Subtle enough not to
        // read as "animation" consciously but keeps the portrait from looking
        // like a dead sprite.
        this.tweens.add({
          targets: portrait,
          scaleX: scale * 1.012,
          scaleY: scale * 1.012,
          yoyo: true,
          repeat: -1,
          duration: 2400,
          ease: 'Sine.easeInOut',
        });
      }

      // MC portrait — left-side mirror. Only render when we're also showing a
      // champion on the right, so neutral narrator dialogues stay clean.
      const mcKey = `portrait_${playerState.mcKey}`;
      if (this.textures.exists(mcKey)) {
        const tex = this.textures.get(mcKey).getSourceImage() as HTMLImageElement;
        const maxH = Math.min(height * 0.78, 700);
        const scale = maxH / tex.height;
        const mcW = tex.width * scale;
        const mx = 24 + mcW / 2;
        const my = height / 2;
        const mc = this.add.image(mx - mcW - 60, my, mcKey)
          .setScale(scale)
          .setAlpha(0);
        this.mcImg = mc;
        this.mcBaseY = my;
        this.tweens.add({
          targets: mc,
          x: mx,
          alpha: 0.5,
          duration: 440,
          ease: 'Cubic.easeOut',
        });
        this.tweens.add({
          targets: mc,
          scaleX: scale * 1.012,
          scaleY: scale * 1.012,
          yoyo: true,
          repeat: -1,
          duration: 2400,
          ease: 'Sine.easeInOut',
        });
      }
    }

    if (data.title) {
      addText(this, cx, height * 0.18, data.title, {
        fontSize: '42px', color: '#e8ecf1',
      }).setOrigin(0.5);
    }
    if (data.speaker) {
      addText(this, cx, height * 0.18 + 52, data.speaker, {
        fontSize: '14px', color: '#6eb4ff', fontStyle: 'bold',
      }).setOrigin(0.5);
    }

    this.btn = this.add.rectangle(cx, height - 100, 240, 52, 0x2a6df4)
      .setStrokeStyle(2, 0x4f8bff);
    this.btnLabel = addText(this, cx, height - 100, '', {
      fontSize: '18px', color: '#ffffff',
    }).setOrigin(0.5);
    this.btn.setInteractive({ useHandCursor: true });
    this.btn.on('pointerover', () => !this.consumed && this.btn?.setFillStyle(0x3b7bff));
    this.btn.on('pointerout', () => !this.consumed && this.btn?.setFillStyle(0x2a6df4));
    this.btn.on('pointerup', () => this.advance());

    // Named handler refs so we can explicitly remove them on shutdown —
    // belt-and-suspenders against listeners leaking across scene restarts.
    const onEnter = () => this.advance();
    const onSpace = () => this.advance();
    this.input.keyboard?.on('keydown-ENTER', onEnter);
    this.input.keyboard?.on('keydown-SPACE', onSpace);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.input.keyboard?.off('keydown-ENTER', onEnter);
      this.input.keyboard?.off('keydown-SPACE', onSpace);
    });

    this.renderBeat();
  }

  private renderBeat() {
    this.beatSpeaker?.destroy();
    this.beatPanel?.destroy();
    this.beatBody?.destroy();

    const beat = this.beats[this.index];
    if (!beat) return;
    const style = STYLE[beat.kind];

    // Portraits react to who's speaking. Whichever side is active goes bright
    // + takes a talk bump; the other dims. Keeps the viewer's eye on the
    // current line without having to read the speaker tag.
    const championTalking = beat.kind === 'champion';
    const mcTalking = beat.kind === 'mc';
    // Swap the right-side portrait to the current champion if they differ
    // from whoever's on stage. Lets FORK / GLITCH / whoever actually appear
    // during their cameo lines instead of the primary's portrait lipsyncing
    // for them.
    if (championTalking && beat.speakerId && this.portraitImg) {
      this.swapPortraitTo(beat.speakerId);
    }
    if (this.portraitImg) {
      this.tweens.add({
        targets: this.portraitImg,
        alpha: championTalking ? 0.95 : 0.45,
        duration: 180,
        ease: 'Sine.easeOut',
      });
      if (championTalking) this.doTalkBump();
    }
    if (this.mcImg) {
      this.tweens.add({
        targets: this.mcImg,
        alpha: mcTalking ? 0.95 : 0.45,
        duration: 180,
        ease: 'Sine.easeOut',
      });
      if (mcTalking) this.doMcTalkBump();
    }

    const { width, height } = this.scale;
    const cx = width / 2;
    const boxW = Math.min(620, width - 160);
    const panelCx = cx + style.offsetX;
    const boxX = panelCx - boxW / 2;
    const boxY = height * 0.4;
    const panelH = 140;

    // MC beats use the selected real name (Samuel / Samantha) as the speaker
    // tag, overriding the generic 'OPERATOR' default in STYLE.mc.
    const mcLabel = beat.kind === 'mc' ? playerState.mcName.toUpperCase() : null;
    const speakerLabel = beat.speaker ?? mcLabel ?? style.defaultLabel ?? '';
    if (speakerLabel) {
      const labelY = boxY - 26;
      // Bigger, bolder speaker tag — makes it obvious who just started
      // speaking when the beat changes between the same-shaped panels.
      if (style.align === 'center') {
        this.beatSpeaker = addText(this, panelCx, labelY, speakerLabel, {
          fontSize: '14px', color: style.color, fontStyle: 'bold',
        }).setOrigin(0.5, 0);
      } else {
        this.beatSpeaker = addText(this, boxX + 12, labelY, speakerLabel, {
          fontSize: '14px', color: style.color, fontStyle: 'bold',
        });
      }
    }

    this.beatPanel = this.add.rectangle(panelCx, boxY + panelH / 2, boxW, panelH, style.fillColor)
      .setStrokeStyle(1, style.strokeColor)
      .setOrigin(0.5);

    const bodyOpts: Phaser.Types.GameObjects.Text.TextStyle = {
      fontSize: '17px',
      color: style.textColor,
      lineSpacing: 6,
      fontStyle: style.italic ? 'italic' : 'normal',
      wordWrap: { width: boxW - 48 },
    };
    if (style.align === 'right') {
      this.beatBody = addText(this, boxX + boxW - 24, boxY + 22,
        beat.line, { ...bodyOpts, align: 'right' }).setOrigin(1, 0);
    } else if (style.align === 'center') {
      this.beatBody = addText(this, panelCx, boxY + 22,
        beat.line, { ...bodyOpts, align: 'center' }).setOrigin(0.5, 0);
    } else {
      this.beatBody = addText(this, boxX + 24, boxY + 22, beat.line, bodyOpts);
    }

    this.beatBody.setAlpha(0);
    this.tweens.add({ targets: this.beatBody, alpha: 1, duration: 200, ease: 'Cubic.easeOut' });

    const isLast = this.index >= this.beats.length - 1;
    this.btnLabel?.setText(isLast ? this.continueLabel : 'Next  ▸');
  }

  // Swap the right-side portrait to a different character's texture in place.
  // Recomputes scale + anchor X against the new texture's dimensions so
  // different-sized portraits still right-anchor cleanly. Updates baseScale
  // so the next talk-bump / breathing tween resolves against the new values.
  private swapPortraitTo(speakerId: string) {
    if (!this.portraitImg) return;
    if (speakerId === this.currentPortraitId) return;
    const key = `portrait_${speakerId}`;
    if (!this.textures.exists(key)) return;
    const tex = this.textures.get(key).getSourceImage() as HTMLImageElement;
    const { width, height } = this.scale;
    const maxH = Math.min(height * 0.85, 760);
    const scale = maxH / tex.height;
    const portraitW = tex.width * scale;
    const px = width - 24 - portraitW / 2;
    this.portraitImg.setTexture(key).setScale(scale);
    this.portraitImg.setPosition(px, this.portraitBaseY);
    this.portraitBaseScale = scale;
    this.currentPortraitId = speakerId;
  }

  // Small upward hop + scale pulse, yoyo'd back to base. Fires each time the
  // champion has a new beat — reinforces that "they just said something."
  // Cancels any in-flight bump so rapid beat advances don't stack offsets.
  // The scale pulse briefly overrides the slow idle-breathing tween; 160ms
  // is short enough that the seam is imperceptible.
  private doTalkBump() {
    if (!this.portraitImg) return;
    this.talkBumpTween?.stop();
    this.portraitImg.y = this.portraitBaseY;
    this.talkBumpTween = this.tweens.add({
      targets: this.portraitImg,
      y: this.portraitBaseY - 7,
      scaleX: this.portraitBaseScale * 1.03,
      scaleY: this.portraitBaseScale * 1.03,
      yoyo: true,
      duration: 160,
      ease: 'Sine.easeInOut',
      onComplete: () => {
        if (this.portraitImg) {
          this.portraitImg.y = this.portraitBaseY;
          this.portraitImg.setScale(this.portraitBaseScale);
        }
      },
    });
  }

  // Same pattern for the MC on the left. Separate tween handle so the two
  // sides can bump independently without one cancelling the other.
  private doMcTalkBump() {
    if (!this.mcImg) return;
    this.mcTalkBumpTween?.stop();
    this.mcImg.y = this.mcBaseY;
    this.mcTalkBumpTween = this.tweens.add({
      targets: this.mcImg,
      y: this.mcBaseY - 7,
      yoyo: true,
      duration: 160,
      ease: 'Sine.easeInOut',
      onComplete: () => {
        if (this.mcImg) this.mcImg.y = this.mcBaseY;
      },
    });
  }

  private advance() {
    if (this.consumed) return;
    // Rate-limit — prevents held-key spam and click+keyboard double taps.
    if (this.time.now < this.canAdvanceAt) return;
    this.canAdvanceAt = this.time.now + ADVANCE_COOLDOWN_MS;
    audio.sfx('click');

    if (this.index >= this.beats.length - 1) {
      this.consumed = true;
      this.btn?.setFillStyle(0x1e4cab);
      this.time.delayedCall(0, () => this.onContinueCb());
      return;
    }
    this.index += 1;
    this.renderBeat();
  }
}
