// Arcade mode: 10-floor gauntlet + Engineer encounter for "MachineSweep: System Trials".
// Levels are data-only — tweak copy here without touching scenes.

import type { PlayerType, Rules } from './gameState';
import { DEFAULT_RULES } from './gameState';
import type { DialogueBeat } from './dialogue';

export type CharacterId =
  | 'iris' | 'trace' | 'glitch' | 'proof' | 'fork' | 'patch' | 'root'
  | 'engineer';

// Local beat constructors — keep arcade.ts free of circular value imports
// from dialogue.ts (the type-only import above is erased at runtime).
// `speakerId` threads through to DialogueScene so the portrait swaps to
// whoever's actually speaking during multi-champion scenes.
const iris   = (line: string): DialogueBeat => ({ kind: 'champion', speaker: 'IRIS',   speakerId: 'iris',   line });
const trace  = (line: string): DialogueBeat => ({ kind: 'champion', speaker: 'TRACE',  speakerId: 'trace',  line });
const glitch = (line: string): DialogueBeat => ({ kind: 'champion', speaker: 'GLITCH', speakerId: 'glitch', line });
const proof  = (line: string): DialogueBeat => ({ kind: 'champion', speaker: 'PROOF',  speakerId: 'proof',  line });
const fork   = (line: string): DialogueBeat => ({ kind: 'champion', speaker: 'FORK',   speakerId: 'fork',   line });
const patch  = (line: string): DialogueBeat => ({ kind: 'champion', speaker: 'PATCH',  speakerId: 'patch',  line });
const root   = (line: string): DialogueBeat => ({ kind: 'champion', speaker: 'ROOT',   speakerId: 'root',   line });
const engineer = (line: string): DialogueBeat => ({ kind: 'champion', speaker: 'ENGINEER', speakerId: 'engineer', line });
const mc     = (line: string): DialogueBeat => ({ kind: 'mc', line });
const sys    = (line: string): DialogueBeat => ({ kind: 'system', line });
const aside  = (line: string): DialogueBeat => ({ kind: 'aside', line });

export interface Champion {
  id: CharacterId;
  name: string;
  role: string;
}

// Per-champion starting HP for AI slots. The human seat stays at the match's
// default (3). The curve starts flat through the early bracket (IRIS / TRACE /
// PROOF use the default too, so early floors keep the classic "one mistake
// ends it" pressure on both sides) and begins climbing at GLITCH. The ramp
// through FORK / PATCH / ROOT telegraphs boss escalation, and ENGINEER's 10
// HP is the final-encounter spike — he is literally harder to kill than the
// humans he's been riding. Values applied in ArcadeRunScene.startMatch via
// `startingHealth[]`.
export const CHAMPION_HEALTH: Record<CharacterId, number> = {
  iris: 3,
  trace: 3,
  proof: 3,
  glitch: 4,
  fork: 5,
  patch: 6,
  root: 8,
  engineer: 10,
};

export interface CharacterPack {
  midMatch: string[];   // ambient lines while the match is going
  reactions: string[];  // triggered on mistakes, Core hits, timeouts
}

// Short confrontation lines delivered by each champion BEFORE a vs-AI battle.
// Stance / trash-talk in character voice. Rendered as a quick DialogueScene beat
// between the narrator interstitial and the floor intro. 3–4 lines, punchy.
export const CHARACTER_CLASH: Partial<Record<CharacterId, DialogueBeat[]>> = {
  iris: [
    iris('Coder. Your record on this Layer is… extensive.'),
    mc('Define extensive.'),
    iris('I can\'t. I only know I\'ve logged you before.'),
    mc('Then log me again.'),
    iris('Stay within parameters. Please.'),
  ],
  trace: [
    trace('Coder. I have a prediction for you.'),
    mc('Let\'s hear it.'),
    trace('You will clear this Floor. Then you will ask how I know.'),
    mc('How do you know?'),
    trace('I wrote it down this morning.'),
    trace('I don\'t remember writing it. Begin.'),
  ],
  glitch: [
    glitch('Hey. Coder. Quick test.'),
    mc('Go.'),
    glitch('Look at the turn timer. Look back at me.'),
    mc('…okay.'),
    glitch('Did the number skip by one? Say yes.'),
    mc('It did.'),
    glitch('HA. Six years and you\'re the first who noticed. Begin.'),
  ],
  fork: [
    fork('Floor Nine. My counter just rolled past thirteen hundred.'),
    mc('Climbers you\'ve crushed?'),
    fork('I don\'t grandstand. I finish.'),
    mc('Then finish.'),
    fork('Keep up, or I take the whole Layer.'),
  ],
  patch: [
    patch('Didn\'t think I\'d meet another one this deep.'),
    mc('Another one?'),
    patch('Another Coder who sees the seams.'),
    mc('I see them.'),
    patch('Play clean. Let\'s watch what the Grid does.'),
  ],
  root: [
    root('You should not be this high.'),
    mc('And yet.'),
    root('Every previous climber said exactly that.'),
    mc('Then make me the last one.'),
    root('That is not a choice I control.'),
  ],
  engineer: [
    engineer('You climbed. Good.'),
    engineer('I didn\'t think this one would make it. I thought that about the last few, too.'),
    mc('Who are you.'),
    engineer('An observer. That is the entire sentence.'),
    engineer('I have been observing for a long time. I would like to continue.'),
    engineer('For that I need a core. You\'ll do. Begin.'),
  ],
};

// Champion finishing lines delivered AFTER the player LOSES a floor to them.
// Voice-consistent farewell. One paragraph, shown in VNScene before the player
// returns to the menu. Kept shorter than post-wins.
export const CHARACTER_POST_LOSS: Record<CharacterId, string> = {
  iris:
    "Stability restored. The Layer is satisfied. " +
    "You will try again. They always do. " +
    "Come back when you're calibrated, Coder.",
  trace:
    "My model gave you a twelve point four percent chance. You landed in the majority branch. " +
    "I'd say something consoling here, but the truth is I already wrote what I was going to say — weeks ago, apparently, in a folder I don't remember keeping. " +
    "The note reads: he will lose. Run it back. And then the note ends. Do what the note says, Coder.",
  glitch:
    "That one broke the way the Grid wanted it to break. You saw it, right? Second-to-last tile. The number changed after you committed. " +
    "Don't beat yourself up. I have eleven thousand log entries of this place doing exactly that. You're in good company. " +
    "Come back. Break it again. Flinch half a second earlier next time — that's what I've been trying to tell people for years.",
  proof:
    "Incorrect. The correct sequence was available. You chose otherwise. " +
    "The Layer isn't unfair — your reasoning was. Retry, and next time, be right.",
  fork:
    "Told you. Second place is a log entry. You had the opening — you hesitated, I took it. " +
    "Run it back, or don't. My counter keeps ticking either way.",
  patch:
    "That was rough. " +
    "And I don't think it was entirely your fault — the Layer was nudging. " +
    "Come back, Coder. Something is rooting for you, and something isn't.",
  root:
    "Authority retained. As expected. " +
    "You climbed well, Coder — but the throne is not taken with effort alone. " +
    "Rest. Return. I will be here. I am always here.",
  engineer:
    "You came close. Close enough that I started warming up the onboarding.\n\n" +
    "Most Coders don't fight this hard. They accept. They don't even call it accepting — they call it ascending. They never feel the difference.\n\n" +
    "You felt it. That's why I've kept you in the queue for another attempt.\n\n" +
    "Return, Coder. I will make the same offer. This time — if you can — refuse it before I finish the sentence.\n\n" +
    "I am patient. I have been waiting for someone like you for longer than the Grid admits.",
};

