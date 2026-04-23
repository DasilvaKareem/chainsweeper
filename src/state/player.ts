// Player-side character identity. The Coder (player avatar) picks a portrait
// variant at the start of an Arcade run; that choice is read by DialogueScene
// + VNScene to render the MC portrait on the left side of every cutscene.
//
// Values match texture keys preloaded in `PreloadScene`: `portrait_mc_boy` /
// `portrait_mc_girl`. Stored in memory only — a page refresh resets it, which
// is fine: the first thing Arcade does is route through SelectOperator.

export type McKey = 'mc_boy' | 'mc_girl';

// Real names tied to each variant. "Operator" is the Grid's generic title for
// any Coder; these are the characters' actual names surfaced in dialogue tags.
export const MC_NAMES: Record<McKey, string> = {
  mc_boy: 'Samuel',
  mc_girl: 'Samantha',
};

class PlayerState {
  // Default keeps the VN renderer happy if some code path reaches a cutscene
  // before SelectOperator runs. Real selection overwrites this on entry.
  mcKey: McKey = 'mc_boy';

  select(key: McKey): void {
    this.mcKey = key;
  }

  get mcName(): string {
    return MC_NAMES[this.mcKey];
  }
}

export const playerState = new PlayerState();
