const GLOBAL_STYLE =
  'futuristic cyber interface sound, clean digital tone, minimal, sharp, responsive, high-tech UI, no background noise';

export type SfxSpec = {
  id: string;
  prompt: string;
  durationSeconds: number;
  loop?: boolean;
};

export const SFX: SfxSpec[] = [
  {
    id: 'click',
    prompt:
      'short futuristic UI click, soft digital tap, subtle high frequency tone, clean cyber interface feedback, minimal and responsive',
    durationSeconds: 0.5,
  },
  {
    id: 'success',
    prompt:
      'short satisfying digital confirmation sound, soft ascending tone, clean cyber success chime, light harmonic glow, positive but subtle',
    durationSeconds: 0.8,
  },
  {
    id: 'fail',
    prompt:
      'short digital error tone, soft low pitch blip, minimal negative feedback, clean UI error sound, not harsh, quick and controlled',
    durationSeconds: 0.5,
  },
  {
    id: 'danger',
    prompt:
      'subtle ticking digital pulse, increasing urgency, soft cyber warning tone, rhythmic beeping, minimal but tense, futuristic countdown feel',
    durationSeconds: 3.0,
    loop: true,
  },
  {
    id: 'core-triggered',
    prompt:
      'sharp digital rupture sound, glitch burst, distorted energy crack, quick cyber explosion, data corruption effect, punchy and impactful but short',
    durationSeconds: 0.8,
  },
  {
    id: 'win',
    prompt:
      'clean futuristic victory chime, smooth ascending tones, digital resonance, satisfying and elegant, short but rewarding cyber completion sound',
    durationSeconds: 1.8,
  },
  {
    id: 'lose',
    prompt:
      'soft descending digital tone, low energy fade, minimal cyber failure sound, subtle and calm, not harsh, short and clean',
    durationSeconds: 1.5,
  },
  {
    id: 'reveal-pop',
    prompt:
      'short energy pulse sound, soft digital pop, light glowing effect, clean UI feedback, quick and satisfying',
    durationSeconds: 0.5,
  },
  {
    id: 'stabilize-pulse',
    prompt:
      'smooth low frequency digital wave, soft expanding energy pulse, calm cyber resonance, subtle ambient feedback',
    durationSeconds: 1.5,
  },
  {
    id: 'turn-switch',
    prompt:
      'soft digital transition tone, quick futuristic whoosh, minimal interface shift sound, clean and smooth',
    durationSeconds: 0.5,
  },
];

export function fullPrompt(spec: SfxSpec): string {
  return `${GLOBAL_STYLE}. ${spec.prompt}`;
}