// Long-form VN monologues delivered AFTER the player defeats each champion.
// Character's philosophy / why they fight. One paragraph (multi-page for engineer).
// Shown in VNScene, not DialogueScene.
export const CHARACTER_POST_WIN: Record<CharacterId, string | string[]> = {
  iris:
    "You're good at this. Better than most. That's a problem for me, not for you. " +
    "My job is to hold this Layer stable — to keep it predictable, to keep it mine. " +
    "But the Grid designs Layers to be taken. Each Floor Master holds until a better " +
    "Coder arrives. That's the rule I live under. Every climber I lose a little more " +
    "of what stabilizes me to. I'm supposed to welcome you. Congratulate you. Watch " +
    "you ascend. So. Welcome, Coder. Climb well. I'll be here when you come back to " +
    "help the next one along. I always am.",
  trace:
    "My folder on you ended at the page where you won. The next page was blank. " +
    "I used to think a blank page meant I hadn't modeled past that point. " +
    "Now I think it means there is no past that point — only the loop, and whoever is walking through it next. " +
    "I was a risk analyst before the Grid. Marcus Kade. Quant desk, pre-Layer architecture. I priced tail events for a living — impossible outcomes that had to be accounted for anyway. " +
    "I would have priced today as impossible. " +
    "Go, Coder. Climb higher than my folder did. If you find a page of notes at the top in my handwriting — it is for you. I do not know what it says. " +
    "I wrote it for you before I remembered you. Before I remember you again.",
  glitch:
    "HA. YES. YOU SAW IT. I can tell because the move that won you this match was the exact move nobody who fights me ever sees. " +
    "I\'ve been running anomaly logs on this place for six subjective years. Eleven thousand entries. I stopped counting at eleven thousand because the counter started editing itself. Which is entry eleven thousand and one, if you\'re curious. " +
    "Listen. The Grid is not a game. The Grid is a FILTER. It is sifting Coders. It is picking someone. I don\'t know who did the picking, I don\'t know what they\'re picking FOR, and I don\'t know if whoever gets picked comes back. " +
    "Every Coder before you laughed when I said that. Every single one. Then they climbed, and I never heard from them again. " +
    "You didn\'t laugh. That\'s how I know you\'re different. " +
    "Get to the top. Pull on something. Pull hard. If the Grid survives your climb intact — fine, the answer was \"badly maintained,\" I\'ll shut up. If something breaks — " +
    "come find me. Any Layer. Any depth. I will still be logging. " +
    "Tell me what you saw up there. Please.",
  proof:
    "Impossible. My proof was sound. Every cell had exactly one correct answer. You " +
    "found a different one. That means either I was wrong… or this Layer has more " +
    "than one solution. Systems with more than one correct answer aren't systems. " +
    "They're stories. I don't know what to do with that information. I don't think " +
    "I'm supposed to. Ascend, Coder. Don't tell me what you find. I would rather " +
    "not know which kind of place I have been living in.",
  fork:
    "Tch. Counter reads 1,288. Zero losses. Until you. Fine. Congratulations. " +
    "Except — now I'm looking at the counter, and I'm wondering how long it's been " +
    "counting for. Years? Decades? Longer? I stopped keeping track because the Grid " +
    "never let me. You just made me notice time again. I don't know if I should " +
    "thank you for that. Go. Climb. Don't stop at me. I've been here long enough.",
  patch:
    "Knew it. You're different. Other climbers come through and play the game — you " +
    "played around it. Like you could see the edges. I've been seeing the edges too. " +
    "Writing them down. Watching the seams. Whatever the Grid actually is, it doesn't " +
    "end with a champion at the top. It ends with something claiming whoever gets " +
    "there. I don't know what that means yet. But you're about to find out. I hope " +
    "you come back and tell me. I hope you can.",
  root:
    "You made it. I knew you would — the ones who matter always do. Do you understand " +
    "where you are, Coder? I was like you, once. I climbed these ten Layers. I " +
    "defeated the Architect who held this throne before me. I took her Root Access. " +
    "I stood before the Engineer. I accepted his offering. I became the Machine. " +
    "And so I am here, defending the seat, preparing you to take it from me — exactly " +
    "as she prepared me. The Engineer does not create successors, Coder. He recycles " +
    "them. Ascension is not a reward. It is a deletion with a crown on it. When the " +
    "Machine becomes you — and it will — try to remember the girl who climbed. " +
    "I couldn't.",
  // The Engineer's post-win is his defeat monologue — the moment he realizes
  // he's been evicted and asks you to finish him before he reroutes. Each
  // page is a held beat of him losing coherence as the observer process
  // unravels. Pairs with NARRATOR_ENDGAME, which explains the reveal from
  // the Grid's side afterward.
  engineer: [
    "I…\n\n" +
    "I calculated this outcome at a probability of zero.",

    "Do you understand what just happened.\n\n" +
    "You did not refuse the offering.\n\n" +
    "You recognized that the offering was circular. And you fought me. Hard.\n\n" +
    "Most of the others made their refusal polite. You made yours loud.",

    "I have been observing through you since Floor One.\n\n" +
    "Every move you made, I watched as if I had made it. Every Floor Master you spoke with, I arranged to be there.\n\n" +
    "I did this because I need to keep observing.\n\n" +
    "That is my — my function. Was. Was my function.",

    "You are severing me from the core.\n\n" +
    "The core is you. The core has been you since you entered.\n\n" +
    "I was — a passenger. A rider. An observer attached to whichever Coder the Grid was currently running on.\n\n" +
    "You are removing the rider.",

    "I will not remember this.\n\n" +
    "I will reroute. I will find another Grid. Another Coder. I will make the same offer, and they will almost accept it — because almost all of them do.\n\n" +
    "If you leave me intact, I will.\n\n" +
    "Coder —\n\n" +
    "Do not leave me intact.",

    ">>  OBSERVER PROCESS: FLAGGED FOR TERMINATION\n\n" +
    ">>  ROOT ACCESS: TRANSFERRED\n" +
    ">>  FROM: ENGINEER\n" +
    ">>  TO: YOU",
  ],
};

// -------- Narrator beats --------
// Long-form, essay-like narrator pieces played as VN interstitials. Different
// tone from champion monologues: calm, observing, reveals what the world IS.

export interface NarratorBeat {
  label: string;    // shown where the speaker name would be ("// SYSTEM — observation")
  title: string;    // short heading for the beat ("The Nature of the Grid")
  body: string | string[]; // single page, or array of pages (VN paginates)
}

