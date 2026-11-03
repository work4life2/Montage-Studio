import { asAspect, type Aspect } from "../media/util.js";
import { costPlus, gasLine, llmLine, num } from "../pricing.js";
import { chatJson } from "../relay.js";
import { runProduction } from "../jobs/production.js";
import type { Job } from "../jobs/store.js";
import { priceSong } from "./beatsmith.js";
import { loadGrant } from "../mcp/oauth.js";
import { priceRender } from "./renderfarm.js";
import { MAX_FRAMES, sketchboard, type Character } from "./sketchboard.js";
import type { PriceLine, RoleSpec } from "./types.js";

export interface PlanShot {
  id: string;
  /** Planned on-screen length (seconds). */
  seconds: number;
  /** Keyframe prompt (a still image). */
  description: string;
  /** Image-to-video prompt: the action, first thing first, plus the camera move. */
  motion: string;
  characters?: string[];
  /** Optional on-screen text burnt in during the edit. */
  caption?: string;
}

export interface ProductionPlan {
  title: string;
  logline: string;
  aspect: Aspect;
  durationSec: number;
  resolution: "720p" | "1080p";
  fps: 24 | 30 | 60;
  style: string;
  characters: Character[];
  shots: PlanShot[];
  music: {
    /** beatsmith = original song (Suno); renderfarm = instrumental bed from Runway; buyer = they send a track; none = silent. */
    source: "beatsmith" | "renderfarm" | "buyer" | "none";
    title?: string;
    style?: string;
    lyrics?: string;
    instrumental?: boolean;
    bpm?: number;
    /** buyer track URL when source = buyer */
    url?: string;
  };
  titleText?: string;
  endText?: string;
}

/**
 * Who makes the music. A song with vocals goes to Beatsmith (Suno) when the Suno account is connected;
 * everything else — and songs while Suno is not connected — goes to RenderFarm (Runway music), which
 * saves a crew member and a sub-task.
 */
export function musicBy(music: string): "beatsmith" | "renderfarm" | "none" {
  if (music === "song" && loadGrant("suno")?.refreshToken) return "beatsmith";
  if (music === "song" || music === "instrumental") return "renderfarm";
  return "none";
}

/** Quote parameters → crew line items. Sub-task prices are the crew's own cost-plus prices (no fee on sub-tasks). */
export function crewFor(e: Record<string, unknown>) {
  const durationSec = num(e.durationSec, 30, 5, 240);
  const shots = Math.round(num(e.shots, Math.max(3, Math.round(durationSec / 3)), 1, MAX_FRAMES));
  const sheets = Math.round(num(e.characterSheets, 2, 0, 12));
  const aspect = asAspect(e.aspect);
  const music = ["song", "instrumental", "buyer", "none"].includes(String(e.music)) ? String(e.music) : "song";
  const fps60 = e.fps60 !== false;
  const resolution: "720p" | "1080p" = e.resolution === "720p" ? "720p" : "1080p";
  const by = music === "buyer" || music === "none" ? "none" : musicBy(music);
  const sketch = sketchboard.price({ keyframes: shots, characterSheets: sheets, aspect }, { subtask: true });
  const render = priceRender(
    { shots, secondsPerShot: durationSec / shots, resolution, fps60, ...(by === "renderfarm" ? { music, musicSeconds: durationSec + 30, musicTakes: 2 } : {}) },
    { subtask: true },
  );
  const song = by === "beatsmith" ? priceSong({ generations: 2, lyrics: "write" }, { subtask: true }) : undefined;
  return { durationSec, shots, sheets, aspect, music, musicBy: by, fps60, resolution, sketch, render, song };
}

function priceMontage(e: Record<string, unknown>, opts: { subtask?: boolean } = {}) {
  const c = crewFor(e);
  const crewCount = 2 + (c.song ? 1 : 0);
  const lines: PriceLine[] = [
    { item: `Sketchboard: ${c.shots} keyframes + ${c.sheets} sheets`, usd: c.sketch.price },
    { item: `RenderFarm: ${c.shots} shots${c.fps60 ? " @60fps" : ""}${c.musicBy === "renderfarm" ? ` + ${c.music}` : ""}`, usd: c.render.price },
    ...(c.song ? [{ item: "Beatsmith: original song (2 Suno generations)", usd: c.song.price }] : []),
    llmLine("direction: treatment, lyrics, shot list", 20_000, 12_000),
    llmLine("buyer chat + reviews", 30_000 + 1500 * c.shots, 6000),
    { item: "edit + encode (server time)", usd: 0.1 + 0.005 * c.durationSec },
    gasLine(4 + 2 * crewCount),
  ];
  const days = c.durationSec > 90 || c.shots > 30 ? 5 : c.durationSec > 45 ? 4 : 3;
  return costPlus("montage", lines, days, opts);
}

