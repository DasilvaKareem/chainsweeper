// Runtime dialogue helpers — pick lines from character packs without repeating
// the same one twice in a row per trigger category.

import { CHARACTER_PACKS, type CharacterId } from './arcade';

export type Channel = 'midMatch' | 'reactions';

// A single conversational beat shown in DialogueScene. `kind` controls which
// side of the screen the beat lands on and how it's styled:
//   champion → opponent voice (blue, left-offset)
//   mc       → player/operator response (warm tone, right-offset)
//   system   → narrator/system tone (centered, neutral)
//   aside    → hint/italicized aside (centered, dim italic)
export type DialogueSpeakerKind = 'champion' | 'mc' | 'system' | 'aside';

export interface DialogueBeat {
  kind: DialogueSpeakerKind;
  speaker?: string; // overrides the default label for the kind (e.g. champion name)
  // Character id (matches CharacterId in arcade.ts). When set on a champion
  // beat, DialogueScene swaps the right-side portrait to that character so
  // battle-royale / multi-champion scenes show whoever is currently speaking.
  speakerId?: string;
  line: string;
}

// Tiny helpers so callers writing arrays of plain strings don't have to repeat
// the kind on every entry.
export const sysBeats = (lines: string[]): DialogueBeat[] =>
  lines.map((line) => ({ kind: 'system', line }));

export const championBeat = (speaker: string, line: string): DialogueBeat => ({
  kind: 'champion', speaker, line,
});

export const mcBeat = (line: string): DialogueBeat => ({ kind: 'mc', line });

export const asideBeat = (line: string): DialogueBeat => ({ kind: 'aside', line });

export class ChatterPicker {
  private last: Record<Channel, string | null> = { midMatch: null, reactions: null };

  pick(characterId: CharacterId, channel: Channel): string | null {
    const pool = CHARACTER_PACKS[characterId]?.[channel] ?? [];
    if (pool.length === 0) return null;
    if (pool.length === 1) return pool[0];

    let line: string;
    let guard = 0;
    do {
      line = pool[Math.floor(Math.random() * pool.length)];
      guard++;
    } while (line === this.last[channel] && guard < 8);

    this.last[channel] = line;
    return line;
  }

  reset() {
    this.last.midMatch = null;
    this.last.reactions = null;
  }
}
