// Thin JS → native iOS bridge for haptic feedback. On the native wrapper
// (see ios/Sources/GameWebView.swift) a WKScriptMessageHandler named
// "haptic" receives these messages and fires UIImpactFeedbackGenerator /
// UINotificationFeedbackGenerator. In the browser / desktop build the
// bridge isn't present and this falls back to the Vibration API (Android
// Chrome) or a silent no-op (desktop Safari, Firefox).

export type HapticStyle =
  | 'light'
  | 'medium'
  | 'heavy'
  | 'selection'
  | 'success'
  | 'warning'
  | 'error';

interface HapticBridge {
  postMessage(payload: { style: HapticStyle }): void;
}

interface WebKitMessageHandlers {
  readonly haptic?: HapticBridge;
}

interface WebKitWindow {
  readonly messageHandlers?: WebKitMessageHandlers;
}

// Rough per-style fallback duration for navigator.vibrate (ms). Only the
// browser path uses these — iOS native takes the explicit style above.
const VIBRATE_MS: Record<HapticStyle, number> = {
  light: 10,
  medium: 18,
  heavy: 28,
  selection: 6,
  success: 24,
  warning: 40,
  error: 60,
};

export function haptic(style: HapticStyle = 'medium'): void {
  const w = window as unknown as { webkit?: WebKitWindow; navigator: Navigator };
  const bridge = w.webkit?.messageHandlers?.haptic;
  if (bridge) {
    try { bridge.postMessage({ style }); } catch { /* ignore */ }
    return;
  }
  // Browsers that expose Vibration API (Android Chrome). Desktop Safari and
  // Firefox don't — they silently no-op, which is what we want.
  const vibrate = (w.navigator as Navigator & { vibrate?: (pattern: number[]) => boolean }).vibrate;
  vibrate?.call(w.navigator, [VIBRATE_MS[style]]);
}