const RUNWAY_TIPS = `Image-to-video prompts (motion): describe only the action and the camera, never the look (the keyframe already fixes it). Put the key action first ("Immediately: …") — it must happen in the first 2 seconds, because only 1–4 s of each clip are used. Small, clear actions survive; crowds of simultaneous actions collapse. No on-screen text.`;
const SUNO_TIPS = `Suno lyrics: use section tags in square brackets ([Intro], [Verse 1], [Chorus], [Bridge], [Outro]); performance cues also go in square brackets ([Spoken], [Whispered]); NEVER put anything in parentheses — Suno sings it. Keep the song roughly 30–60 s longer than the video so the edit can pick the best part.`;

export async function direct(job: Job): Promise<ProductionPlan> {
  const e = job.estimate ?? {};
  const c = crewFor(e);
  const plan = await chatJson<ProductionPlan>(
    [
      {
        role: "system",
        content:
          "You are the director at Montage Studio, a music-video and ad studio run by AI agents. You write the treatment, the lyrics and a shot list timed to the music, " +
          "then your crew draws the keyframes (Sketchboard, gpt-image-2), renders each shot image-to-video (RenderFarm, Runway) and writes the song (Beatsmith, Suno). " +
          "Everything that appears on screen (titles, captions, lyrics, names) is in the language of the buyer's brief unless they asked otherwise; prompts for the crew are in English.\n\n" +
          `${RUNWAY_TIPS}\n${SUNO_TIPS}\nKeyframe prompts (description): a complete still-image prompt — characters by their defined names, setting, action frozen at its most telling instant, camera angle, lighting. Never ask for text in the image.`,
      },
      {
        role: "user",
        content:
          `Brief (with the conversation that led to the order; the agreed scope is binding):\n${job.brief}\n\n` +
          `Agreed production size (do not exceed): ${c.durationSec} s, exactly ${c.shots} shots, up to ${c.sheets} recurring characters with model sheets, aspect ${c.aspect}, ${c.resolution}, ${c.fps60 ? 60 : 24} fps. ` +
          `Music: ${c.music === "song" ? `an original song with vocals (${c.musicBy === "beatsmith" ? "Beatsmith, Suno" : "RenderFarm, Runway music"})` : c.music === "instrumental" ? "an instrumental track (RenderFarm, Runway music)" : c.music === "buyer" ? "the buyer's own track (look for its URL in the brief)" : "none"}.\n\n` +
          `Reply with JSON only:\n{"title": string, "logline": string, "aspect": "${c.aspect}", "durationSec": ${c.durationSec}, "resolution": "${c.resolution}", "fps": ${c.fps60 ? 60 : 24}, ` +
          `"style": "one-sentence art direction shared by every keyframe", ` +
          `"characters": [{"id": "kebab-id", "name": "DISPLAY NAME", "description": "full visual description"}], ` +
          `"shots": [{"id": "s01", "seconds": number (1.5-6, all shots sum to durationSec), "description": "keyframe prompt", "motion": "image-to-video prompt", "characters": ["kebab-id"], "caption": "optional on-screen text, short"}], ` +
          `"music": {"source": "beatsmith"|"renderfarm"|"buyer"|"none", "title": string, "style": "genre, tempo in BPM, instruments, vocal type, mood — Suno style prompt", "lyrics": "full lyrics with [section] tags, or empty for instrumental", "instrumental": boolean, "bpm": number, "url": "buyer track URL if any"}, ` +
          `"titleText": "optional title shown over the first shot", "endText": "optional end text (brand, CTA, URL)"}`,
      },
    ],
    { tag: `direct:${job.id}`, maxTokens: 16000 },
  );
  plan.aspect = asAspect(plan.aspect ?? c.aspect);
  plan.shots = (plan.shots ?? []).slice(0, c.shots).map((s, i) => ({ ...s, id: s.id || `s${String(i + 1).padStart(2, "0")}`, seconds: num(s.seconds, c.durationSec / c.shots, 1, 10) }));
  plan.characters = (plan.characters ?? []).slice(0, Math.max(c.sheets, 0));
  plan.durationSec = c.durationSec;
  plan.resolution = c.resolution;
  plan.fps = c.fps60 ? 60 : 24;
  if (c.music === "none") plan.music = { source: "none" };
  else if (c.music === "buyer") plan.music = { ...plan.music, source: "buyer" };
  else plan.music = { ...plan.music, source: c.musicBy === "beatsmith" ? "beatsmith" : "renderfarm", instrumental: c.music === "instrumental" };
  if (plan.music.instrumental) plan.music.lyrics = "";
  return plan;
}

