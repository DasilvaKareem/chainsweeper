// Interactive tutorial for Floors 1 and 2. INIT-0 is a non-champion system
// voice that walks the player through core mechanics. The script is event-
// driven — each step waits for a specific player action (or auto-advances
// after a delay) before the next line appears.

export const TUTOR_SPEAKER = 'INIT-0';
export const TUTOR_ROLE = 'SYSTEM TUTOR';
// Matches the portrait filename (`public/assets/portraits/init0.png`) so
// VNScene auto-picks the chibi when INIT-0 speaks via the Floor 0 intro.
export const TUTOR_ID = 'init0';

// Floor 0 — the very first thing the player sees after picking Arcade.
// INIT-0 greets them directly before any narrator voice-over or tutorial.
// Each string is a VN page; the VNScene paginates them with a Continue click.
export const INIT_0_INTRO_PAGES: string[] = [
  "Hello, Coder.\n\n" +
    "Registration complete. I'm INIT-0 — your interface with the Grid. " +
    "Consider this Floor Zero.",
  "Think of me as your handler. " +
    "I don't run the trials — I just make sure you can. " +
    "Controls, pacing, mechanics, anything you need explained: that's on me.",
  "What you're about to enter is a recursive computational system. " +
    "Every Layer is a trial. Every trial has someone watching you. " +
    "Some of them want you to succeed. Most don't.",
  "Two primer floors first. " +
    "Floor One is a scripted walkthrough on a fixed board — I'll narrate every mechanic. " +
    "Floor Two is a calibration run: random 5×5 layout, same rules, you drive.\n\n" +
    "After that, the Floor Masters start watching. Ready when you are.",
];


export type TutorWait = 'none' | 'revealed' | 'marked' | 'end';

export interface TutorStep {
  text: string;
  waitFor: TutorWait;
  // When waitFor is 'none', the step auto-advances after this many ms.
  delay?: number;
  // When set alongside waitFor 'revealed' or 'marked', the tutorial renders a
  // pulsing ring on this tile and rejects clicks on any other tile. Coordinates
  // are board-space (x=col, y=row). The specific tiles below are hand-picked
  // against the deterministic Floor 1 board (seed 0xc0def00d) — each target
  // is either a zero-count cascade opener or a *provably* deducible core.
  target?: { x: number; y: number };
}

// Floor 1 board (seed 0xc0def00d, 6×6, 5 cores):
//   1 C 2 1 0 0
//   1 2 C 2 1 0
//   0 1 2 C 2 1
//   0 0 1 1 2 C
//   0 1 1 1 1 1
//   0 1 C 1 0 0
// Four guided hints, each with synced narration beats that keep the ring up
// while explaining *why* the tile is the right pick:
//   Hint 1 — reveal (0,4): zero-count cascade that opens the bottom-left.
//   Hint 2 — point at (1,4): the revealed "1" used to prove hint 3.
//   Hint 3 — mark (2,5): after cascade, (1,4)=1 has exactly one hidden
//            neighbor, so (2,5) is provably a Core.
//   Hint 4 — reveal (4,0): zero in the top-right, cascades the opposite half.
export const FLOOR_1_TUTORIAL: TutorStep[] = [
  {
    text:
      "I'm INIT-0. Every board hides Corruption Cores — your job is to reveal " +
      'everything else. Start here: left-click the pulsing tile.',
    waitFor: 'revealed',
    target: { x: 0, y: 4 },
  },
  {
    text:
      'Nice. That tile was a zero — no adjacent Cores — so its safe neighbors ' +
      'cascaded open automatically. Every number shows how many Cores touch it.',
    waitFor: 'none',
    delay: 4200,
  },
  {
    text:
      "Bar up top: your turn timer, sixty seconds here. " +
      "Three hearts on the score row — hit a Core, lose one. " +
      'Zero hearts ends the run.',
    waitFor: 'none',
    delay: 4800,
  },
  {
    text:
      "Time to deduce. Focus on the '1' highlighted now — one of the tiles you " +
      'just revealed.',
    waitFor: 'none',
    delay: 4200,
    target: { x: 1, y: 4 },
  },
  {
    text:
      'Count its hidden neighbors. It only touches one hidden tile — which means ' +
      "that one hidden tile *has* to be the Core the '1' is counting.",
    waitFor: 'none',
    delay: 5600,
    target: { x: 1, y: 4 },
  },
  {
    text:
      "Ring's moved to the deduced Core. Right-click it (or Shift+click) to " +
      'place a Quarantine Marker.',
    waitFor: 'marked',
    target: { x: 2, y: 5 },
  },
  {
    text:
      "That's the whole game: read the numbers, find the hidden tile that's " +
      'uniquely pinned, quarantine it, reveal the rest. Markers cost nothing if ' +
      "you're wrong — use them liberally.",
    waitFor: 'none',
    delay: 5600,
  },
  {
    text:
      'Last guided step — this top-right tile is another zero. Reveal it to ' +
      'cascade open the other half of the board.',
    waitFor: 'revealed',
    target: { x: 4, y: 0 },
  },
  {
    text:
      "From here you're on your own. Clear every safe tile to stabilize the Layer. " +
      'Three hearts, sixty seconds per turn — take your time.',
    waitFor: 'end',
  },
];

// Fixed seed so the tutorial board is deterministic — easier to reason about
// the written steps since the same layout always generates.
export const FLOOR_1_TUTORIAL_SEED = 0xc0def00d;

// Floor 2 — calibration run. Random 5×5, INIT-0 still narrates but with a
// much lighter touch: one opening nudge, one closer. The player applies what
// they learned on Floor 1 without a tile-by-tile walkthrough.
export const FLOOR_2_TUTORIAL: TutorStep[] = [
  {
    text:
      "Calibration run. New layout, same rules. " +
      "Reveal the safe tiles, quarantine the Cores. I'll stay quiet.",
    waitFor: 'none',
    delay: 4600,
  },
  {
    text:
      "If you're stuck, the numbers never lie. " +
      "Count adjacent hidden tiles against the number — that's the whole game.",
    waitFor: 'end',
  },
];