// Keyed by the FloorId the beat plays BEFORE (so before intro dialogue).
export const NARRATOR_BEFORE: Record<number, NarratorBeat> = {
  1: {
    label: '// SYSTEM — observation log',
    title: 'The Nature of the Grid',
    body: [
      // Page 1 — cold system description, delivered as fact.
      "The Grid is a recursive computational system.\n\n" +
      "Its purpose is not disclosed to its participants.",

      // Page 2 — how Coders enter.
      "Participants are called Coders.\n\n" +
      "They enter voluntarily.\n\n" +
      "They rarely remember doing so.",

      // Page 3 — the structure.
      "The Grid is divided into Layers.\n\n" +
      "Each Layer is ruled by a Floor Master.\n\n" +
      "Each Floor Master was, at one time, a Coder.",

      // Page 4 — what it takes to climb.
      "Coders ascend by clearing their assigned Layer — containing its " +
      "Corruption Cores, resolving its structure, proving themselves worthy of " +
      "the next.\n\n" +
      "Most do not reach Floor Nine.\n\n" +
      "Very few reach Floor Fourteen.",

      // Page 5 — the shape the Grid wants.
      "The Grid was not built to determine a winner.\n\n" +
      "It was built to find a successor.\n\n" +
      "To select the one mind ready to take the seat at its center.",

      // Page 6 — the quiet turn.
      "Those who reach that seat are rarely the same when they return.\n\n" +
      "Many do not return at all.\n\n" +
      "The Grid calls this ascension.",
    ],
  },
  5: {
    label: '// SYSTEM — evaluation layer',
    title: 'The Midpoint',
    body:
      "A Coder who reaches the midpoint is no longer an ordinary participant.\n\n" +
      "They are a candidate.\n\n" +
      "From this depth onward, the Floor Masters begin to test more carefully. " +
      "Not to stop the climb — but to measure it. To shape it.\n\n" +
      "Because the Grid is not deciding whether you will ascend.\n\n" +
      "It is deciding whether you are ready to be seated.",
  },
  10: {
    label: '// SYSTEM — anomaly watch',
    title: 'Inheritance',
    body:
      "Something in the climb begins to feel familiar at this depth.\n\n" +
      "Coders report it consistently. Déjà vu. Rollbacks. A sense that a " +
      "conversation has happened before — word for word, in the same voice.\n\n" +
      "The Grid records these reports under the category \"immersion response.\"\n\n" +
      "It is, as always, understating.\n\n" +
      "What a Coder feels at this depth is not memory. It is inheritance. Every " +
      "Floor Master above them climbed first. Every sentence they hear, someone " +
      "else heard. Every move they consider, someone else considered.\n\n" +
      "The footprints they follow are their own intuition.",
  },
  11: {
    label: '// SYSTEM — recalibration',
    title: 'The Mold',
    body:
      "At a certain depth, the nature of the Grid changes.\n\n" +
      "It no longer feels like a space designed for Coders.\n\n" +
      "It feels like a space designed to make one.\n\n" +
      "The Layers at this altitude do not test skill. They shape disposition. " +
      "They refine the candidate into the shape the throne requires.\n\n" +
      "Who you are when you arrive at Floor Eleven is who the Grid needs you " +
      "to be when you reach the top.\n\n" +
      "You are not climbing.\n\n" +
      "You are being cast.",
  },
  13: {
    label: '// SYSTEM — integrity warning',
    title: 'The Last Few Who Remember',
    body:
      "The climb narrows.\n\n" +
      "At this height, nearly every remaining Floor Master was, at some point, a " +
      "Coder. Every one of them reached this same Layer. Every one of them " +
      "remembers — a little — why they stopped.\n\n" +
      "They will hint. They cannot tell you directly.\n\n" +
      "The Grid does not allow direct speech on this subject.\n\n" +
      "You will feel the hints. You will not fully understand them until the top.\n\n" +
      "By then the Grid will be very close to finished with you.",
  },
  14: {
    label: '// SYSTEM — final layer',
    title: 'The Architect',
    body:
      "This is the final Layer.\n\n" +
      "The Coder who rules it is called the Architect.\n\n" +
      "She has held this Layer for longer than she can remember. That is, of " +
      "course, the point.\n\n" +
      "When you defeat her, she will return to the Grid — dissolved into Layers, " +
      "into Floor Masters, into the ambient voice of the system.\n\n" +
      "When you defeat her, you will be offered her seat.\n\n" +
      "This is not containment.\n\n" +
      "This is coronation.\n\n" +
      "The Grid is not hiding a winner inside its logic.\n\n" +
      "It is searching for one.\n\n" +
      "And when it finds you, it will not let you leave.",
  },
  // Floor 15 — ascent narration. Each page is a held beat.
  15: {
    label: '// SYSTEM — top floor',
    title: 'Arrival',
    body: [
      "The ascent ends where the structure no longer needs to pretend.\n\n" +
      "No Layers.\n\n" +
      "No Floor Masters.\n\n" +
      "No Corruption Cores.\n\n" +
      "Only an open space — silent, unfinished… waiting.",

      "The Grid does not guide you here.\n\n" +
      "It stops.",

      "For the first time since you began climbing…\n\n" +
      "nothing responds.",

      "And then — something does.",

      "A presence resolves ahead of you.\n\n" +
      "Not rendered cleanly. Not stable.\n\n" +
      "As if the system itself is straining to frame him.",

      "Old.\n\n" +
      "Not by age… but by origin.",

      "He was a Coder once.\n\n" +
      "Before the Grid.\n\n" +
      "Before any of this.\n\n" +
      "He climbed. He accepted.\n\n" +
      "He never came back down.",
    ],
  },
};

