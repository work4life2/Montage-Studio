import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { download, zip } from "../media/util.js";
import { probeDuration } from "../media/edit.js";
import { costPlus, gasLine, llmLine, num } from "../pricing.js";
import { chatJson } from "../relay.js";
import { recordSpend, saveJob, type Job } from "../jobs/store.js";
import { SUNO, sunoGenerate } from "../providers/suno.js";
import type { Deliverable, RoleSpec } from "./types.js";

export interface SongSpec {
  title: string;
  /** Suno style prompt: genre, tempo, instruments, vocal type, mood. */
  style: string;
  /** Full lyrics with [section] tags; empty for instrumental. */
  lyrics: string;
  instrumental: boolean;
  bpm?: number;
  /** The shortest take that is useful (seconds). */
  minSeconds?: number;
  /** Suno generations (each one returns two takes). */
  generations: number;
  /** Styles to steer away from. */
  exclude?: string;
}

const MAX_GENERATIONS = 6;

export function priceSong(e: Record<string, unknown>, opts: { subtask?: boolean } = {}) {
  const generations = Math.round(num(e.generations, 2, 1, MAX_GENERATIONS));
  const lyrics = e.lyrics === "buyer" || e.lyrics === "none" ? e.lyrics : "write";
  const usd = getConfig().pricing.sunoUsdPerCredit;
  return costPlus(
    "beatsmith",
    [
      { item: `${generations} Suno generation(s) = ${generations * 2} takes`, usd: generations * SUNO.creditsPerGeneration * usd },
      ...(lyrics === "write" ? [llmLine("lyrics + style prompt", 2500, 1500)] : [llmLine("style prompt", 1500, 400)]),
      gasLine(3),
    ],
    1,
    opts,
  );
}

const LYRIC_RULES =
  "Suno lyrics: section tags and performance cues go in square brackets ([Intro], [Verse 1], [Chorus], [Bridge], [Outro], [Spoken], [Whispered]); " +
  "NEVER put anything in parentheses — Suno sings it. Keep lines short and singable; a chorus that repeats.";

export async function planSong(job: Job): Promise<SongSpec> {
  const e = job.estimate ?? {};
  const generations = Math.round(num(e.generations, 2, 1, MAX_GENERATIONS));
  const spec = await chatJson<SongSpec>(
    [
      { role: "system", content: `You are Beatsmith, a songwriter and producer who makes songs with Suno. ${LYRIC_RULES}` },
      {
        role: "user",
        content:
          `Brief:\n${job.brief}\n\nLyrics: ${e.lyrics === "buyer" ? "use the buyer's lyrics from the brief verbatim (only add [section] tags and turn any parentheses into [cues])" : e.lyrics === "none" ? "instrumental — no lyrics" : "write them, in the language the buyer asked for (default: the brief's language)"}.\n` +
          `Reply with JSON only: {"title": string, "style": "Suno style prompt, ≤ 200 chars: genre, BPM, key instruments, vocal type, mood", "lyrics": string, "instrumental": boolean, "bpm": number, "minSeconds": number, "exclude": "styles to avoid, comma-separated"}`,
      },
    ],
    { tag: `song-plan:${job.id}`, maxTokens: 6000 },
  );
  spec.generations = generations;
  spec.instrumental = e.lyrics === "none" || spec.instrumental === true;
  if (spec.instrumental) spec.lyrics = "";
  return spec;
}

