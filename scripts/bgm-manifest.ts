const GLOBAL_STYLE =
  'anime-style orchestral soundtrack, visual novel mood, piano and strings lead, soft choir pads, minimal percussion, elegant and emotional, clean mix, loopable, no vocals';

export type BgmSpec = {
  id: string;
  title: string;
  vibe: string;
  prompt: string;
  musicLengthMs: number;
};

export const BGM: BgmSpec[] = [
  {
    id: 'menu-quiet-invitation',
    title: 'Quiet Invitation',
    vibe: 'calm, mysterious, welcoming',
    prompt:
      'anime orchestral music, gentle piano melody, soft strings, slow tempo, warm but slightly mysterious mood, minimal percussion, clean loopable menu theme',
    musicLengthMs: 60_000,
  },
  {
    id: 'system-awakening',
    title: 'Awakening',
    vibe: 'sterile, distant, controlled',
    prompt:
      'minimal orchestral ambient, sparse piano notes, light high strings, soft sustained tones, slow and measured, feeling of something starting, quiet and restrained, loopable',
    musicLengthMs: 45_000,
  },
  {
    id: 'stage1-still-water',
    title: 'Still Water',
    vibe: 'safe, balanced, serene',
    prompt:
      'calm anime piano and strings, simple repeating motif, soft harmony, peaceful and stable mood, no tension, gentle and clean, loopable',
    musicLengthMs: 75_000,
  },
  {
    id: 'stage2-flow',
    title: 'Flow',
    vibe: 'slightly more movement, still controlled',
    prompt:
      'light orchestral piece with piano lead and soft strings, gentle rhythm, subtle forward motion, balanced and composed atmosphere, calm but active, loopable',
    musicLengthMs: 75_000,
  },
  {
    id: 'fail-fading-signal',
    title: 'Fading Signal',
    vibe: 'quiet loss, reflection',
    prompt:
      'slow piano with soft strings, descending notes, melancholic but restrained, no heavy emotion, calm and reflective, short loop',
    musicLengthMs: 45_000,
  },
  {
    id: 'retry-return',
    title: 'Return',
    vibe: 'reset, determination',
    prompt:
      'soft piano melody rising gently, light strings underneath, hopeful but controlled, feeling of trying again, simple and clean, loopable',
    musicLengthMs: 45_000,
  },
  {
    id: 'trace-calculated-path',
    title: 'Calculated Path',
    vibe: 'precise, thoughtful',
    prompt:
      'structured orchestral piece, steady piano pattern, light strings in rhythm, controlled pacing, focused and analytical mood, clean and balanced, loopable',
    musicLengthMs: 90_000,
  },
  {
    id: 'glitch-fractured-rhythm',
    title: 'Fractured Rhythm',
    vibe: 'unstable but playful',
    prompt:
      'anime style music with uneven rhythm, piano phrases that slightly shift timing, light dissonance, playful but unsettling, controlled chaos, loopable',
    musicLengthMs: 90_000,
  },
  {
    id: 'proof-perfect-form',
    title: 'Perfect Form',
    vibe: 'rigid, exact, flawless',
    prompt:
      'minimalist piano and strings, repeating precise patterns, symmetrical phrasing, cold and controlled tone, no variation, extremely clean structure, loopable',
    musicLengthMs: 90_000,
  },
  {
    id: 'fork-rising-pressure',
    title: 'Rising Pressure',
    vibe: 'competitive, intense',
    prompt:
      'anime battle-style orchestral, strong piano chords, faster tempo, light percussion, energetic but refined, tension building, loopable',
    musicLengthMs: 90_000,
  },
  {
    id: 'patch-cracks-in-silence',
    title: 'Cracks in Silence',
    vibe: 'uneasy, questioning',
    prompt:
      'soft piano with slightly off harmony, gentle strings, subtle tension, uncertain mood, quiet instability, emotional but restrained, loopable',
    musicLengthMs: 90_000,
  },
  {
    id: 'root-authority',
    title: 'Authority',
    vibe: 'heavy, commanding',
    prompt:
      'dark orchestral track, low strings and piano, slow powerful progression, deep tones, strong presence, minimal movement, imposing atmosphere, loopable',
    musicLengthMs: 90_000,
  },
  {
    id: 'engineer-beyond-form',
    title: 'Beyond Form',
    vibe: 'empty, surreal, detached',
    prompt:
      'very minimal ambient orchestral, long sustained notes, almost no rhythm, distant piano tones, vast empty feeling, abstract and quiet, loopable',
    musicLengthMs: 90_000,
  },
  {
    id: 'critical-last-breath',
    title: 'Last Breath',
    vibe: 'critical, urgent, final moment',
    prompt:
      'tense anime orchestral, rapid piano pulses, low strings tremolo, rising harmonic tension, heartbeat-like rhythm, urgent and dramatic, final-stand emotional climax, elegant but unrelenting, loopable',
    musicLengthMs: 60_000,
  },
  {
    id: 'victory-fanfare',
    title: 'Ascension',
    vibe: 'triumphant, cathartic, uplifting',
    prompt:
      'triumphant anime orchestral victory fanfare, rising strings, powerful piano crescendo, soaring brass, cathartic emotional climax, uplifting resolution, short celebratory theme, clean resolution, anime-style victory motif',
    musicLengthMs: 30_000,
  },
  {
    id: 'engineer-villain-battle',
    title: 'The Rider',
    vibe: 'villainous, menacing, dramatic final boss',
    prompt:
      'dark villainous anime orchestral boss battle, heavy low strings, ominous choir pads, menacing piano progression, tense rhythmic pulse, dramatic brass stabs, deep foreboding atmosphere, anime final boss theme, intense and unrelenting, loopable',
    musicLengthMs: 90_000,
  },
];

export function fullPrompt(spec: BgmSpec): string {
  return `${GLOBAL_STYLE}. ${spec.prompt}`;
}
