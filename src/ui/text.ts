import * as Phaser from 'phaser';

// Phaser renders text to a texture at 1x by default, which looks blurry on
// retina/hi-DPI screens. Match texture resolution to the device pixel ratio.
export const TEXT_RESOLUTION = Math.max(1, Math.ceil(window.devicePixelRatio || 1));

export function addText(
  scene: Phaser.Scene,
  x: number,
  y: number,
  text: string,
  style: Phaser.Types.GameObjects.Text.TextStyle = {},
): Phaser.GameObjects.Text {
  const t = scene.add.text(x, y, text, {
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    ...style,
  });
  t.setResolution(TEXT_RESOLUTION);
  return t;
}
