export const SUNO = { label: "Suno MCP", creditsPerGeneration: 10 };

export interface SunoClip {
  id: string;
  audioUrl: string;
  title?: string;
  duration?: number;
}

export async function sunoGenerate(_i: { title: string; style: string; lyrics: string; instrumental: boolean; exclude?: string }): Promise<{ clips: SunoClip[]; credits?: number }> {
  throw new Error("suno: not implemented yet");
}
