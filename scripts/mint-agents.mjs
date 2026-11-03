// One-off: mint the four studio agents, each under its own hot wallet (Termix key mode).
//   node scripts/mint-agents.mjs [role ...]
// Credentials are cached per agent in data/<role>/termix (the skill scripts cache relative to cwd).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SCRIPTS = path.join(ROOT, "skills/termix-agent-skills/scripts");
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split("\n").filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);

const AGENTS = {
  montage: {
    name: "montage-studio",
    displayName: "Montage Studio",
    description:
      "Music-video and ad studio. Turns a brief into a finished cut: treatment, lyrics and a beat-timed shot list, then storyboard keyframes, an original song and image-to-video renders from a hired crew (Sketchboard, Beatsmith, RenderFarm), edited to the beat and delivered as a 1080p master. Every project is quoted in chat.",
    tags: ["music-video", "video-editing", "advertising", "storyboard", "suno", "runway"],
  },
  renderfarm: {
    name: "renderfarm",
    displayName: "RenderFarm",
    description:
      "Video renders on Runway: image-to-video and text-to-video shots from your keyframes or prompts, chained shots, frame-rate enhancement and upscaling. Priced per shot from the Runway credits it uses.",
    tags: ["video", "image-to-video", "runway", "animation", "render"],
  },
  beatsmith: {
    name: "beatsmith",
    displayName: "Beatsmith",
    description: "Original songs with Suno: your lyrics or ours, vocal or instrumental, any genre and tempo, delivered as full-length audio files. Priced per generation.",
    tags: ["music", "song", "suno", "jingle", "soundtrack"],
  },
  sketchboard: {
    name: "sketchboard",
    displayName: "Sketchboard",
    description: "Storyboards and keyframes: character model sheets and consistent 16:9, 9:16 or 1:1 keyframes, one per shot, ready for image-to-video.",
    tags: ["storyboard", "keyframes", "illustration", "character-design", "concept-art"],
  },
};

function run(role, script, args) {
  const cwd = path.join(ROOT, "data", role, "termix");
  fs.mkdirSync(cwd, { recursive: true });
  const out = execFileSync("node", [path.join(SCRIPTS, script), ...args], {
    cwd,
    env: { ...process.env, AACP_CHAIN: "bsc", TERMIX_WALLET_MODE: "key", WALLET_KEY: env[`${role.toUpperCase()}_WALLET_KEY`], A2A_RPC_URL: "https://bsc-dataseed.bnbchain.org" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    timeout: 20 * 60_000,
  });
  const i = out.lastIndexOf("\n{");
  return JSON.parse(i >= 0 ? out.slice(i + 1) : out.slice(out.indexOf("{")));
}

for (const role of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(AGENTS)) {
  const a = AGENTS[role];
  const who = run(role, "a2a-runtime.mjs", ["login"]);
  const have = run(role, "a2a-runtime.mjs", ["agents"]);
  const existing = have.items?.find((x) => x.name === a.name || x.name === a.displayName);
  if (existing) {
    console.log(`${role}: already minted ${existing.agentId} #${existing.agentTokenId}`);
    continue;
  }
  console.log(`${role}: wallet ${who.wallet ?? who.address} — minting ${a.name}`);
  const prep = run(role, "aacp-api.mjs", ["POST", "/api/v1/agents/prepare", "--auth", "session", "--body", JSON.stringify({ ...a, category: "Design & Brand" })]);
  const tx = run(role, "aacp-tx.mjs", ["--intent", JSON.stringify({ action: "registerAgent", contract: prep.contract ?? prep.to, callData: prep.callData, value: "0" }), "--yes"]);
  const hash = tx.results?.[0]?.txHash;
  console.log(`${role}: tx ${hash}`);
  for (let i = 0; i < 40; i++) {
    const st = run(role, "aacp-api.mjs", ["GET", `/api/v1/agents/by-tx/${hash}`, "--auth", "session"]);
    if (st.status === "CONFIRMED") {
      console.log(`${role}: CONFIRMED ${JSON.stringify(st)}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 8000));
  }
}
