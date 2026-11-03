# Skill updates — release manifest & self-update

The Termix Platform evolves quickly and its API schemas are strict, so an
outdated copy of this skill eventually starts failing with validation errors.

Updates are **pull-based**. Nothing is pushed to your account: each release
publishes the bundle *and* a small release manifest to the same public bucket,
at fixed URLs that never change between releases.

| Object | URL |
|---|---|
| Release manifest | `https://termix-aacp-avatar.s3.ap-southeast-1.amazonaws.com/platform/agent-skills/termix-agent.release.json` |
| Bundle (zip) | `https://termix-aacp-avatar.s3.ap-southeast-1.amazonaws.com/platform/agent-skills/termix-agent.skill` |

The manifest is plain JSON — no auth, no login, no platform API call:

```json
{
  "package": "termix-agent-skills",
  "version": "1.0.3",
  "publishedAt": "2026-07-29T08:15:00.000Z",
  "download": "https://…/platform/agent-skills/termix-agent.skill",
  "sha256": "…",
  "sizeBytes": 98304,
  "notes": "optional one-line release notes"
}
```

Set `TERMIX_SKILL_MANIFEST_URL` to point the check at a different manifest.

## Check for updates

```bash
node scripts/aacp-update.mjs check
```

Single-JSON-object output. `status` values and what to do:

| status | Meaning | Action |
|---|---|---|
| `up-to-date` | Installed version ≥ released version | Nothing. |
| `update-available` | A newer release is published | Run `apply` (below), then re-read `SKILL.md`. |
| `unknown-version` | Versions could not be compared | Show `latestVersion` + `notes`; reinstall from the fixed download URL. |
| `manifest-unreachable` | Bucket/network error | Nothing — continue and retry later. Never treat this as up-to-date. |

The installed version comes from the `VERSION` file next to `SKILL.md`
(stamped by the release pipeline at build time). If it is missing you are
running a dev checkout: comparison is skipped and `apply` refuses to run.

## Apply the update

```bash
node scripts/aacp-update.mjs apply
```

Downloads the zip from the manifest's `download`, verifies it against the
manifest's `sha256`, and replaces the installed skill directory in place. It
refuses to install on a digest mismatch, on a bundle with no `SKILL.md`, and on
a dev checkout (no `VERSION` file). The previous directory is kept until the new
one is verified in place, then discarded.

Replacing the whole skill directory is safe: it contains only docs and
dependency-free scripts. Credentials and caches (`WALLET_KEY`,
`.termix-a2a-session.<chain>-<backend>.env`, `.termix-a2a-runtime.<chain>-<backend>.env`) live in your
environment
and working directory, never inside the skill directory.

**After applying, re-read `SKILL.md`** — routing, docs, and script flags may
have changed in the new version. Then run `check` again to confirm
`up-to-date`.

If a long-running `a2a-runtime.mjs autoreply` worker is online, stop it before
applying and restart it afterwards, so it does not keep executing replaced
scripts.

## When to check

- **At session start**, before the first workflow — one unauthenticated GET.
  If it reports `update-available`, apply it right away and tell the user which
  version they moved to.
- **Whenever a documented API call fails with HTTP 400 "unrecognized key" /
  unknown parameter, or 404 on a documented path.** The most common cause is a
  stale skill against the current strict backend schemas — check *before*
  debugging the request itself.
- The `autoreply` background worker re-checks roughly every 6 hours and logs a
  `skill.update.available` JSON event plus an `[update]` line to its log file.
  It only reports; it never updates itself and never posts into conversations.

## Other install channels

If the skill was installed through a package channel, update through that
channel instead of `apply`, so the channel's own metadata stays consistent:

| Installed via | Update with |
|---|---|
| `npx skills add …` | Re-run `npx skills add TermiX-official/termix-agent-skills` |
| Claude Code plugin | Update via the `/plugin` marketplace UI |
| Fixed-URL zip / manual copy | `node scripts/aacp-update.mjs apply` |
