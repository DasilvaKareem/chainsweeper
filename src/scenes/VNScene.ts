import * as Phaser from 'phaser';
import { addText } from '../ui/text';
import { audio } from '../audio/manager';
import { playerState } from '../state/player';

// Duck-typed speaker — only needs the fields we render. Lets non-Champion
// speakers (like INIT-0) use the same name-card without joining the roster.
// `id` is optional: when set and a texture `portrait_<id>` is loaded, the VN
// renders the character portrait beside the monologue panel.
export interface VNSpeaker {
  name: string;
  role: string;
  id?: string;
}

export interface VNData {
  speaker?: VNSpeaker;     // name + role header. Omit for narrator / inner voice.
  speakerLabel?: string;   // fallback label if no speaker
  body: string | string[]; // single monologue, or multi-page sequence (paginated in-scene)
  continueLabel?: string;
  // Optional full-scene background image key. If omitted, auto-derives
  // `bg_<speaker.id>` from the speaker (so champion monologues pick up their
  // Layer's backdrop by convention). Falls back to solid color if neither is
  // loaded in the texture cache.
  backgroundKey?: string;
  // Returns where to go next. VN dispatches the scene.start itself using its
  // own (live) scene plugin — calling scene.start from the launcher's captured
  // `this` silently no-ops once the launcher has been shut down.
  onContinue: () => { scene: string; data?: unknown };
}

// VN-style monologue scene. Bigger text area and name-card than DialogueScene,
// intended for character philosophy speeches and the run's closing line.
const STREAM_CHARS_PER_TICK = 2;
const STREAM_INTERVAL_MS = 16;

export class VNScene extends Phaser.Scene {
  private pages: string[] = [];
  private pageIndex = 0;
  private continueLabel = 'Continue';
  // Guard so spam-clicks / click+keyboard can't fire onContinue twice.
  // A second fire stomps on the in-progress scene.start and produces weird states.
  private consumed = false;
  private onContinueCb: () => { scene: string; data?: unknown } = () => ({ scene: 'Menu' });
  private btn?: Phaser.GameObjects.Rectangle;
  private btnLabel?: Phaser.GameObjects.Text;
  private bodyText?: Phaser.GameObjects.Text;
  // Measured in create() — renderPage() uses this for text word-wrap so the
  // body column shrinks when a portrait is rendered on the right.
  private panelWidth = 0;
  // Portrait animation state — see DialogueScene for the same pattern.
  private portraitImg?: Phaser.GameObjects.Image;
  private portraitBaseY = 0;
  private talkBumpTween?: Phaser.Tweens.Tween;
  // Streaming state: the active page reveals char-by-char. First click while
  // streaming skips to fully-revealed; second click advances the page.
  private streamTarget = '';
  private streamIndex = 0;
  private streamDone = false;
  private streamTimer?: Phaser.Time.TimerEvent;
  // Lockout timestamp — ignore any input before this to block held keys from
  // the previous scene from auto-firing the continue action.
  private canActAt = 0;

  constructor() {
    super('VN');
  }

