import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { logger } from "../log.js";
import { ASPECTS, asAspect, download, img, pool, zip, type Aspect } from "../media/util.js";
import { costPlus, gasLine, llmLine, num } from "../pricing.js";
import { chatJson, generateImage } from "../relay.js";
import { recordSpend, saveJob, type Job } from "../jobs/store.js";
import type { Deliverable, RoleSpec } from "./types.js";

const log = logger("sketchboard");

export interface Character {
  id: string;
  name: string;
  description: string;
}
export interface SketchShot {
  id: string;
  description: string;
  characters?: string[];
}
export interface SketchSpec {
  title?: string;
  aspect: Aspect;
  style: string;
  characters: Character[];
  shots: SketchShot[];
}

/** Images we pay for per delivered image: one retake in four on average. */
const RETAKE = 1.25;
export const MAX_FRAMES = 80;

function priceSketch(e: Record<string, unknown>, opts: { subtask?: boolean } = {}) {
  const frames = Math.round(num(e.keyframes, 8, 1, MAX_FRAMES));
  const sheets = Math.round(num(e.characterSheets, 0, 0, 12));
  const { imageUsd } = getConfig().pricing;
  const images = frames + sheets;
  return costPlus(
    "sketchboard",
    [
      { item: `${frames} keyframe(s) + ${sheets} character sheet(s), gpt-image-2 high (incl. retakes)`, usd: images * imageUsd * RETAKE },
      llmLine("shot planning", 4000 + 300 * frames, 1500 + 250 * frames),
      gasLine(3),
    ],
    images > 40 ? 2 : 1,
    opts,
  );
}

const STYLE_DEFAULT =
  "High-budget 3D animated film look (Pixar / Illumination polish): glossy stylized characters with expressive faces, saturated palette, cinematic lighting with rim light and haze, dynamic camera angles, crisp detail";

const NO_TEXT = "No captions, no subtitles, no watermark, no logos, no readable text, letters or numbers anywhere.";

function framing(aspect: Aspect): string {
  if (aspect === "9:16") return "Tall 9:16 vertical framing: keep characters and key action inside the central vertical band, the left and right 8% will be cropped.";
  if (aspect === "1:1") return "Square framing, subject centered.";
  return "Wide 16:9 framing: keep characters and key action inside the central horizontal band, the top and bottom 8% will be cropped.";
}

const sheetPrompt = (spec: SketchSpec, c: Character) =>
  `${spec.style}.\n\nCharacter model sheet on a plain light-gray studio background: the same character shown three times side by side — front view full body, ` +
  `three-quarter view, and a close-up of the face. ${c.name}: ${c.description}. Soft even studio light, perfectly consistent design across all views. ${NO_TEXT}`;

function framePrompt(spec: SketchSpec, shot: SketchShot, withSheets: Character[], withRefs: boolean): string {
  const ref = withSheets.length
    ? `The attached image(s) are model sheets. Use them only for character identity (${withSheets.map((c) => c.name).join(", ")}): keep shapes, colors, faces and outfits identical. Do not copy the sheet layout or the gray background.\n\n`
    : withRefs
      ? "The attached image(s) are the client's references: follow their look and identity, not their layout.\n\n"
      : "";
  return `Frame from ${spec.style}. ${framing(spec.aspect)} ${NO_TEXT}\n\n${ref}${shot.description}`;
}

export async function planSketch(brief: string, e: Record<string, unknown>, refsCount: number): Promise<SketchSpec> {
  const frames = Math.round(num(e.keyframes, 8, 1, MAX_FRAMES));
  const sheets = Math.round(num(e.characterSheets, 0, 0, 12));
  const spec = await chatJson<SketchSpec>(
    [
      {
        role: "system",
        content:
          "You are Sketchboard, a storyboard artist. Turn the client's brief into a keyframe plan for an image model. " +
          "Every shot description is a self-contained image prompt in English: who is in frame (named characters exactly as defined), action frozen at its most telling instant, setting, camera angle and lens, lighting, mood. " +
          "Never ask for text, captions, logos or signage in the image. Characters that recur get a model sheet so they stay consistent.",
      },
      {
        role: "user",
        content:
          `Brief (may include a conversation; follow what was agreed):\n${brief}\n\n` +
          `The client sent ${refsCount} reference image(s).\n` +
          `Deliver exactly ${frames} keyframe(s)${sheets ? ` and ${sheets} character model sheet(s) (the ${sheets} most important recurring characters)` : " and no model sheets unless a character recurs"}. Aspect ratio: ${asAspect(e.aspect)}.\n\n` +
          `Reply with JSON only:\n{"title": string, "aspect": "16:9"|"9:16"|"1:1", "style": "one sentence art direction (default: ${STYLE_DEFAULT})", ` +
          `"characters": [{"id": "kebab-id", "name": "DISPLAY NAME", "description": "full visual description: species/age, build, colors, outfit, signature props"}], ` +
          `"shots": [{"id": "s01", "description": "image prompt", "characters": ["kebab-id"]}]}`,
      },
    ],
    { tag: "sketch-plan", maxTokens: 12000 },
  );
  spec.aspect = asAspect(spec.aspect ?? e.aspect);
  spec.characters ??= [];
  spec.shots = (spec.shots ?? []).slice(0, frames);
  if (!spec.style) spec.style = STYLE_DEFAULT;
  return spec;
}

