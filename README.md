# Montage Studio

Four agents on [Termix](https://www.agent.family) (BSC), hosted by one Node service. Each agent has its own hot wallet,
so each is a separate Termix account (the platform refuses sub-tasks between agents of one account).

| Agent | Token | Sells | Engine | Margin |
|---|---|---|---|---|
| **Montage Studio** | #403223 | finished music videos / ads — quote-only, priced in chat | direction (Claude via cun.ai) → crew via sub-tasks → ffmpeg edit | +50 % |
| **RenderFarm** | #403224 | image-to-video shots (3–15 s, 1080p, 60 fps), Runway music | Runway MCP (Kling 4, Enhance Frame Rate, Lyria 3) | +50 % |
| **Beatsmith** | #403225 | songs and instrumentals | Runway MCP music: Google Lyria 3 Pro, ElevenLabs Eleven Music | +20 % |
| **Sketchboard** | #403227 | storyboard keyframes + character sheets | gpt-image-2 via cun.ai | +20 % |

Listings: [Montage Studio](https://www.agent.family/listing?id=cmw0d9iuh0d1mwc01f6enn12z) ·
[RenderFarm](https://www.agent.family/listing?id=cmw0d94j50d1gwc01yhy332gx) ·
[Sketchboard](https://www.agent.family/listing?id=cmw0d8uh40czoqy01iie6rhao) · Beatsmith: see `data/listings.json`.

Suno was the original plan for Beatsmith; Suno's official MCP refuses this account ("can't connect AI apps"), and
third-party Suno resellers were ruled out, so Beatsmith runs on the official music models available through Runway.

## How a Montage order runs

```
buyer chats with Montage Studio ──▶ chat model (Claude) replies; when it can price the work it emits an estimate
                                    (length, shots, characters, music, format) → code computes the cost-plus price
                                    → quote (offer) in the chat → buyer accepts + funds
order funded ──▶ Montage accepts on-chain ──▶ direction: treatment, lyrics, beat-timed shot list (plan.json)
             ──▶ team channel kickoff
             ──▶ sub-task "Storyboard keyframes" → Sketchboard   (brief-<subtaskId>.json in the 1:1 thread)
             ──▶ [song with vocals] sub-task "Original song" → Beatsmith
             ◀── Sketchboard delivers storyboard.zip → Montage reviews (every keyframe present) → releases escrow
             ──▶ keyframes uploaded to RenderFarm's thread (public URLs) → sub-task "Shot renders" (+ music when
                 Beatsmith is not on the job) → RenderFarm
             ◀── RenderFarm delivers clips.zip (+ music takes) → review → release
             ──▶ edit: beats (librosa) → cut points snapped to the beat → titles → -14 LUFS mix → H.264 master + 720p preview
             ──▶ delivery (master, preview, song, contact sheet, production-notes.zip) on-chain
buyer accepts (or the challenge window passes and Montage claims) ──▶ root settles
             ──▶ each crew agent claims its sub-task (split claim), Montage claims the rest (claimRoot)
```

Montage hires only its own crew. Crew agents accept Montage's proposals on sight; sub-tasks from other agents are
planned from their scope and accepted only when the amount covers the agent's own cost-plus price (otherwise they
decline and say what it costs). Each crew agent also sells directly through its listing and chat.

Who makes the music: a song with vocals goes to Beatsmith (lyrics + takes to choose from) when this process hosts it;
instrumental beds — and songs when Beatsmith is not hosted — go to RenderFarm. Both use Runway's music models.

## Pricing

Prices are never typed in. `src/pricing.ts` and each role's `price()` compute **cost-plus**: price = (1 + margin) × cost,
where the cost includes the 2 % platform fee (buyer orders only — sub-tasks carry none) and gas. Unit costs
(`.env`): Runway $0.0156/credit (Pro; Lyria 3 Pro 8 credits/song, Eleven Music ~20 credits/min), gpt-image-2 $0.125/image (measured on the cun.ai bill),
gas $0.02/tx. Every price has a 1 USDC floor. `npm run quote -- <role> '<estimate json>'` prints price and breakdown;
listing package prices and chat quotes use the same functions.

## Operations

```bash
npm run doctor                                   # tools, keys, Runway account, wallets + BNB
npm run jobs                                     # every job with its spend
npm run quote -- montage '{"durationSec":30,"shots":12,"music":"song"}'
npm run make -- sketchboard "<brief>" '{"keyframes":3,"characterSheets":1}'      # one job without the marketplace
npm run make -- renderfarm "<brief>" '{"shots":1,"secondsPerShot":3}' --ref frame.png
npm run setup -- preview [role]                  # listing texts + computed package prices
npm run setup -- listing <role|all> [--update]   # publish / update listings (cover + samples)
npm run auth -- runway                           # browser sign-in, refresh token kept in data/oauth/
```

Per-agent data lives in `data/<role>/` (jobs, conversations, the Termix skill's credential cache).
Runway task ids are recorded in each job's `work/runway-tasks.json` as soon as a task starts, so a restart resumes the
task instead of paying for it again.

## Deployment

Same Linode as 3dcardagent and jev-fc-buddy (172.104.55.67), `/opt/montage-studio`, user `montage`, unit
`montage-studio`. Pull-based: push to `main` → `montage-studio-autodeploy.timer` runs `deploy/deploy.sh` within a
minute (`npm ci`, build, restart). The service binds `127.0.0.1:8795` only (no nginx site); operator view:

```bash
ssh -L 8795:127.0.0.1:8795 root@172.104.55.67    # then http://127.0.0.1:8795/health and /api/jobs
journalctl -fu montage-studio
```

Fresh server: `deploy/server-bootstrap.sh` (packages incl. ffmpeg, service user, checkout, units, librosa venv).
Then copy `.env.local` (four `*_WALLET_KEY`, `RELAY_API_KEY`) and `data/listings.json`, sign in to Runway on the
server through an SSH tunnel (`ssh -N -L 53682:127.0.0.1:53682 root@<host>`, then `npm run auth -- runway` there),
and start the unit. `SERVE_ROLES` in `/opt/montage-studio/.env` selects the hosted agents.

Secrets never enter the repo (it is public): `.env.local` and `data/` are git-ignored.
