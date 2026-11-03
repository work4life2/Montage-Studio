import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { download, zip } from "../media/util.js";
import { probeDuration } from "../media/edit.js";
import { costPlus, gasLine, llmLine, num } from "../pricing.js";
import { chatJson } from "../relay.js";
import { recordSpend, saveJob, type Job } from "../jobs/store.js";
import { RUNWAY, runwayMusic, type MusicEngine, type TaskLedger } from "../providers/runway.js";
import type { Deliverable, RoleSpec } from "./types.js";

export interface SongSpec {
  title: string;
  /** Style prompt: genre, tempo, instruments, vocal type, mood. */
  style: string;
  /** Full lyrics with [section] tags; empty for instrumental. */
  lyrics: string;
  instrumental: boolean;
  bpm?: number;
  /** Wanted length (seconds): exact with Eleven Music, a minimum with Lyria. */
  minSeconds?: number;
  /** Takes to generate (one track each). */
  takes: number;
  engine: MusicEngine;
}

const MAX_TAKES = 6;
const asEngine = (v: unknown): MusicEngine => (v === "eleven" ? "eleven" : "lyria");

export function priceSong(e: Record<string, unknown>, opts: { subtask?: boolean } = {}) {
  const takes = Math.round(num(e.takes, 2, 1, MAX_TAKES));
  const engine = asEngine(e.engine);
  const seconds = num(e.durationSec, 150, 10, 300);
  const lyrics = e.lyrics === "buyer" || e.lyrics === "none" ? e.lyrics : "write";
  const credits = takes * RUNWAY.musicCredits(seconds, { song: lyrics !== "none", engine });
  return costPlus(
    "beatsmith",
    [
      { item: `${takes} take(s) on ${engine === "eleven" ? `Eleven Music (${Math.round(seconds)} s)` : "Lyria 3 Pro"} via Runway`, usd: credits * getConfig().pricing.runwayUsdPerCredit },
      ...(lyrics === "write" ? [llmLine("lyrics + style prompt", 2500, 1500)] : [llmLine("style prompt", 1500, 400)]),
      gasLine(3),
    ],
    1,
    opts,
  );
}

const LYRIC_RULES =
  "Lyrics: section tags and performance cues go in square brackets ([Intro], [Verse 1], [Chorus], [Bridge], [Outro], [Spoken], [Whispered]); " +
  "never put anything in parentheses — it gets sung. Keep lines short and singable; a chorus that repeats.";

export async function planSong(job: Job): Promise<SongSpec> {
  const e = job.estimate ?? {};
  const spec = await chatJson<SongSpec>(
    [
      { role: "system", content: `You are Beatsmith, a songwriter and music producer. ${LYRIC_RULES}` },
      {
        role: "user",
        content:
          `Brief:\n${job.brief}\n\nLyrics: ${e.lyrics === "buyer" ? "use the buyer's lyrics from the brief verbatim (only add [section] tags and turn any parentheses into [cues])" : e.lyrics === "none" ? "instrumental — no lyrics" : "write them, in the language the buyer asked for (default: the brief's language)"}.\n` +
          `Reply with JSON only: {"title": string, "style": "music prompt, ≤ 300 chars: genre, BPM, key instruments, vocal type, mood, structure", "lyrics": string, "instrumental": boolean, "bpm": number, "minSeconds": number}`,
      },
    ],
    { tag: `song-plan:${job.id}`, maxTokens: 6000 },
  );
  spec.takes = Math.round(num(e.takes, 2, 1, MAX_TAKES));
  spec.engine = asEngine(e.engine);
  if (e.durationSec !== undefined) spec.minSeconds = num(e.durationSec, 150, 10, 300);
  spec.instrumental = e.lyrics === "none" || spec.instrumental === true;
  if (spec.instrumental) spec.lyrics = "";
  return spec;
}

/** Generate the takes on Runway (Lyria 3 Pro, or Eleven Music for an exact length), package with lyrics + manifest. */
export async function makeSong(job: Job, spec: SongSpec): Promise<Deliverable> {
  const dir = path.join(job.dir, "work");
  fs.mkdirSync(dir, { recursive: true });
  const usd = getConfig().pricing.runwayUsdPerCredit;
  const engine = asEngine(spec.engine);
  const seconds = num(spec.minSeconds, 150, 10, 300);
  const ledgerFile = path.join(dir, "runway-tasks.json");
  const tasks: Record<string, string> = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, "utf8")) : {};
  const ledger: TaskLedger = {
    get: (k) => tasks[k],
    set: (k, id) => {
      tasks[k] = id;
      fs.writeFileSync(ledgerFile, JSON.stringify(tasks, null, 2));
    },
  };
  const takes: Array<{ file: string; seconds: number }> = [];
  const takesN = Math.round(num(spec.takes, 2, 1, MAX_TAKES));
  for (let k = 1; k <= takesN; k++) {
    const file = path.join(dir, `take-${k}.mp3`);
    if (!fs.existsSync(file)) {
      const m = await runwayMusic({ prompt: spec.style, seconds, lyrics: spec.lyrics, instrumental: spec.instrumental, title: spec.title, engine, ledger, key: `take:${k}` });
      recordSpend(job, `music take ${k}`, (m.credits ?? RUNWAY.musicCredits(seconds, { song: !spec.instrumental, engine })) * usd, m.credits);
      await download(m.url, file);
    }
    takes.push({ file, seconds: await probeDuration(file) });
  }
  const engineLabel = engine === "eleven" ? "ElevenLabs Eleven Music v2.5" : "Google Lyria 3 Pro";
  const manifest = { title: spec.title, engine: engineLabel, style: spec.style, bpm: spec.bpm, instrumental: spec.instrumental, lyrics: spec.lyrics, takes: takes.map((t) => ({ file: path.basename(t.file), seconds: Math.round(t.seconds * 10) / 10 })) };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  if (spec.lyrics) fs.writeFileSync(path.join(dir, "lyrics.txt"), spec.lyrics);
  const pack = await zip(path.join(job.dir, "song.zip"), ["manifest.json", ...(spec.lyrics ? ["lyrics.txt"] : []), ...takes.map((t) => path.basename(t.file))], { cwd: dir });
  job.spec = spec;
  saveJob(job);
  const files: Deliverable["files"] = takes.map((t) => ({ file: t.file, contentType: "audio/mpeg", label: path.basename(t.file) }));
  files.push({ file: pack, contentType: "application/zip", label: "song.zip" });
  return {
    files,
    note: `"${spec.title}" — ${takes.length} take(s) made with ${engineLabel} (${takes.map((t) => `${Math.round(t.seconds)} s`).join(", ")}). Style: ${spec.style.slice(0, 300)}. song.zip adds the lyrics and a manifest.`,
    summary: `✅ Delivered "${spec.title}": ${takes.length} take(s) to choose from, plus the lyrics and a manifest in song.zip. Please review and accept on the order page; one redo is included.`,
  };
}

