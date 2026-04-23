import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BGM, fullPrompt as fullBgmPrompt } from './bgm-manifest.ts';
import { SFX, fullPrompt as fullSfxPrompt, type SfxSpec } from './sfx-manifest.ts';

const API_KEY = process.env.ELEVENLABS_API_KEY;
if (!API_KEY) {
  console.error('Missing ELEVENLABS_API_KEY. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_SFX = join(ROOT, 'public/assets/audio/sfx');
const OUT_BGM = join(ROOT, 'public/assets/audio/bgm');
const LOCK_PATH = join(ROOT, 'scripts/audio-lock.json');

type Lock = Record<string, string>;

async function loadLock(): Promise<Lock> {
  if (!existsSync(LOCK_PATH)) return {};
  return JSON.parse(await readFile(LOCK_PATH, 'utf8'));
}

async function saveLock(lock: Lock): Promise<void> {
  await writeFile(LOCK_PATH, JSON.stringify(lock, null, 2) + '\n');
}

function hashOf(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16);
}

async function post(url: string, body: unknown): Promise<Buffer> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': API_KEY as string,
      'content-type': 'application/json',
      accept: 'audio/mpeg',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

function fetchSfx(spec: SfxSpec): Promise<Buffer> {
  return post('https://api.elevenlabs.io/v1/sound-generation', {
    text: fullSfxPrompt(spec),
    duration_seconds: spec.durationSeconds,
    loop: !!spec.loop,
  });
}

function fetchMusic(prompt: string, musicLengthMs: number): Promise<Buffer> {
  return post('https://api.elevenlabs.io/v1/music', {
    prompt,
    music_length_ms: musicLengthMs,
  });
}

function parseArgs(argv: string[]): { only: 'sfx' | 'bgm' | null; force: boolean; ids: Set<string> | null } {
  const only = argv.includes('--only') ? (argv[argv.indexOf('--only') + 1] as 'sfx' | 'bgm') : null;
  const force = argv.includes('--force');
  const idArgIdx = argv.indexOf('--id');
  const ids = idArgIdx !== -1 ? new Set(argv[idArgIdx + 1].split(',')) : null;
  return { only, force, ids };
}

async function main(): Promise<void> {
  const { only, force, ids } = parseArgs(process.argv.slice(2));

  await mkdir(OUT_SFX, { recursive: true });
  await mkdir(OUT_BGM, { recursive: true });
  const lock = await loadLock();

  let generated = 0;
  let skipped = 0;

  if (only !== 'bgm') {
    for (const spec of SFX) {
      if (ids && !ids.has(spec.id)) continue;
      const key = `sfx/${spec.id}`;
      const hash = hashOf({ prompt: fullSfxPrompt(spec), d: spec.durationSeconds, loop: !!spec.loop });
      const out = join(OUT_SFX, `${spec.id}.mp3`);
      if (!force && lock[key] === hash && existsSync(out)) {
        skipped++;
        continue;
      }
      process.stdout.write(`[sfx] ${spec.id} (${spec.durationSeconds}s${spec.loop ? ', loop' : ''})… `);
      const buf = await fetchSfx(spec);
      await writeFile(out, buf);
      lock[key] = hash;
      generated++;
      console.log(`${(buf.length / 1024).toFixed(1)}KB`);
    }
  }

  if (only !== 'sfx') {
    for (const spec of BGM) {
      if (ids && !ids.has(spec.id)) continue;
      const key = `bgm/${spec.id}`;
      const hash = hashOf({ prompt: fullBgmPrompt(spec), len: spec.musicLengthMs });
      const out = join(OUT_BGM, `${spec.id}.mp3`);
      if (!force && lock[key] === hash && existsSync(out)) {
        skipped++;
        continue;
      }
      process.stdout.write(`[bgm] ${spec.id} (${spec.musicLengthMs}ms)… `);
      const buf = await fetchMusic(fullBgmPrompt(spec), spec.musicLengthMs);
      await writeFile(out, buf);
      lock[key] = hash;
      generated++;
      console.log(`${(buf.length / 1024).toFixed(1)}KB`);
    }
  }

  await saveLock(lock);
  console.log(`\ndone — generated ${generated}, skipped ${skipped} (cached)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
