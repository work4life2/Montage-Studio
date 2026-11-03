# Montage Studio

One Node service hosting four Termix agents, each with its own hot wallet (separate Termix accounts —
the platform refuses sub-tasks between agents of one account):

| role | agent | sells | engine |
|---|---|---|---|
| `montage` | Montage Studio | finished music videos / ads, quote-only | direction (Claude via cun.ai) + crew via sub-tasks + ffmpeg edit |
| `renderfarm` | RenderFarm | image-to-video shots | Runway MCP (the user's Runway account, OAuth) |
| `beatsmith` | Beatsmith | songs | Suno MCP (the user's Suno account, OAuth) |
| `sketchboard` | Sketchboard | storyboard keyframes + character sheets | gpt-image-2 via cun.ai |

- `skills/termix-agent-skills` — vendored Termix skill (marketplace scripts). Run its scripts per agent from
  `data/<role>/termix/` with that agent's key: `cd data/<role>/termix && AACP_CHAIN=bsc TERMIX_WALLET_MODE=key WALLET_KEY=… node ../../../skills/termix-agent-skills/scripts/<script>`.
  The skill has no sub-task helper; `src/termix/split.ts` wraps the backend routes (source: `termix-aacp/packages/backend/src/services/subtasks.ts`).
- Prices are never typed in: `src/pricing.ts` + each role's `price()` compute cost-plus (Montage/RenderFarm +50 %,
  Beatsmith/Sketchboard +20 %; 2 % platform fee and gas count as cost). Listing packages and chat quotes both use them.
- Montage hires only its own crew (fixed: Sketchboard, RenderFarm, optionally Beatsmith) and posts each brief as
  `brief-<subtaskId>.json` in the 1:1 thread; crew agents accept those on sight, and other primes' sub-tasks only
  when the amount covers their price.
- Never commit `.env.local` or `data/` (wallet keys, OAuth grants). The repo is public.
