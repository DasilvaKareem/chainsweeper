# Audio

MachineSweep's SFX and BGM are generated ahead of time via ElevenLabs and committed to `public/assets/audio/`. This is a **dev-time** pipeline — the shipped game never calls ElevenLabs, never ships the API key.

Intentional contrast: **SFX = cyber system** (the Grid's voice), **BGM = anime VN orchestra** (the Coder's inner life). The sterile interface plays against the emotional undercurrent of the climb.

## Regenerating

```bash
cp .env.example .env       # then paste ELEVENLABS_API_KEY into .env
pnpm gen:audio             # generate everything (cache-aware)
pnpm gen:audio --only sfx  # SFX only
pnpm gen:audio --only bgm  # BGM only
pnpm gen:audio --id click,danger       # specific ids (comma-sep, SFX or BGM)
pnpm gen:audio --force                 # ignore cache, regenerate all
```

`scripts/audio-lock.json` stores per-entry hashes — edit a prompt in the manifest and only that entry regenerates next run. Editing `GLOBAL_STYLE` at the top of a manifest invalidates every entry in that manifest.

## SFX — `public/assets/audio/sfx/`

Source: `scripts/sfx-manifest.ts`.

**Global style (auto-prepended):** *futuristic cyber interface sound, clean digital tone, minimal, sharp, responsive, high-tech UI, no background noise*

| id | duration | when to play |
| --- | --- | --- |
| `click` | 0.5s | Core selection / reveal tap |
| `success` | 0.8s | Stable Core revealed |
| `fail` | 0.5s | Wrong read / minor mistake |
| `danger` | 3.0s (loop) | Timer low / risk zone — loops under last 3s |
| `core-triggered` | 0.8s | **Corruption Core detonated** (the headline sound) |
| `win` | 1.8s | Layer Stabilized |
| `lose` | 1.5s | Layer Failed |
| `reveal-pop` | 0.5s | Single-cell reveal feedback |
| `stabilize-pulse` | 1.5s | Multiple Stable Cores revealed in a chain |
| `turn-switch` | 0.5s | Coder's turn begins |

> API floor on sound-generation is 0.5s, so anything the prompt guide calls "<0.3s" is pinned at 0.5s. Trim on the Phaser side if a specific cue feels long.

## BGM — `public/assets/audio/bgm/`

Source: `scripts/bgm-manifest.ts`.

**Global style (auto-prepended):** *anime-style orchestral soundtrack, visual novel mood, piano and strings lead, soft choir pads, minimal percussion, elegant and emotional, clean mix, loopable, no vocals*

### Core system

| id | title | vibe | length | when to play |
| --- | --- | --- | --- | --- |
| `menu-quiet-invitation` | Quiet Invitation | calm, mysterious, welcoming | 60s | Main menu |
| `system-awakening` | Awakening | sterile, distant, controlled | 45s | Boot / scene transitions |
| `stage1-still-water` | Still Water | safe, serene | 75s | Tutorial floor (IRIS intro) |
| `stage2-flow` | Flow | controlled motion | 75s | Early progression floors |

### Fail / retry

| id | title | vibe | length | when to play |
| --- | --- | --- | --- | --- |
| `fail-fading-signal` | Fading Signal | quiet loss, reflection | 45s | Failure screen |
| `retry-return` | Return | reset, determination | 45s | Retry screen |

### Floor masters

| id | title | champion | vibe | length |
| --- | --- | --- | --- | --- |
| `trace-calculated-path` | Calculated Path | TRACE (Analyst) | precise, thoughtful | 90s |
| `glitch-fractured-rhythm` | Fractured Rhythm | GLITCH (Breaker) | unstable, playful | 90s |
| `proof-perfect-form` | Perfect Form | PROOF (Solver) | rigid, flawless | 90s |
| `fork-rising-pressure` | Rising Pressure | FORK (Challenger) | competitive, intense | 90s |
| `patch-cracks-in-silence` | Cracks in Silence | PATCH (Fixer) | uneasy, questioning | 90s |
| `root-authority` | Authority | ROOT (Architect) | heavy, commanding | 90s |

> IRIS (Custodian) uses `stage1-still-water` / `stage2-flow` rather than a distinct battle theme — her floors are the calm stretches.

### Final stage

| id | title | vibe | length | when to play |
| --- | --- | --- | --- | --- |
| `engineer-beyond-form` | Beyond Form | empty, surreal, detached | 90s | Engineer reveal (post-floor 10) |

## Adding a new sound

1. Append an entry to `scripts/sfx-manifest.ts` or `scripts/bgm-manifest.ts`.
2. `pnpm gen:audio` — new id generates, existing ids stay cached.
3. Commit the manifest change and the new `.mp3` together.

## Don't

- Don't commit `.env` — gitignored.
- Don't call ElevenLabs from game code — runtime generation leaks the key and wastes credits.
- Don't hand-edit `scripts/audio-lock.json` — it's regenerated on each run.
