import * as Phaser from 'phaser';

// Runtime bitmap font generation. Renders characters onto a canvas at load
// time, then builds a BitmapFontData structure by hand and registers it in
// the bitmap font cache. We avoid RetroFont.Parse because the Phaser 4
// signature/behavior produced incomplete data (BitmapText.getTextBounds threw
// "Cannot read properties of undefined (reading '<charCode>')").

export interface BitmapFontOptions {
  key: string;
  fontFamily: string;
  fontSize: number;        // render height in px
  color: string;           // CSS color string, e.g. '#e8ecf1'
  chars: string;           // which characters to bake (order is preserved)
  bold?: boolean;
  cellPadX?: number;
}

// The minimal shape BitmapText / GetBitmapTextSize actually reads.
// See Phaser's BitmapFontData typedef — `chars` is keyed by char code.
interface BitmapFontCharData {
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  xOffset: number;
  yOffset: number;
  xAdvance: number;
  data: Record<string, never>;
  kerning: Record<number, number>;
}

interface BitmapFontData {
  font: string;
  size: number;
  lineHeight: number;
  retroFont: boolean;
  chars: Record<number, BitmapFontCharData>;
}

/**
 * Bakes a fixed-cell bitmap font and registers it under the given key.
 * Safe to call twice — a second call with the same key is a no-op.
 */
export function createBitmapFont(scene: Phaser.Scene, opts: BitmapFontOptions): void {
  if (scene.cache.bitmapFont.has(opts.key)) return;

  const { key, fontFamily, fontSize, color, chars, bold, cellPadX = 2 } = opts;
  const weight = bold ? 'bold ' : '';
  const fontSpec = `${weight}${fontSize}px ${fontFamily}`;

  // Measure the widest glyph — all cells use that width so the char map
  // math stays trivial. The retro look is a feature for the HUD aesthetic.
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.font = fontSpec;
  let cellW = 0;
  for (const ch of chars) {
    cellW = Math.max(cellW, Math.ceil(probe.measureText(ch).width));
  }
  cellW = Math.max(cellW + cellPadX * 2, 1);
  const cellH = Math.ceil(fontSize * 1.3);

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(cellW * chars.length, 1);
  canvas.height = cellH;
  const ctx = canvas.getContext('2d')!;
  ctx.font = fontSpec;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.imageSmoothingEnabled = false;

  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], i * cellW + cellW / 2, cellH / 2);
  }

  const textureKey = `${key}__tex`;
  if (scene.textures.exists(textureKey)) scene.textures.remove(textureKey);
  scene.textures.addCanvas(textureKey, canvas);

  // Build the char map keyed by charCode — exactly what
  // Phaser's GetBitmapTextSize indexes into.
  const charsMap: Record<number, BitmapFontCharData> = {};
  for (let i = 0; i < chars.length; i++) {
    const code = chars.charCodeAt(i);
    charsMap[code] = {
      x: i * cellW,
      y: 0,
      width: cellW,
      height: cellH,
      centerX: cellW / 2,
      centerY: cellH / 2,
      xOffset: 0,
      yOffset: 0,
      xAdvance: cellW,
      data: {},
      kerning: {},
    };
  }

  const data: BitmapFontData = {
    font: key,
    size: fontSize,
    lineHeight: cellH,
    retroFont: true,
    chars: charsMap,
  };

  const texture = scene.textures.get(textureKey);
  scene.cache.bitmapFont.add(key, {
    data: data as unknown as Phaser.Types.GameObjects.BitmapText.BitmapFontData,
    texture,
    frame: texture.get(),
  });
}

export const FONT_TILE_NUMBERS = 'bf_tile_nums';
export const FONT_HUD = 'bf_hud';
export const FONT_HUD_BOLD = 'bf_hud_bold';

// Characters used by HUD strings (turn line, floor label, scores). Add glyphs
// here if HUD text starts displaying squares/blanks.
export const HUD_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,:;!?·—-+/ ()[]#%·';