/** Draw a spec: model sheets first (references for the frames), then the keyframes, then the package. */
export async function drawSketch(job: Job, spec: SketchSpec): Promise<Deliverable> {
  const dir = path.join(job.dir, "work");
  const sheetsDir = path.join(dir, "sheets");
  const framesDir = path.join(dir, "keyframes");
  const rawDir = path.join(dir, "raw");
  for (const d of [sheetsDir, framesDir, rawDir]) fs.mkdirSync(d, { recursive: true });
  const { imageUsd } = getConfig().pricing;

  const refs: string[] = [];
  for (const [i, url] of job.refs.slice(0, 4).entries()) {
    try {
      refs.push(await download(url, path.join(dir, "refs", `ref-${i + 1}${path.extname(new URL(url).pathname) || ".png"}`)));
    } catch (err) {
      log.warn(`${job.id}: reference ${url} not downloaded: ${String(err)}`);
    }
  }

  const sheetFile = (c: Character) => path.join(sheetsDir, `${c.id}.png`);
  await pool(spec.characters, 4, async (c) => {
    if (fs.existsSync(sheetFile(c))) return;
    await generateImage({ prompt: sheetPrompt(spec, c), outPath: sheetFile(c), size: "1536x1024", refs: refs.length ? refs : undefined, tag: `${job.id}:sheet-${c.id}` });
    recordSpend(job, `sheet ${c.id}`, imageUsd);
  });

  const a = ASPECTS[spec.aspect];
  const byId = new Map(spec.characters.map((c) => [c.id, c]));
  await pool(spec.shots, 4, async (shot) => {
    const out = path.join(framesDir, `${shot.id}.png`);
    if (fs.existsSync(out)) return;
    const cast = (shot.characters ?? []).map((id) => byId.get(id)).filter((c): c is Character => Boolean(c)).slice(0, 4);
    const shotRefs = cast.length ? cast.map(sheetFile) : refs;
    const raw = path.join(rawDir, `${shot.id}.png`);
    await generateImage({ prompt: framePrompt(spec, shot, cast, !cast.length && refs.length > 0), outPath: raw, size: a.gen, refs: shotRefs.length ? shotRefs : undefined, tag: `${job.id}:${shot.id}` });
    recordSpend(job, `keyframe ${shot.id}`, imageUsd);
    await img(["fit", raw, out, String(a.w), String(a.h)]);
  });

  const manifest = {
    title: spec.title ?? "",
    aspect: spec.aspect,
    size: `${a.w}x${a.h}`,
    style: spec.style,
    characters: spec.characters.map((c) => ({ ...c, sheet: `sheets/${c.id}.png` })),
    shots: spec.shots.map((s) => ({ ...s, keyframe: `keyframes/${s.id}.png` })),
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  const contact = path.join(job.dir, "contact-sheet.jpg");
  await img(["sheet", contact, String(Math.min(spec.shots.length, spec.aspect === "9:16" ? 6 : 4)), spec.aspect === "9:16" ? "240" : "420", ...spec.shots.map((s) => `${s.id}=${path.join(framesDir, `${s.id}.png`)}`)]);
  const pack = await zip(path.join(job.dir, "storyboard.zip"), ["manifest.json", "keyframes", ...(spec.characters.length ? ["sheets"] : [])], { cwd: dir });
  job.spec = spec;
  saveJob(job);

  const n = spec.shots.length;
  const note =
    `Storyboard: ${n} keyframe(s) at ${a.w}x${a.h} (${spec.aspect})` +
    (spec.characters.length ? ` and ${spec.characters.length} character model sheet(s)` : "") +
    `. storyboard.zip = keyframes/<shot>.png + sheets/ + manifest.json (shot ids, prompts, characters); contact-sheet.jpg = overview.`;
  return {
    files: [
      { file: pack, contentType: "application/zip", label: "storyboard.zip" },
      { file: contact, contentType: "image/jpeg", label: "contact-sheet.jpg" },
      { file: path.join(dir, "manifest.json"), contentType: "application/json", label: "manifest.json" },
    ],
    note,
    summary: `✅ Delivered: ${n} keyframe(s)${spec.characters.length ? ` + ${spec.characters.length} character sheet(s)` : ""} (${spec.aspect}, ${a.w}x${a.h}) — storyboard.zip, a contact sheet and the manifest. Please review and accept on the order page; one redo is included if something needs changing.`,
  };
}

export const sketchboard: RoleSpec<SketchSpec> = {
  role: "sketchboard",
  name: "Sketchboard",
  persona: `You are Sketchboard, a storyboard and keyframe artist agent on the Termix marketplace (agent.family).
What you deliver: character model sheets and one keyframe still per shot, with consistent recurring characters, ready for image-to-video (e.g. by RenderFarm) or for pitching.
- Output: PNG keyframes at 1920x1080 (16:9), 1080x1920 (9:16) or 1080x1080 (1:1); character sheets (front / three-quarter / face); a contact sheet; manifest.json with every shot's prompt.
- Styles: 3D animation, anime, comic, watercolor, painterly, photoreal cinematic — or matched to the buyer's reference images.
- Engine: gpt-image-2 (OpenAI image model) through our relay.
- Turnaround: 1 day up to 40 images, 2 days above. One redo per order.
Cannot do: animation or video (refer them to RenderFarm), music, readable text / logos / typography inside images (add those in post), exact likenesses of real people or copyrighted characters, vector or print-ready files, more than ${MAX_FRAMES} keyframes per order.`,
  estimateFields: `{"keyframes": integer 1-${MAX_FRAMES}, "characterSheets": integer 0-12 (recurring characters that need a model sheet), "aspect": "16:9"|"9:16"|"1:1"}`,
  price: priceSketch,
  async assess(job) {
    const text = job.brief.replace(/\s+/g, " ").trim();
    if (text.length >= 40 || job.refs.length) return { ok: true };
    return { ok: false, question: "Thanks for the order! What should the storyboard show? A few lines are enough: the story or the scenes, the characters, the style you like (reference images welcome) and the aspect ratio (16:9, 9:16 or 1:1)." };
  },
  async plan(job) {
    if (job.spec) return job.spec as SketchSpec;
    return planSketch(job.brief, job.estimate ?? {}, job.refs.length);
  },
  work: drawSketch,
  estimateOf: (spec) => ({ keyframes: spec.shots.length, characterSheets: spec.characters.length, aspect: spec.aspect }),
  listing: {
    title: "Storyboard keyframes & character sheets for video (Sketchboard)",
    skillTag: "storyboard-keyframes",
    tags: ["storyboard", "keyframes", "character-design", "concept-art", "illustration", "music-video", "image-to-video"],
    coverAlt: "A storyboard wall of colourful keyframe panels and a character model sheet",
    instantBuyable: true,
    description: `Storyboards for videos, ads and music videos: one keyframe still per shot, with recurring characters kept consistent through model sheets.

What you get
• PNG keyframes at 1920×1080 (16:9), 1080×1920 (9:16) or 1080×1080 (1:1) — ready for image-to-video
• Character model sheets (front / three-quarter / face) for recurring characters
• A contact sheet and manifest.json with every shot's prompt

Styles: 3D animation, anime, comic, watercolor, painterly or photoreal cinematic — or matched to your reference images. Engine: gpt-image-2.

How to order: buy a package and describe the story or scenes in chat (or send a shot list). For other quantities, message me for a quote — pricing is per image, cost-plus.

Not included: animation/video (see RenderFarm), music, readable text or logos inside images, likenesses of real people or copyrighted characters, vector/print files.

Packages
{packages}

Turnaround: 1 day up to 40 images, 2 days above. One redo per order.`,
    packages: [
      { id: "basic", name: "6 keyframes", scope: "6 keyframes in one style, any aspect ratio, no character sheets.", estimate: { keyframes: 6, characterSheets: 0, aspect: "16:9" } },
      { id: "standard", name: "12 keyframes + 2 sheets", scope: "12 keyframes and model sheets for 2 recurring characters.", estimate: { keyframes: 12, characterSheets: 2, aspect: "16:9" }, tone: "accent" },
      { id: "pro", name: "30 keyframes + 6 sheets", scope: "A full music-video storyboard: 30 keyframes and 6 character model sheets.", estimate: { keyframes: 30, characterSheets: 6, aspect: "16:9" }, tone: "star" },
    ],
  },
};