  create(data: VNData) {
    this.consumed = false;
    this.canActAt = this.time.now + 500;
    this.onContinueCb = data.onContinue;
    this.pages = Array.isArray(data.body) ? data.body : [data.body];
    this.pageIndex = 0;
    this.continueLabel = data.continueLabel ?? 'Continue';

    const { width, height } = this.scale;
    // Narrow viewports (phones) flip the layout from side-by-side
    // (portraits flank the text) to stacked (portraits above a wide text
    // panel). Side-by-side can't fit on ≤400px-wide screens without the
    // portraits swallowing the monologue panel.
    const narrow = width < 620;
    this.cameras.main.setBackgroundColor('#05070b');

    // Background image (optional): explicit key wins, else auto-derive from
    // speaker id. Scales to cover the full scene, then a dark overlay knocks
    // the brightness down so the body text stays readable.
    const bgKey = data.backgroundKey
      ?? (data.speaker?.id ? `bg_${data.speaker.id}` : null);
    if (bgKey && this.textures.exists(bgKey)) {
      const tex = this.textures.get(bgKey).getSourceImage() as HTMLImageElement;
      const scale = Math.max(width / tex.width, height / tex.height);
      this.add.image(width / 2, height / 2, bgKey).setScale(scale);
      this.add.rectangle(0, 0, width, height, 0x05070b, 0.55).setOrigin(0, 0);
    }

    this.add.rectangle(0, 0, width, 3, 0x2a6df4).setOrigin(0, 0);

    // Portrait — shown when the speaker has an id AND a preloaded texture.
    // Anchored to the right edge, scaled to fit the scene height.
    const portraitKey = data.speaker?.id ? `portrait_${data.speaker.id}` : null;
    const hasPortrait = !!portraitKey && this.textures.exists(portraitKey);
    let portraitRightEdge = width;
    if (hasPortrait && portraitKey) {
      const tex = this.textures.get(portraitKey).getSourceImage() as HTMLImageElement;
      const maxH = narrow
        ? Math.min(height * 0.36, 320)
        : Math.min(height - 40, 720);
      const maxW = narrow ? width * 0.44 : Infinity;
      const scale = Math.min(maxH / tex.height, maxW / tex.width);
      const portraitW = tex.width * scale;
      // Right-anchor with a small margin. Portrait sits behind the panel stroke.
      const px = width - 24 - portraitW / 2;
      const py = narrow ? height * 0.3 : height / 2;
      // Start off-screen to the right; entry tween slides in on mount.
      const portrait = this.add.image(px + portraitW + 60, py, portraitKey)
        .setScale(scale)
        .setAlpha(0);
      this.portraitImg = portrait;
      this.portraitBaseY = py;
      this.tweens.add({
        targets: portrait,
        x: px,
        alpha: 0.95,
        duration: 480,
        ease: 'Cubic.easeOut',
      });
      // Idle breathing — slow scale yoyo. Keeps the portrait feeling alive
      // under the streaming monologue.
      this.tweens.add({
        targets: portrait,
        scaleX: scale * 1.014,
        scaleY: scale * 1.014,
        yoyo: true,
        repeat: -1,
        duration: 2600,
        ease: 'Sine.easeInOut',
      });
      portraitRightEdge = px - portraitW / 2 - 16;
    }

    // MC (player avatar) — silent listener on the left. Always rendered (as
    // long as the selected texture is loaded), so the protagonist is visible
    // during champion monologues AND narrator beats / INIT-0 / endgame. Stays
    // dim — they're listening, not speaking.
    const mcKey = `portrait_${playerState.mcKey}`;
    if (this.textures.exists(mcKey)) {
      const mcTex = this.textures.get(mcKey).getSourceImage() as HTMLImageElement;
      const mcMaxH = narrow
        ? Math.min(height * 0.34, 300)
        : Math.min(height - 80, 640);
      const mcMaxW = narrow ? width * 0.42 : Infinity;
      const mcScale = Math.min(mcMaxH / mcTex.height, mcMaxW / mcTex.width);
      const mcW = mcTex.width * mcScale;
      const mcX = 24 + mcW / 2;
      const mcY = narrow ? height * 0.3 : height / 2;
      const mcImg = this.add.image(mcX - mcW - 60, mcY, mcKey)
        .setScale(mcScale)
        .setAlpha(0);
      this.tweens.add({
        targets: mcImg,
        x: mcX,
        alpha: 0.55,
        duration: 480,
        ease: 'Cubic.easeOut',
      });
      this.tweens.add({
        targets: mcImg,
        scaleX: mcScale * 1.012,
        scaleY: mcScale * 1.012,
        yoyo: true,
        repeat: -1,
        duration: 2800,
        ease: 'Sine.easeInOut',
      });
    }

    const cardX = narrow ? 24 : 48;
    const cardY = narrow ? 36 : 72;
    if (data.speaker) {
      addText(this, cardX, cardY, data.speaker.name, {
        fontSize: narrow ? '22px' : '28px',
        color: '#e8ecf1',
        fontStyle: 'bold',
      });
      addText(this, cardX, cardY + (narrow ? 28 : 36), data.speaker.role.toUpperCase(), {
        fontSize: '12px',
        color: '#6eb4ff',
        fontStyle: 'bold',
      });
    } else if (data.speakerLabel) {
      addText(this, cardX, cardY, data.speakerLabel, {
        fontSize: narrow ? '18px' : '22px',
        color: '#9ca6b8',
        fontStyle: 'italic',
      });
    }

    const panelX = narrow ? 24 : 48;
    // On narrow: panel sits *below* the portraits (stacked layout).
    // On wide: panel starts near the top and the portraits flank it sideways.
    const panelY = narrow ? Math.round(height * 0.52) : 160;
    // When a portrait is rendered, cap the panel so it doesn't overlap.
    // On narrow the panel is full-width regardless (portraits are above it).
    const rightLimit = narrow
      ? width - panelX
      : (hasPortrait ? portraitRightEdge : width - 48);
    const panelW = narrow
      ? width - panelX * 2
      : Math.max(320, Math.min(920, rightLimit - panelX));
    const panelH = narrow
      ? Math.min(height - panelY - 110, 360)
      : Math.min(height - panelY - 140, 420);
    this.panelWidth = panelW;

    // Narrow panels get a darker overlay (0.85 vs 0.72) so the stacked
    // portraits above don't bleed through at low contrast.
    this.add.rectangle(panelX, panelY, panelW, panelH, 0x0c0f17, narrow ? 0.85 : 0.72)
      .setOrigin(0, 0)
      .setStrokeStyle(1, 0x1e2332);

    const btnY = narrow ? height - 56 : height - 64;
    const btnW = narrow ? 200 : 240;
    const btnH = narrow ? 44 : 52;
    // Narrow: center the button under the panel. Wide: right-anchored corner.
    const btnX = narrow ? width / 2 : width - 180;
    this.btn = this.add.rectangle(btnX, btnY, btnW, btnH, 0x2a6df4)
      .setStrokeStyle(2, 0x4f8bff);
    this.btnLabel = addText(this, btnX, btnY, '', {
      fontSize: '18px',
      color: '#ffffff',
    }).setOrigin(0.5);
    this.btn.setInteractive({ useHandCursor: true });
    this.btn.on('pointerover', () => !this.consumed && this.btn?.setFillStyle(0x3b7bff));
    this.btn.on('pointerout', () => !this.consumed && this.btn?.setFillStyle(0x2a6df4));
    this.btn.on('pointerup', () => this.fire());

    // Keyboard hint hidden on mobile — no physical keyboard, and the string
    // overlaps the centered button on narrow layouts.
    if (!narrow) {
      addText(this, 48, height - 54, 'Press [Space] or [Enter] to continue', {
        fontSize: '12px',
        color: '#4a5063',
      });
    }

    this.input.keyboard?.on('keydown-SPACE', () => this.fire());
    this.input.keyboard?.on('keydown-ENTER', () => this.fire());

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.input.keyboard?.off('keydown-SPACE');
      this.input.keyboard?.off('keydown-ENTER');
    });

    this.renderPage();
  }

  private renderPage() {
    const { width, height } = this.scale;
    const narrow = width < 620;
    const panelX = narrow ? 24 : 48;
    const panelY = narrow ? Math.round(height * 0.52) : 160;
    const panelW = this.panelWidth || Math.min(920, width - 96);

    this.streamTimer?.remove();
    this.bodyText?.destroy();
    // Each new page = speaker starts a new breath of monologue. Nudge the
    // portrait so the viewer's eye re-attaches to "they're saying something."
    this.doTalkBump();
    this.streamTarget = this.pages[this.pageIndex] ?? '';
    this.streamIndex = 0;
    this.streamDone = this.streamTarget.length === 0;
    this.bodyText = addText(this, panelX + 32, panelY + 28, '', {
      fontSize: narrow ? '16px' : '19px',
      color: '#d6dce8',
      lineSpacing: narrow ? 6 : 10,
      wordWrap: { width: panelW - 64 },
    });

    const isLast = this.pageIndex >= this.pages.length - 1;
    this.btnLabel?.setText(isLast ? this.continueLabel : 'Next  ▸');

    if (!this.streamDone) this.startStream();
  }

  // See DialogueScene.doTalkBump — identical pattern, fires on each page.
  private doTalkBump() {
    if (!this.portraitImg) return;
    this.talkBumpTween?.stop();
    this.portraitImg.y = this.portraitBaseY;
    this.talkBumpTween = this.tweens.add({
      targets: this.portraitImg,
      y: this.portraitBaseY - 8,
      yoyo: true,
      duration: 170,
      ease: 'Sine.easeInOut',
      onComplete: () => {
        if (this.portraitImg) this.portraitImg.y = this.portraitBaseY;
      },
    });
  }

  private startStream() {
    this.streamTimer = this.time.addEvent({
      delay: STREAM_INTERVAL_MS,
      loop: true,
      callback: () => {
        this.streamIndex = Math.min(
          this.streamTarget.length,
          this.streamIndex + STREAM_CHARS_PER_TICK,
        );
        this.bodyText?.setText(this.streamTarget.slice(0, this.streamIndex));
        if (this.streamIndex >= this.streamTarget.length) {
          this.streamDone = true;
          this.streamTimer?.remove();
          this.streamTimer = undefined;
        }
      },
    });
  }

  private fire() {
    if (this.consumed) return;
    if (this.time.now < this.canActAt) return;
    audio.sfx('click');
    // First click while streaming — reveal the full page immediately.
    if (!this.streamDone) {
      this.streamTimer?.remove();
      this.streamTimer = undefined;
      this.streamIndex = this.streamTarget.length;
      this.streamDone = true;
      this.bodyText?.setText(this.streamTarget);
      return;
    }
    // Not on the last page yet — advance and re-render.
    if (this.pageIndex < this.pages.length - 1) {
      this.pageIndex += 1;
      this.renderPage();
      return;
    }
    this.consumed = true;
    this.btn?.setFillStyle(0x1e4cab);
    // Invoke after a zero-tick so any in-flight tween frame can finish cleanly.
    this.time.delayedCall(0, () => {
      const dest = this.onContinueCb();
      this.scene.start(dest.scene, dest.data as object | undefined);
    });
  }
}
