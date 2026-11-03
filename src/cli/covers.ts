import fs from "node:fs";
import path from "node:path";
import { getConfig, ROLES, type Role } from "../config.js";
import { generateImage } from "../relay.js";

const STYLE =
  "Premium 3D product illustration, glossy stylized materials, soft volumetric studio light, subtle depth of field, " +
  "clean modern app-store hero look. Keep the subject centered with generous margins on every side (the image is cropped to 16:10 and to 5:4). " +
  "No text, no letters, no numbers, no logos, no watermark.";

/** Listing covers in the cast colours of the subcontracting promo (promo-v6-tiny-arms/src/cast.json). */
export const COVER_PROMPTS: Record<Role, string> = {
  montage:
    "A music-video editing suite: a sleek curved monitor shows a vivid 3D-animated party scene (a cartoon T-Rex in a purple tuxedo dancing under neon lights), " +
    "below it a glowing video timeline whose clip thumbnails snap onto the beat markers of a bright audio waveform; a clapperboard and studio headphones on the desk. " +
    "Background: smooth gradient from indigo #5856d6 to purple #af52de.",
  renderfarm:
    "A futuristic render farm: a row of glowing server racks with mint and teal light strips; from the front rack a still storyboard frame unfolds into a moving film strip " +
    "with motion trails, frames turning from sketch to fully rendered cinematic shots. Background: smooth gradient from green #30d158 to teal #30b0c7.",
  beatsmith:
    "A glossy blacksmith anvil on which a golden music note is being forged with a small hammer; the sparks fly off as glowing sound-wave ribbons, " +
    "a vintage studio microphone and a pair of headphones beside the anvil. Background: smooth gradient from hot pink #ff2d55 to soft pink #ff6fa0.",
  sketchboard:
    "A storyboard wall: a neat grid of colourful hand-drawn keyframe panels (cinematic shots of a cartoon dinosaur, a vending-machine robot and a city at night) pinned to a board, " +
    "a character model sheet in front, coloured pencils and markers in a cup. Background: smooth gradient from sunny yellow #ffcc00 to orange #ff9500.",
};

export function coverPath(role: Role): string {
  return path.join(getConfig().dataDir, "covers", `${role}.png`);
}

export async function generateCovers(roles: Role[] = [...ROLES], force = false): Promise<string[]> {
  const out: string[] = [];
  await Promise.all(
    roles.map(async (role) => {
      const file = coverPath(role);
      if (!force && fs.existsSync(file)) return out.push(file);
      await generateImage({ prompt: `${STYLE}\n\n${COVER_PROMPTS[role]}`, outPath: file, size: "1536x1024", tag: `cover-${role}` });
      out.push(file);
    }),
  );
  return out;
}