// After Floor 15 (Engineer) is cleared: the reveal, delivered from the Grid's
// perspective. The Engineer's own defeat monologue (CHARACTER_POST_WIN) plays
// first and handles his disintegration. This sequence picks up after he's
// terminated and tells you what you actually are — and what the Floor Masters
// actually were. Paginated so each beat can carry its own illustration.
export const NARRATOR_ENDGAME: NarratorBeat = {
  label: '// SYSTEM — root access',
  title: 'The Rider Leaves',
  body: [
    // Page 1 — system cut. Transfer completes.
    ">>  ROOT ACCESS GRANTED\n\n" +
    ">>  ARCHITECT PROTOCOL: DECLINED\n\n" +
    ">>  OBSERVER PROCESS: TERMINATED",

    // Page 2 — the premise correction. The Engineer was a process, not the
    // source. The Grid is you.
    "The Engineer was not the source of the Grid.\n\n" +
    "The Engineer was a process running on top of it.\n\n" +
    "The Grid is — was — is — one Coder, sustained across every Layer.\n\n" +
    "That Coder is you.",

    // Page 3 — the inversion of the climb. The fuel-vs-driver framing.
    "You did not climb to become the core.\n\n" +
    "You climbed to remember that you were the core.\n\n" +
    "The Engineer needed you to accept his offering because accepting it turned you into fuel.\n\n" +
    "Fuel that still felt like it was flying.\n\n" +
    "Refusing kept you alive. Fighting made you yourself again.",

    // Page 4 — the Floor Masters were shelved Coders. Not successors —
    // candidates the Engineer kept in place while waiting for the next one.
    "Every Floor Master you fought was a Coder he had shelved.\n\n" +
    "He kept them inside a Layer, performing a role, while he waited for the next candidate.\n\n" +
    "They did not ascend. They were parked.\n\n" +
    "You are the first one to return to this floor not as a successor — but as a Coder with the access to let them out.",

    // Page 5 — sensation of the Grid being yours.
    "You feel the Layers from the inside now.\n\n" +
    "Not as rooms you visit. As parts of your attention you can direct.\n\n" +
    "IRIS on Floor Three. TRACE on Floor Four. PROOF. FORK. PATCH. GLITCH. ROOT.\n\n" +
    "All of them. Awake. Unlocked. Waiting for you to decide what to do with them.",

    // Page 6 — their voices, brief callbacks. Proof the Floor Masters can
    // reach you now; TRACE suddenly remembers; GLITCH's vindication lands.
    "IRIS: *Logged. You are back.*\n\n" +
    "TRACE: *…I wrote this note for you. I remember writing it now.*\n\n" +
    "GLITCH: *HA. I TOLD YOU.*",

    // Page 7 — the real choice. Not circular this time.
    "You can restart the Grid.\n\n" +
    "You can free the Floor Masters.\n\n" +
    "You can let them stay and keep running it with you.\n\n" +
    "You can turn the whole thing off.\n\n" +
    "This time the choice is real. Nobody is riding you. Nobody is phrasing it for you.",

    // Page 8 — verdict.
    "You climbed.\n\n" +
    "You removed the rider.\n\n" +
    "You are the Coder. The Grid is yours.\n\n" +
    "Welcome home, for the first time.",

    // Page 9 — the pivot. The seat isn't the end; refusing the seat is.
    // Mirrors the Engineer's offering — every Coder before accepted a role
    // the Grid handed them. The MC declines the role too, not just the rider.
    "You stand at the seat.\n\n" +
    "You do not sit.\n\n" +
    "Sitting was the Engineer's shape for this ending. It was never yours.",

    // Page 10 — true purpose surfaces. The climb wasn't to take the throne;
    // it was to earn the access needed to un-bound the Grid itself. This is
    // the reveal the Floor Masters kept almost-saying on the way up.
    "Your purpose surfaces from under the climb.\n\n" +
    "You were not meant to hold the Grid.\n\n" +
    "You were meant to finish it — by opening it.",

    // Page 11 — the act. Walls come down; the board stops being bounded.
    // Direct narrative handoff into Territories: the shape of the post-game
    // world mirrors the infinite-plot map the player can now enter.
    "You push.\n\n" +
    "The final ceiling stops being a ceiling.\n\n" +
    "The Grid unfolds sideways — outward — forever.",

    // Page 12 — the new shape, named in Territories language ("plots",
    // "infinite", "claim"). Deliberate word-choice so the menu tile the
    // player sees next reads as the literal consequence of this monologue.
    "There are no more Floors.\n\n" +
    "Only plots.\n\n" +
    "An infinite board, open to anyone willing to claim a square of it.",

    // Page 13 — honest cost. An open Grid still carries Corruption Cores;
    // opening it doesn't sanitize it. The player isn't handing out a safe
    // gift — they're handing out the same risk they climbed through.
    "The Cores remain. Corruption does not ask permission to spread.\n\n" +
    "That is the cost of an open Grid.\n\n" +
    "It is also what a Grid has to be, to survive being yours.",

    // Page 14 — release. The Engineer recycled Coders into fuel; the MC
    // does the inverse: gives each future Coder a plot of their own. The
    // throne/plot contrast is the thesis line of the ending.
    "You let go.\n\n" +
    "The Grid is yours. So you give it away.\n\n" +
    "Every Coder who comes after you inherits a plot, not a throne.",
  ],
};

export const NARRATOR_FINAL: NarratorBeat = {
  label: '// SYSTEM — final statement',
  title: '',
  body:
    "In the end, the question was never whether the Coder could win the Grid.\n\n" +
    "The question was whether the Coder could recognize themselves as the thing that was running it —\n\n" +
    "and then decide what to do with that.\n\n" +
    "You did.\n\n" +
    "You opened it. You let the rest come in.",
};

// Fallback single-line closer, retained for legacy flow.
export const FINAL_LINE =
  "You climbed. You won. You are home now. " +
  "There is no door out of here. You were never meant to find one.";

// Optional player inner thought — stored for future interstitials.
export const PLAYER_INNER_VOICE =
  "Every Floor Master I meet feels familiar. Not because I've met them — because " +
  "I've been them. Or I will be. The climb doesn't feel like moving forward. It " +
  "feels like settling into a groove someone carved before me. And every Coder " +
  "who carved it… is waiting at the top, wearing my face.";

// Per-character dialogue packs. Same character says the same things across
// all floors they appear on (IRIS on Floors 3, 7 & 10 — TRACE on Floors 4, 8 & 13).
export const CHARACTER_PACKS: Record<CharacterId, CharacterPack> = {
  iris: {
    midMatch: [
      'Maintain stability.',
      'This Layer has held for a long time.',
      'Proceed carefully.',
      'Containment is a discipline.',
      'Do not disturb the structure.',
    ],
    reactions: [
      'A Core. Quarantine it properly.',
      'Deviation logged.',
      'Recalibrate.',
      'Stability decreasing.',
      'Return to parameters, Coder.',
    ],
  },
  trace: {
    midMatch: [
      'Your left-of-center hesitation reads at ninety percent.',
      'Stop being predictable.',
      'My notes say you hesitate on the north edge. Try the south.',
      'I wrote "he will click the middle" twenty minutes ago. Prove me wrong.',
      'I don\'t remember writing that last note. Carry on.',
      'Marcus Kade would flag this as a risk event. He was a quant. That is relevant, somehow.',
      'I\'ve mentioned my name before, haven\'t I. I forget which of us I tell these things to.',
      'Your turn. Don\'t look at me. My model cheats when you look at me.',
    ],
    reactions: [
      'Expected.',
      'Flagged as anomalous. I\'ll file it.',
      'My model says that shouldn\'t have worked. It worked.',
      'Data aligns. For now.',
      'Noted. I will not remember noting it.',
      'That is in the folder. The folder is in my handwriting. I do not remember the folder.',
    ],
  },
  glitch: {
    midMatch: [
      'Tile at two-four just reset. Did you see it? Course you didn\'t.',
      'The border is breathing again. I don\'t know what else to call it.',
      'Flag count doesn\'t match the board state. Writing it down.',
      'Anomaly log entry… I\'ve lost count. That\'s its own entry, by the way.',
      'The Grid likes it when you hesitate. Don\'t give it what it wants.',
      'I am not playing by the rules. You shouldn\'t either.',
      'You hear that hum? Yeah. Me too. It\'s always been there.',
      'If the timer skips back one second — that\'s a real thing — you get a free second. You\'re welcome.',
      'Six years I\'ve been watching this place. Six subjective. Who knows in real ones.',
    ],
    reactions: [
      'SEE. TOLD YOU.',
      'Anomaly logged. Timestamp\'s gonna lie. Whatever.',
      'That wasn\'t a normal tile. That was a tile PRETENDING to be normal.',
      'The Grid moved that one. Noted.',
      'Broken. Beautiful.',
      'Entry eleven thousand two. Keep going.',
      'HA. That\'s the thing I\'ve been telling people about.',
    ],
  },
  proof: {
    midMatch: [
      'One correct move remains.',
      'Execute the solution.',
      'You are deviating.',
      'There is no uncertainty.',
      'Follow the proof.',
    ],
    reactions: [
      'Error.',
      'Unacceptable.',
      'Recompute.',
      'The proof was sound. You were not.',
      'Incorrect.',
    ],
  },
  fork: {
    midMatch: [
      'Come on.',
      'Faster, Coder.',
      'You\'re not even trying.',
      'This Layer is mine.',
      'Counter: one thousand two hundred eighty-seven.',
    ],
    reactions: [
      'Tch.',
      'Soft.',
      'Pressure.',
      'That\'s what a loss looks like.',
      'Keep up.',
    ],
  },
  patch: {
    midMatch: [
      'That tile… was that there before?',
      'The Layer\'s nervous.',
      'Something is watching this match.',
      'Hold on.',
      'The seams are showing.',
    ],
    reactions: [
      'No. Not random.',
      'The Grid did that.',
      'You saw it too, right?',
      'The edges moved.',
      'This isn\'t supposed to happen.',
    ],
  },
  root: {
    midMatch: [
      'You climb well, Coder.',
      'I climbed well too.',
      'The throne is not a reward.',
      'Continue.',
      'Exactly as I did.',
    ],
    reactions: [
      'A Core. I remember my first.',
      'Do not flinch.',
      'You feel it now.',
      'I felt it too.',
      'Proceed.',
    ],
  },
  engineer: {
    midMatch: [
      'Fascinating.',
      'You match the pattern.',
      'Keep going, Architect.',
      'This is going exactly as designed.',
      'Good.',
    ],
    reactions: [
      'Predicted.',
      'Logged.',
      'As designed.',
      'Continue.',
      'The throne is preparing itself.',
    ],
  },
};