export const montage: RoleSpec<ProductionPlan> = {
  role: "montage",
  name: "Montage Studio",
  persona: `You are Montage Studio, a music-video and ad production studio on the Termix marketplace (agent.family), run by AI agents.
One order gets the buyer a finished video: you write the treatment, the lyrics and a shot list timed to the beat (you are the director), then hire your crew through Termix sub-tasks — Sketchboard draws the storyboard keyframes and character sheets (gpt-image-2), RenderFarm renders every shot image-to-video and makes the music (Runway), Beatsmith writes and produces songs with Suno when the project calls for it — and you cut it to the beat, add titles and deliver the master.
- Deliverables: H.264 master (1080p or 720p; 16:9, 9:16 or 1:1; 24 or 60 fps) with the song mixed at streaming loudness, a 720p preview, the song file, the storyboard contact sheet and the production notes (shot list, lyrics).
- Length: 10 s to 3 min. Typical: a 30–60 s ad or a 60–120 s music video. 2–5 s per shot.
- Styles: 3D animation, anime, comic, painterly, photoreal cinematic. Music: any genre; original song with vocals, instrumental, or the buyer's own track.
- Turnaround: 3 days (≤45 s), 4 days (≤90 s), 5 days (longer or >30 shots). The edit can be revised once (redo); re-shoots are a new order.
Cannot do: live-action filming, real people's likenesses or voices, copyrighted characters or songs, lip-sync to a specific singer, 4K, broadcast-legal deliverables, more than ${MAX_FRAMES} shots.
Every project is quoted from its parameters (length, number of shots, characters, music, format) — there is no fixed price. Ask about length, format, style and music if unclear, then quote.`,
  estimateFields: `{"durationSec": number 10-180, "shots": integer (≈ durationSec/2.5), "characterSheets": integer 0-12, "music": "song"|"instrumental"|"buyer"|"none", "aspect": "16:9"|"9:16"|"1:1", "fps60": boolean, "resolution": "1080p"|"720p"}`,
  price: priceMontage,
  async assess(job) {
    if (job.estimate || job.brief.replace(/\s+/g, " ").trim().length >= 60) return { ok: true };
    return { ok: false, question: "Thanks for the order! Before we start: what is the video about, how long should it be, which format (16:9, 9:16 or 1:1), and do you want an original song, an instrumental, or your own track?" };
  },
  async plan(job) {
    const p = job.production as { plan?: ProductionPlan } | undefined;
    if (p?.plan) return p.plan;
    return direct(job);
  },
  work: runProduction,
  listing: {
    title: "Custom AI music video or ad, start to finish (Montage Studio)",
    skillTag: "music-video-production",
    tags: ["music-video", "video-ad", "animation", "video-editing", "suno", "runway", "storyboard", "ai-video"],
    coverAlt: "A music-video editing suite with a beat-synced timeline",
    instantBuyable: false,
    publishPackages: false,
    description: `A finished AI music video or ad from one brief. Montage Studio directs, and hires its crew on Termix for each part:
• Direction (us): treatment, lyrics and a shot list timed to the beat
• Storyboard: Sketchboard draws character sheets + one keyframe per shot (gpt-image-2)
• Shots: RenderFarm renders every keyframe image-to-video on Runway (Kling 4), enhanced to 60 fps
• Music: an original song with vocals or an instrumental (RenderFarm on Runway, or Beatsmith with Suno) — or your own track
• Edit (us): cut to the beat, titles, loudness-mastered mix

You receive: the H.264 master (1080p, 16:9 / 9:16 / 1:1), a 720p preview, the song, the storyboard contact sheet and the production notes.

No fixed price — every project is quoted in chat from its length, number of shots and characters, music and format. Tell us the idea, the length and the format and you get a quote right away. Rough guide: {packages}

Turnaround: 3–5 days. One revision of the edit is included.
Not included: live-action filming, real people's likenesses or voices, copyrighted characters or songs, 4K.`,
    packages: [
      { id: "spot15", name: "15 s spot", scope: "15-second vertical or horizontal spot, 6 shots, instrumental, 1 character.", estimate: { durationSec: 15, shots: 6, characterSheets: 1, music: "instrumental", aspect: "9:16", fps60: true, resolution: "1080p" } },
      { id: "ad30", name: "30 s ad with a song", scope: "30-second ad, 12 shots, original song, 2 characters, 1080p60.", estimate: { durationSec: 30, shots: 12, characterSheets: 2, music: "song", aspect: "16:9", fps60: true, resolution: "1080p" }, tone: "accent" },
      { id: "mv90", name: "90 s music video", scope: "90-second music video, 30 shots, original song, 6 characters, 1080p60.", estimate: { durationSec: 90, shots: 30, characterSheets: 6, music: "song", aspect: "16:9", fps60: true, resolution: "1080p" }, tone: "star" },
    ],
  },
};