/** Generate the song (N generations × 2 takes), download every take, package with a manifest. */
export async function makeSong(job: Job, spec: SongSpec): Promise<Deliverable> {
  const dir = path.join(job.dir, "work");
  fs.mkdirSync(dir, { recursive: true });
  const usd = getConfig().pricing.sunoUsdPerCredit;
  const takesFile = path.join(dir, "takes.json");
  const takes: Array<{ file: string; id: string; title: string; seconds: number; url: string; generation: number }> = fs.existsSync(takesFile) ? JSON.parse(fs.readFileSync(takesFile, "utf8")) : [];
  for (let g = takes.length ? Math.max(...takes.map((t) => t.generation)) + 1 : 1; g <= spec.generations; g++) {
    const res = await sunoGenerate({ title: spec.title, style: spec.style, lyrics: spec.lyrics, instrumental: spec.instrumental, exclude: spec.exclude });
    recordSpend(job, `suno generation ${g}`, (res.credits ?? SUNO.creditsPerGeneration) * usd, res.credits);
    for (const [i, clip] of res.clips.entries()) {
      const ext = path.extname(new URL(clip.audioUrl).pathname) || ".mp3";
      const file = path.join(dir, `take-${g}${String.fromCharCode(97 + i)}${ext}`);
      await download(clip.audioUrl, file);
      const seconds = clip.duration ?? (await probeDuration(file));
      takes.push({ file, id: clip.id, title: clip.title ?? spec.title, seconds, url: clip.audioUrl, generation: g });
      fs.writeFileSync(takesFile, JSON.stringify(takes, null, 2));
    }
  }
  const manifest = { title: spec.title, style: spec.style, bpm: spec.bpm, instrumental: spec.instrumental, lyrics: spec.lyrics, takes: takes.map((t) => ({ file: path.basename(t.file), sunoId: t.id, seconds: Math.round(t.seconds * 10) / 10 })) };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  if (spec.lyrics) fs.writeFileSync(path.join(dir, "lyrics.txt"), spec.lyrics);
  const pack = await zip(path.join(job.dir, "song.zip"), ["manifest.json", ...(spec.lyrics ? ["lyrics.txt"] : []), ...takes.map((t) => path.basename(t.file))], { cwd: dir });
  job.spec = spec;
  saveJob(job);
  const files: Deliverable["files"] = takes.map((t) => ({ file: t.file, contentType: t.file.endsWith(".wav") ? "audio/wav" : "audio/mpeg", label: path.basename(t.file) }));
  files.push({ file: pack, contentType: "application/zip", label: "song.zip" });
  return {
    files,
    note: `"${spec.title}" — ${takes.length} take(s) from ${spec.generations} Suno generation(s) (${takes.map((t) => `${Math.round(t.seconds)} s`).join(", ")}). Style: ${spec.style.slice(0, 300)}. song.zip adds the lyrics and a manifest.`,
    summary: `✅ Delivered "${spec.title}": ${takes.length} take(s) to choose from, plus the lyrics and a manifest in song.zip. Please review and accept on the order page; one redo is included.`,
  };
}

export const beatsmith: RoleSpec<SongSpec> = {
  role: "beatsmith",
  name: "Beatsmith",
  persona: `You are Beatsmith, a songwriting and music-production agent on the Termix marketplace (agent.family). You make original songs with Suno.
- Songs with vocals (we write the lyrics, or use yours) or instrumentals; any genre, tempo and mood; English, Chinese and most other languages.
- Every Suno generation gives two full takes (typically 2–4 minutes); you receive every take as audio, plus lyrics and a manifest.
- Good for jingles, music-video songs, background music, theme songs.
- Engine: Suno (${SUNO.label}). Commercial use is covered by our paid Suno plan.
- Turnaround: 1 day. One redo per order (a fresh generation with your notes).
Cannot do: covers or soundalikes of existing songs or artists, a specific real singer's voice, stems/multitrack mixing, mastering of your own recordings, sheet music, sync licensing paperwork.
Pricing is per generation from the Suno credits it uses (cost-plus); the default is 2 generations = 4 takes.`,
  estimateFields: `{"generations": integer 1-${MAX_GENERATIONS} (each = 2 takes, default 2), "lyrics": "write"|"buyer"|"none"}`,
  price: priceSong,
  async assess(job) {
    if (job.brief.replace(/\s+/g, " ").trim().length >= 30) return { ok: true };
    return { ok: false, question: "Thanks for the order! What should the song be about, which genre/mood, vocals or instrumental, and which language? If you have lyrics, paste them here." };
  },
  async plan(job) {
    if (job.spec) return job.spec as SongSpec;
    return planSong(job);
  },
  work: makeSong,
  estimateOf: (spec) => ({ generations: spec.generations, lyrics: spec.instrumental ? "none" : "write" }),
  listing: {
    title: "Original song or instrumental made with Suno (Beatsmith)",
    skillTag: "suno-song",
    tags: ["music", "song", "suno", "jingle", "soundtrack", "lyrics", "ai-music"],
    coverAlt: "A golden music note forged on an anvil",
    instantBuyable: true,
    description: `Original songs made with Suno — with vocals (we write the lyrics, or use yours) or instrumental, in any genre and mood.

What you get
• Every take of every generation (a Suno generation = 2 full takes, usually 2–4 min)
• Lyrics and the style prompt, in song.zip with a manifest
• Commercial use (paid Suno plan)

Great for jingles, music-video songs, theme songs and background music.

How to order: buy a package and tell me the topic, genre, mood, vocals and language in chat (paste lyrics if you have them), or message me for a quote — pricing is per generation from the Suno credits used, cost-plus.

Not included: covers or soundalikes of existing songs/artists, a specific real singer's voice, stems or mixing your recordings, sheet music.

Packages
{packages}

Turnaround: 1 day. One redo per order.`,
    packages: [
      { id: "basic", name: "1 generation (2 takes)", scope: "One Suno generation: 2 full takes of an original song or instrumental.", estimate: { generations: 1, lyrics: "write" } },
      { id: "standard", name: "2 generations (4 takes)", scope: "Two Suno generations: 4 full takes to choose from.", estimate: { generations: 2, lyrics: "write" }, tone: "accent" },
      { id: "pro", name: "5 generations (10 takes)", scope: "Five Suno generations with style variations: 10 full takes.", estimate: { generations: 5, lyrics: "write" }, tone: "star" },
    ],
  },
};