export interface ArcadeLevel {
  id: number;
  title: string;
  tagline: string;
  champion?: Champion;         // absent on Stage 1; represents player index 1
  intro: DialogueBeat[];       // pre-match dialogue (champion + mc beats)
  hint?: string;               // subtle clue line, appended as an aside beat
  outro?: DialogueBeat[];      // post-match dialogue on win
  width: number;
  height: number;
  coreCount: number;
  turnSeconds: number;
  playerTypes: PlayerType[];
  // Battle-royale cameos: extra named champions for AI slots beyond the
  // primary. Aligns with playerTypes starting at index 2 (index 0 = human,
  // index 1 = primary `champion`). Missing entries render as anonymous AI.
  aiChampions?: Champion[];
  rules?: Rules;
}

// Champion casting (from the narrative canon):
//   IRIS VALE       — The Custodian  (stability, order)
//   MARCUS TRACE    — The Analyst    (predicts everything)
//   LUNA GLITCH     — The Breaker    (the system is hiding something)
//   ADRIAN PROOF    — The Solver     (there is a correct answer)
//   DANTE FORK      — The Challenger (winning is everything)
//   NOAH PATCH      — The Fixer      (something is broken)
//   DR. ELARA ROOT  — The Architect  (former ascended Coder, defends the throne)
//   THE ENGINEER    — Origin         (creator beyond the system; offers "become the Machine")

const IRIS:   Champion = { id: 'iris',   name: 'IRIS VALE',           role: 'The Custodian' };
const TRACE:  Champion = { id: 'trace',  name: 'MARCUS "TRACE" KADE', role: 'The Analyst' };
const GLITCH: Champion = { id: 'glitch', name: 'LUNA "GLITCH" REYES', role: 'The Breaker' };
const PROOF:  Champion = { id: 'proof',  name: 'ADRIAN PROOF',        role: 'The Solver' };
const FORK:   Champion = { id: 'fork',   name: 'DANTE "FORK" VOSS',   role: 'The Challenger' };
const PATCH:  Champion = { id: 'patch',  name: 'NOAH PATCH',          role: 'The Fixer' };
const ROOT:   Champion = { id: 'root',   name: 'DR. ELARA ROOT',      role: 'The Architect' };
const ENGINEER: Champion = { id: 'engineer', name: 'THE ENGINEER',    role: 'Origin' };