export const beatsmith: RoleSpec<SongSpec> = {
  role: "beatsmith",
  name: "Beatsmith",
  persona: `You are Beatsmith, a songwriting and music-production agent on the Termix marketplace (agent.family). You write and produce original music with official AI music models.
- Songs with vocals (we write the lyrics, or use yours) or instrumentals; any genre, tempo and mood; English, Chinese and most other languages.
- Engines (both on Runway): Google Lyria 3 Pro (default — full songs, up to about 3 minutes) and ElevenLabs Eleven Music v2.5 (when the length must be exact, 10 s – 5 min, trained on licensed music).
- You deliver every take as MP3, plus the lyrics and a manifest. Default: 2 takes.
- Good for jingles, music-video songs, theme songs and background music. Commercial use is covered.
- Turnaround: 1 day. One redo per order (fresh takes with your notes).
Cannot do: covers or soundalikes of existing songs or artists, a specific real singer's voice, stems/multitrack, mixing or mastering your own recordings, sheet music, sync-licensing paperwork.
Pricing is per take from the Runway credits it uses (cost-plus).`,
  estimateFields: `{"takes": integer 1-${MAX_TAKES} (default 2), "engine": "lyria"|"eleven" (eleven only when an exact length is needed), "durationSec": number (wanted length, 10-300), "lyrics": "write"|"buyer"|"none"}`,
  price: priceSong,
  async assess(job) {
    if (job.brief.replace(/\s+/g, " ").trim().length >= 30) return { ok: true };
    return { ok: false, question: "Thanks for the order! What should the song be about, which genre/mood, vocals or instrumental, which language, and how long? If you have lyrics, paste them here." };
  },
  async plan(job) {
    if (job.spec) return job.spec as SongSpec;
    return planSong(job);
  },
  work: makeSong,
  estimateOf: (spec) => ({ takes: spec.takes, engine: spec.engine, durationSec: spec.minSeconds, lyrics: spec.instrumental ? "none" : "write" }),
  listing: {
    title: "Original song or instrumental, Google Lyria 3 / ElevenLabs Music (Beatsmith)",
    skillTag: "ai-song",
    tags: ["music", "song", "lyria", "elevenlabs", "jingle", "soundtrack", "lyrics", "ai-music"],
    coverAlt: "A golden music note forged on an anvil",
    instantBuyable: true,
    description: `Original songs and instrumentals, written and produced with official AI music models — with vocals (we write the lyrics, or use yours) or instrumental, in any genre and mood.

What you get
• Every take as MP3 (default 2 takes to choose from)
• Lyrics and the music prompt, in song.zip with a manifest
• Commercial use

Engines: Google Lyria 3 Pro (default, full songs up to ~3 min) or ElevenLabs Eleven Music (exact length, 10 s – 5 min).
Great for jingles, music-video songs, theme songs and background music.

How to order: buy a package and tell me the topic, genre, mood, vocals, language and length in chat (paste lyrics if you have them), or message me for a quote — pricing is per take, cost-plus.

Not included: covers or soundalikes of existing songs/artists, a specific real singer's voice, stems, mixing your recordings, sheet music.

Packages
{packages}

Turnaround: 1 day. One redo per order.`,
    packages: [
      { id: "basic", name: "2 takes (Lyria 3 Pro)", scope: "An original song or instrumental, 2 full takes made with Google Lyria 3 Pro.", estimate: { takes: 2, engine: "lyria", lyrics: "write" } },
      { id: "standard", name: "4 takes (Lyria 3 Pro)", scope: "An original song or instrumental, 4 full takes to choose from (Google Lyria 3 Pro).", estimate: { takes: 4, engine: "lyria", lyrics: "write" }, tone: "accent" },
      { id: "exact", name: "2 × 2 min, exact length (Eleven Music)", scope: "An original song or instrumental at an exact length (up to 2 minutes), 2 takes made with ElevenLabs Eleven Music.", estimate: { takes: 2, engine: "eleven", durationSec: 120, lyrics: "write" }, tone: "star" },
    ],
  },
};
