import type { Aspect } from "../media/util.js";

/** Runway pricing assumptions (credits); confirmed against the MCP's own tool descriptions. */
export const RUNWAY = {
  label: "Runway MCP",
  videoCreditsPerSecond: (_res: "720p" | "1080p") => 15,
  enhanceCreditsPerSecond: 0.5,
  musicCredits: (_seconds: number) => 20,
};

export interface RunwayResult {
  url: string;
  credits?: number;
  taskId?: string;
}

export async function runwayImageToVideo(_i: { image: string; prompt: string; seconds: number; aspect: Aspect; resolution: "720p" | "1080p" }): Promise<RunwayResult> {
  throw new Error("runway: not implemented yet");
}
export async function runwayTextToVideo(_i: { prompt: string; seconds: number; aspect: Aspect; resolution: "720p" | "1080p" }): Promise<RunwayResult> {
  throw new Error("runway: not implemented yet");
}
export async function runwayEnhanceFps(_i: { videoUrl: string; taskId?: string; fps: number }): Promise<RunwayResult> {
  throw new Error("runway: not implemented yet");
}
export async function runwayMusic(_i: { prompt: string; seconds: number }): Promise<RunwayResult> {
  throw new Error("runway: not implemented yet");
}