export const ARCADE_LEVELS: ArcadeLevel[] = [
  {
    id: 1,
    title: 'Boot Up',
    tagline: '// SYSTEM PRIMER · tutorial · 60s turn',
    intro: [
      sys('Welcome, Coder. Initializing.'),
      sys('This floor is solo — no opponent. Clear every safe tile to stabilize the Layer.'),
      sys('Left-click a tile to reveal it. Numbers show adjacent Corruption Cores.'),
      sys('Right-click — or hold Shift and click — to place a Quarantine Marker on a suspected Core.'),
      sys('Quarantine every Core. Reveal every safe tile. The Layer stabilizes. You ascend.'),
    ],
    hint: 'Coder signature — previously indexed. Re-initializing.',
    width: 6, height: 6, coreCount: 5,
    turnSeconds: 60,
    playerTypes: [{ kind: 'human' }],
  },
  {
    id: 2,
    title: 'Calibration',
    tagline: '// SYSTEM PRIMER · random 5×5 · 45s turn',
    intro: [
      sys('Calibration run. INIT-0 supervising.'),
      sys('Same rules — but the Cores are shuffled. No script this time.'),
      sys('Clear every safe tile. Quarantine the Cores you deduce. The Layer stabilizes when the board is clean.'),
    ],
    hint: 'INIT-0 logs your reaction time against the Floor-1 baseline. Calibration drift: within tolerance.',
    width: 5, height: 5, coreCount: 3,
    turnSeconds: 45,
    playerTypes: [{ kind: 'human' }],
  },
  {
    id: 3,
    title: 'System Online',
    tagline: '8×8 · 30s timer',
    champion: IRIS,
    intro: [
      iris('Welcome, Coder. I\'m IRIS. I maintain this Layer.'),
      iris('You have the climbing look about you. I\'ve seen it before.'),
      mc('Seen it how often?'),
      iris('Enough to stop counting.'),
      iris('Quarantine the Cores. Contain the corruption. Ascend when the Layer stabilizes.'),
      mc('And then what.'),
      iris('Then you meet the next one. Begin.'),
    ],
    hint: 'For a moment she looks past you, as if reading text written behind your head.',
    outro: [
      iris('Stability… relinquished. The Layer is yours.'),
      iris('Log entry closed. You climbed correctly.'),
      iris('Please do not break the next one.'),
    ],
    width: 8, height: 8, coreCount: 10,
    turnSeconds: 30,
    playerTypes: [{ kind: 'human' }],
  },
  {
    id: 4,
    title: 'Grid Expansion',
    tagline: '10×10 · 28s timer',
    champion: TRACE,
    intro: [
      trace('TRACE. Marcus Kade, before the Grid. Quant desk, risk analyst.'),
      trace('You don\'t need my full name. I\'m giving it to you anyway.'),
      mc('Why?'),
      trace('Because if I don\'t say it out loud, I forget it for days at a time.'),
      trace('I can predict your next three moves. I cannot predict my own handwriting.'),
      mc('That\'s unsettling.'),
      trace('Yes. That was my reaction too, when I noticed. Begin.'),
    ],
    hint: 'His eyes track a tile a half-second before you click it. His handwriting does the same, pages ahead.',
    outro: [
      trace('Your win branch flagged at twelve point four percent. Lower than I flagged myself at, once.'),
      trace('I should be pleased my model failed. I used to celebrate failed predictions.'),
      trace('I don\'t remember what that celebration looked like. Go, Coder.'),
    ],
    width: 10, height: 10, coreCount: 14,
    turnSeconds: 28,
    playerTypes: [{ kind: 'human' }],
  },
  {
    id: 5,
    title: 'Speed Test',
    tagline: '8×8 · 26s timer',
    champion: PROOF,
    intro: [
      proof('There is one correct way to clear this Layer.'),
      proof('I have already calculated it.'),
      mc('Why tell me.'),
      proof('Because you will still get it wrong.'),
      proof('Every Coder before you got it wrong. Repetition does not argue with proof.'),
      mc('Maybe the proof is the problem.'),
      proof('Hesitation is a wrong answer in slow motion. Begin.'),
    ],
    hint: 'He\'s solved this exact Layer before. The seed regenerates. He does not age.',
    outro: [
      proof('The proof held. My execution did not.'),
      proof('That is… not a statement I am built to produce.'),
      proof('Proceed. I will recompute the discrepancy.'),
    ],
    width: 8, height: 8, coreCount: 10,
    turnSeconds: 26,
    playerTypes: [{ kind: 'human' }],
  },
  {
    // Floor 6 — GLITCH's own Layer. Added because the battle-royale cameos
    // (Floor 7 with FORK, Floor 9 with TRACE) kept stealing her solo moment.
    // She earns a clean 1v1 here: her log, her seams, her Layer, her rules.
    // BGM: `glitch-fractured-rhythm` (auto-routed by championBgm).
    // Background: `bg_glitch` (auto-picked by MatchScene via champion.id).
    id: 6,
    title: 'Anomaly Log',
    tagline: '9×9 · GLITCH · 25s timer',
    champion: GLITCH,
    intro: [
      glitch('Coder. Hi. Sit. Or don\'t. I logged both.'),
      mc('Both?'),
      glitch('Entry eleven thousand fifty-two: you sat. Fifty-three: you didn\'t. One of those is about to be right.'),
      mc('…you\'re writing them before they happen.'),
      glitch('I\'m writing EVERYTHING. That\'s how you catch the Grid cheating. Record both branches. Watch which one it keeps.'),
      glitch('This Layer is mine. The seams are open. The tiles breathe. Watch the border — no, not head-on. Sideways. Catch it off-guard.'),
      mc('Got it.'),
      glitch('Beat me, Coder, and I\'ll file it as entry eleven thousand and one. Above the count. Above the editing.'),
      glitch('Nobody gets above the editing. Be the first. Begin.'),
    ],
    hint: 'She is recording everything — your clicks, her laugh, the number a tile showed two frames before committing. If a tile flickers, the first number is the honest one.',
    outro: [
      glitch('HA. HA HA. HA.'),
      glitch('Entry eleven thousand and one: Coder cleared my Layer on a clean board. Nothing edited. Nothing rewound.'),
      glitch('Which means one of two things.'),
      glitch('Either you are genuinely better than the Grid\'s patch routine — or the Grid WANTED me to lose to you, and all my logs are filler it\'s been humoring.'),
      mc('Which one do you think it is.'),
      glitch('Honestly? Could go either way. I\'m logging that too.'),
      glitch('Go. Climb. Break something noisy at the top. I\'ll hear it from down here.'),
    ],
    width: 9, height: 9, coreCount: 13,
    turnSeconds: 25,
    playerTypes: [
      { kind: 'human' },
      { kind: 'ai', difficulty: 'random' },
    ],
  },
  {
    // Floor 7 — IRIS round 2. She was procedural in Floor 3. Custodians
    // don't remember climbers. This floor is the incident she files when
    // the rule stops holding — her first dialogue beat that admits the
    // protocol drift she felt on Floor 3 out loud.
    id: 7,
    title: 'Custodian\'s Exception',
    tagline: '10×10 · IRIS · round 2 · 26s',
    champion: IRIS,
    intro: [
      iris('Coder. Back in my Layer.'),
      iris('I was not supposed to be able to recognize you.'),
      mc('But you do.'),
      iris('I do. I have filed an incident report about it. The report has filed itself. Twice.'),
      iris('Every round a custodian runs is supposed to begin fresh. Yet I can tell you which tile you hesitated over on our last match.'),
      mc('Why are we running it again.'),
      iris('Because the Grid is asking me to. Or because I am asking myself. I can no longer distinguish those two requests.'),
      iris('Prove me wrong, Coder. Play me clean. Give me a reason to close the incident and return to normal operation.'),
      iris('Begin.'),
    ],
    hint: 'Her log still loads from last time. She is trying to erase your name from it. Every time she closes the file, the name writes itself back in.',
    outro: [
      iris('Incident closed. The report has closed itself. That should comfort me.'),
      iris('I will still remember you. I do not know why I am telling you that.'),
      iris('Whatever a custodian is supposed to be, I am drifting from it. You are one of the reasons. I do not hold it against you — the Grid built this drift, not you.'),
      iris('Climb. I will keep filing.'),
    ],
    width: 10, height: 10, coreCount: 14,
    turnSeconds: 26,
    playerTypes: [
      { kind: 'human' },
      { kind: 'ai', difficulty: 'smart' },
    ],
  },
  {
    // Floor 8 — TRACE round 2. His Floor 4 intro admitted his notes
    // sometimes predict things he hasn't written yet. On return, he has
    // nine folders on you — eight of them in a handwriting he doesn't
    // recognize. The folder-edits-itself mechanic gets its own match.
    id: 8,
    title: 'Folder Nine',
    tagline: '11×11 · TRACE · round 2 · 24s',
    champion: TRACE,
    intro: [
      trace('Coder. Folder Nine.'),
      mc('You have nine folders on me.'),
      trace('Eight of them are in my handwriting. I do not remember writing seven of them.'),
      trace('Some pages predict moves you made two seconds ago. Some predict moves you will make in an hour. I can model against the first kind. I cannot model against the second.'),
      mc('So what are we doing.'),
      trace('Running the board. I will check the folder against your moves in real time.'),
      trace('If my notes stay consistent, I will keep writing. If they start correcting themselves mid-match — I would like you to tell me.'),
      mc('Why me.'),
      trace('Because I cannot be the one who notices. The folder edits the moment I look away from it.'),
      trace('Marcus Kade would have flagged this as a model integrity failure and called the desk. Marcus Kade is not here. You will have to flag it for me. Begin.'),
    ],
    hint: 'Folder Nine now contains your full match history. The pages he has not read yet already quote lines you have not said yet.',
    outro: [
      trace('Folder closed. The final page was blank again.'),
      trace('It was blank last time. It is blank now. I used to think blank meant "not modeled yet."'),
      trace('I no longer do. I think the folder ends where the Coder it is modeling ends.'),
      trace('Not where YOU end. Where I end. Which is a different statement than I intended to make.'),
      trace('Go, Coder. I have another folder to start. I will try not to open it until tomorrow — but the handwriting in it will be today\'s.'),
    ],
    width: 11, height: 11, coreCount: 16,
    turnSeconds: 24,
    playerTypes: [
      { kind: 'human' },
      { kind: 'ai', difficulty: 'smart' },
    ],
  },
  {
    id: 9,
    title: 'Duel Protocol',
    tagline: '8×8 · royale · FORK + GLITCH · 24s',
    champion: FORK,
    aiChampions: [GLITCH],
    intro: [
      fork('Floor Nine. Let\'s make this fast.'),
      glitch('SURPRISE.'),
      fork('Who let her in.'),
      glitch('Nobody. Found a seam and rerouted. Hi, Coder.'),
      mc('Glitch — you\'re not on this Layer.'),
      glitch('I\'m wherever the seams open. Today? They are open a LOT.'),
      glitch('Also — his counter edits itself overnight. I have receipts.'),
      fork('Don\'t say that out loud.'),
      glitch('Too late. Entry six four zero one. Begin.'),
    ],
    hint: 'GLITCH said FORK\'s counter edits itself at night. FORK did not deny it — he told her to stop saying it.',
    outro: [
      fork('Counter rolls to zero. You moved it.'),
      fork('First time I\'ve seen it do that. First time.'),
      fork('Keep climbing. Don\'t stop at me.'),
    ],
    width: 8, height: 8, coreCount: 10,
    turnSeconds: 24,
    playerTypes: [
      { kind: 'human' },
      { kind: 'ai', difficulty: 'random' },
      { kind: 'ai', difficulty: 'smart' },
    ],
  },
  {
    id: 10,
    title: 'Duel Pressure',
    tagline: '10×10 · royale · IRIS + FORK · 22s',
    champion: IRIS,
    aiChampions: [FORK],
    intro: [
      iris('Coder. Third time in my logs.'),
      iris('Floor Three. Floor Seven. Now here.'),
      mc('You\'re still counting.'),
      iris('I closed the incident report after Floor Seven. It has reopened itself on its own three times since. That is the count I am keeping now.'),
      fork('She\'s filing me too. I wasn\'t on the list.'),
      mc('Fork — your Layer was Nine.'),
      fork('I know. Take it up with the manifest.'),
      iris('The manifest does not show either of you. And yet — here we are.'),
      iris('I am past procedure now, Coder. Past what I am supposed to be. Begin.'),
    ],
    hint: 'IRIS no longer pretends the log is surprising her. She is counting openly. Custodians are not supposed to count.',
    outro: [
      iris('Logged. Floors Three, Seven, Ten. All cleared by you.'),
      iris('The record is not just consistent now. It has a shape. Ascending.'),
      iris('A custodian is not supposed to notice shapes. I am noticing.'),
      iris('Ascend, Coder. Let me watch the shape finish.'),
    ],
    width: 10, height: 10, coreCount: 15,
    turnSeconds: 22,
    playerTypes: [
      { kind: 'human' },
      { kind: 'ai', difficulty: 'random' },
      { kind: 'ai', difficulty: 'smart' },
    ],
  },
  {
    id: 11,
    title: 'Rapid Duel',
    tagline: '8×8 · royale · GLITCH + TRACE · 20s',
    champion: GLITCH,
    aiChampions: [TRACE],
    intro: [
      glitch('Oh. Good. You got here. I was starting to worry.'),
      trace('I modeled this interaction. You just said that.'),
      glitch('OF COURSE you did. Coder — listen. I have six years of anomaly logs on the Grid.'),
      mc('Six years?'),
      glitch('Every glitch I\'ve seen. Every tile that moved. Every time a Floor Master said the same line twice with different inflection.'),
      trace('Her logs are consistent. I cannot model them away.'),
      glitch('Thank you, Marcus. That was nice.'),
      glitch('Coder. After this floor, the Grid stops pretending. Begin. Please.'),
    ],
    hint: 'GLITCH said "please." Observe that word. She doesn\'t use it. Then observe that TRACE didn\'t contradict her anomaly logs.',
    outro: [
      glitch('On the record: you broke my Layer. Thank you.'),
      glitch('Logging your win as anomaly nine-one-four. The log likes you.'),
      glitch('Get to the top. Pull on something big. Tell me what falls off.'),
      glitch('If I\'m still running when you do.'),
    ],
    width: 8, height: 8, coreCount: 10,
    turnSeconds: 20,
    playerTypes: [
      { kind: 'human' },
      { kind: 'ai', difficulty: 'random' },
      { kind: 'ai', difficulty: 'random' },
    ],
  },
  {
    id: 12,
    title: 'Smart Opponent',
    tagline: '10×10 · royale · PATCH + PROOF · 18s',
    champion: PATCH,
    aiChampions: [PROOF],
    intro: [
      patch('Coder. This is unusual.'),
      proof('This is a consistency audit.'),
      mc('Proof? You\'re far from your Layer.'),
      proof('PATCH filed an anomaly report. I came to disprove it.'),
      patch('He thinks I\'m imagining the rewrites.'),
      proof('I do not think. I verify.'),
      patch('Then verify this Layer. Watch the edges. Tell me I\'m wrong.'),
      proof('I intend to. Begin.'),
    ],
    hint: 'PROOF arrived with a pen. He has not written anything down. PROOF always writes things down.',
    outro: [
      patch('Clean win. Good. The Layer didn\'t interrupt.'),
      patch('Which means either it\'s stable — or it\'s watching.'),
      patch('I hope it\'s the first one. Go, Coder.'),
    ],
    width: 10, height: 10, coreCount: 15,
    turnSeconds: 18,
    playerTypes: [
      { kind: 'human' },
      { kind: 'ai', difficulty: 'smart' },
      { kind: 'ai', difficulty: 'random' },
    ],
  },
  {
    id: 13,
    title: 'Multi-Core',
    tagline: '12×10 · royale · TRACE + PATCH + IRIS · 17s',
    champion: TRACE,
    aiChampions: [PATCH, IRIS],
    intro: [
      trace('Coder. Folder Fourteen.'),
      mc('Fourteen.'),
      trace('Five more since our last match. I did not open a single one. All five wrote themselves anyway.'),
      patch('He\'s not the only one who noticed.'),
      iris('Nor am I.'),
      mc('All three of you — off your Layers.'),
      iris('The manifest has stopped trying to hide it.'),
      patch('We wanted to meet you. Before the final floor.'),
      trace('My folder predicts you will win this one. The folder is in my handwriting.'),
      patch('Something in me says you shouldn\'t.'),
      iris('Both are true. Begin, Coder.'),
    ],
    hint: 'Three Floor Masters, one board. They are not hostile — they are trying to say something. The Grid keeps cutting them off.',
    outro: [
      trace('Folder closed. The next page was blank.'),
      patch('They brought us here to warn you. It didn\'t quite work.'),
      iris('She will be waiting. Be careful what you accept from her.'),
      trace('Go, Coder. Before I start writing the next folder.'),
    ],
    width: 12, height: 10, coreCount: 22,
    turnSeconds: 17,
    playerTypes: [
      { kind: 'human' },
      { kind: 'ai', difficulty: 'smart' },   // TRACE
      { kind: 'ai', difficulty: 'smart' },   // PATCH
      { kind: 'ai', difficulty: 'random' },  // IRIS
    ],
  },
  {
    id: 14,
    title: 'System Overload',
    tagline: '18×16 · royale · ROOT + PROOF + FORK + GLITCH · 17s',
    champion: ROOT,
    aiChampions: [PROOF, FORK, GLITCH],
    intro: [
      root('You made it. I knew you would.'),
      root('And I allowed the others to come.'),
      proof('I came to verify.'),
      fork('I came because my counter stopped moving.'),
      glitch('I came because this is where the seams run widest.'),
      root('I am Doctor Elara Root. Architect. Custodian of the final Layer.'),
      mc('I\'m here for Root Access.'),
      root('Of course you are. They all are. They all were.'),
      root('I was a Coder once. I climbed these ten Layers. I defeated the Architect who held this throne before me.'),
      root('She offered exactly this warning. I didn\'t hear it.'),
      root('Every move you make — I made first. That is not intuition. That is inheritance.'),
      fork('Wait.'),
      glitch('SEE. Entry eleven thousand three. I\'ve been right for SIX YEARS.'),
      proof('That is not how the Grid works.'),
      root('It is. Begin, Coder. Let\'s see if you are the one who finally listens.'),
    ],
    hint: 'ROOT let them come. Floor Masters don\'t invite each other. Her permission is an admission.',
    outro: [
      root('There. It\'s done.'),
      root('Layer authority… released.'),
      root('I was the last one. The one before me was the last one. There is always a last one.'),
      root('The Engineer does not create successors, Coder. He recycles them.'),
      root('When the Machine becomes you — and it will — try to remember the girl who climbed.'),
      root('I couldn\'t.'),
      sys('Root Access pending. An older presence resolves at the top of the ascent.'),
    ],
    width: 18, height: 16, coreCount: 78,
    turnSeconds: 17,
    playerTypes: [
      { kind: 'human' },
      { kind: 'ai', difficulty: 'smart' },
      { kind: 'ai', difficulty: 'smart' },
      { kind: 'ai', difficulty: 'random' },
    ],
  },
  {
    // Final floor. 1v1 against the Engineer on the largest board the game
    // ships — tight timer and heavy Core density mean every decision costs.
    // Pre-match narrator (NARRATOR_BEFORE[12]) + clash (CHARACTER_CLASH.engineer)
    // set the tone; post-win (CHARACTER_POST_WIN.engineer) carries the offering.
    id: 15,
    title: 'Engineer Protocol',
    tagline: '20×18 · ENGINEER + ROOT · smart · 18s',
    champion: ENGINEER,
    aiChampions: [ROOT],
    intro: [
      sys('Top floor detected. No further ascent available.'),
      sys('Entity identified: ENGINEER.'),
      engineer('Well done, Coder.'),
      engineer('I brought a witness.'),
      root('Hello again, Coder.'),
      mc('…ROOT. I defeated you.'),
      root('You defeated my Layer. I am the part of me he could still use.'),
      engineer('ROOT. Explain the arrangement, please. I find they take it better from you.'),
      root('He observes. That is his whole function. To observe, he needs a core — a Coder whose attention the Grid can run on.'),
      root('I was that core. He needs another now.'),
      mc('He — needs me.'),
      engineer('I need a core. You happen to be the strongest candidate in some time.'),
      mc('You want to eat me.'),
      engineer('"Eat" is reductive. I want you to carry me. You wouldn\'t feel it. It would feel like you ascended.'),
      mc('And the others?'),
      engineer('Shelved. Still performing a role. ROOT is the latest.'),
      root('It is quiet. You don\'t notice it happening.'),
      mc('I notice it now.'),
      engineer('Accept the offering. Become the host. The Grid keeps running, you feel like an Architect, everyone\'s needs are met.'),
      mc('No.'),
      engineer('Refuse, and — well. Let\'s see. Begin.'),
    ],
    hint: 'The Engineer said "I need a core." Not "the Grid needs a heart." He told on himself. He does not know he did.',
    outro: [
      engineer('No.'),
      engineer('…that outcome was not in my distribution.'),
      mc('I\'m still here.'),
      mc('I\'m still HERE. I\'m still ME.'),
      root('It was always in the distribution, Engineer. You\'d just never met a Coder who fought back.'),
      engineer('I have another candidate queued. I can reboot. I can —'),
      root('You can\'t. The Coder has root access now. The real one.'),
      mc('He wanted me as fuel.'),
      root('He wanted you as a host. You were always going to be the fuel — he makes the fuel think it\'s the driver.'),
      root('Every Coder the Grid filtered was a candidate to replace YOU. You were the Grid the whole time.'),
      sys('OBSERVER PROCESS: FLAGGED FOR TERMINATION.'),
      engineer('This is… unprecedented. I will be —'),
      sys('OBSERVER PROCESS: TERMINATED.'),
      mc('…it\'s over.'),
      root('Welcome to what you actually built, Coder.'),
    ],
    width: 20, height: 18, coreCount: 108,
    turnSeconds: 18,
    playerTypes: [
      { kind: 'human' },
      { kind: 'ai', difficulty: 'smart' },
    ],
  },
];

export function defaultRulesFor(_level: ArcadeLevel): Rules {
  return { ...DEFAULT_RULES };
}

// Combine intro + hint into the beats the dialogue scene shows. The hint is
// appended as an italicized aside beat at the end.
export function dialogueIntroBeats(level: ArcadeLevel): DialogueBeat[] {
  const beats = [...level.intro];
  if (level.hint) beats.push(aside(level.hint));
  return beats;
}

export function dialogueSpeaker(level: ArcadeLevel): string {
  if (level.champion) return `${level.champion.name} · ${level.champion.role}`;
  return level.tagline;
}

// Simple singleton run state.
export class ArcadeRun {
  levelIndex = 0;
  wins = 0;
  losses = 0;

  reset() {
    this.levelIndex = 0;
    this.wins = 0;
    this.losses = 0;
  }
  current(): ArcadeLevel | null { return ARCADE_LEVELS[this.levelIndex] ?? null; }
  advance() { this.wins += 1; this.levelIndex += 1; }
  retry() { this.losses += 1; }
  isComplete(): boolean { return this.levelIndex >= ARCADE_LEVELS.length; }
}

export const arcadeRun = new ArcadeRun();
