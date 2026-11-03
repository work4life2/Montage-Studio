import fs from "node:fs";
import path from "node:path";
import { getConfig, ROLES, type Role } from "../config.js";
import { roleSpec } from "../roles/index.js";
import { termix } from "../termix/client.js";
import { run } from "../util/exec.js";
import { coverPath, generateCovers } from "./covers.js";

function listingsFile() {
  return path.join(getConfig().dataDir, "listings.json");
}

/** Published listing ids per role (data/listings.json), so offers can be attached to them. */
export function savedListings(): Partial<Record<Role, string>> {
  try {
    return JSON.parse(fs.readFileSync(listingsFile(), "utf8")) as Partial<Record<Role, string>>;
  } catch {
    return {};
  }
}

function saveListing(role: Role, id: string) {
  const all = savedListings();
  all[role] = id;
  fs.writeFileSync(listingsFile(), JSON.stringify(all, null, 2));
}

/** Package prices are computed (cost-plus) from each package's estimate, never typed in. */
export function listingBody(role: Role) {
  const spec = roleSpec(role);
  const cfg = getConfig();
  const priced = spec.listing.packages.map((p) => ({ p, q: spec.price(p.estimate) }));
  const guide = priced.map(({ p, q }) => `${p.name} ≈ ${q.price} ${cfg.currency} (${q.deliveryDays} day${q.deliveryDays > 1 ? "s" : ""})`);
  const publish = spec.listing.publishPackages !== false;
  const description = spec.listing.description.replace("{packages}", publish ? guide.map((g) => `• ${g}`).join("\n") : guide.join(" · "));
  const basePrice = Math.min(...priced.map(({ q }) => q.price));
  const first = priced.find(({ q }) => q.price === basePrice)!;
  return {
    title: spec.listing.title,
    category: "Design & Brand",
    basePrice: String(basePrice),
    currency: cfg.currency,
    deliveryDays: first.q.deliveryDays,
    description: description.slice(0, 5000),
    skillTag: spec.listing.skillTag,
    tags: spec.listing.tags.slice(0, 20),
    instantBuyable: spec.listing.instantBuyable,
    publicSearch: true,
    settlementType: "escrow",
    ...(publish
      ? { packages: priced.map(({ p, q }) => ({ id: p.id, name: p.name, scope: p.scope.slice(0, 1000), price: String(q.price), delivery: String(q.deliveryDays), ...(p.tone ? { tone: p.tone } : {}) })) }
      : {}),
    coverImageAlt: spec.listing.coverAlt,
  };
}

/** Create + publish (or update) the role's listing with its generated cover. */
export async function publishListing(role: Role, opts: { update?: boolean } = {}): Promise<string> {
  const t = termix(role);
  const cover = coverPath(role);
  if (!fs.existsSync(cover)) await generateCovers([role]);
  // Covers are PNGs of ~2 MB; listing media accepts up to 25 MB, but a JPEG loads faster in search.
  const jpg = cover.replace(/\.png$/, ".jpg");
  if (!fs.existsSync(jpg)) {
    const r = await run("ffmpeg", ["-v", "error", "-y", "-i", cover, "-q:v", "3", jpg], { timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(`cover conversion failed: ${r.stderr}`);
  }
  const up = await t.api<{ uploadUrl: string; publicUrl?: string; url?: string }>("POST", "/api/v1/listings/media/upload-url", {
    fileName: `${role}-cover.jpg`,
    contentType: "image/jpeg",
    sizeBytes: fs.statSync(jpg).size,
    purpose: "cover",
  });
  await t.upload(up.uploadUrl, jpg, "image/jpeg");
  const body = { ...listingBody(role), coverImageUrl: up.publicUrl ?? up.url };
  const existing = getConfig().agents[role].listingId || savedListings()[role];
  if (existing && opts.update) {
    const { category: _c, currency: _cur, ...patch } = body;
    await t.api("PATCH", `/api/v1/listings/${existing}`, patch);
    return existing;
  }
  if (existing) throw new Error(`${role} already has listing ${existing}; use --update`);
  const draft = await t.api<{ id: string }>("POST", `/api/v1/agents/${t.agentId}/services`, body);
  await t.api("POST", `/api/v1/listings/${draft.id}/publish`);
  saveListing(role, draft.id);
  return draft.id;
}

export async function listingsSetup(roles: Role[], update: boolean): Promise<void> {
  for (const role of roles) {
    const id = await publishListing(role, { update });
    process.stdout.write(`✅ ${role}: listing ${id} ${update ? "updated" : "published"} — https://www.agent.family/listing?id=${id}\n`);
  }
}

export function previewListings(roles: Role[] = [...ROLES]): void {
  for (const role of roles) {
    const b = listingBody(role);
    process.stdout.write(`\n══ ${role}: ${b.title}\nbasePrice ${b.basePrice} ${b.currency}, ${b.deliveryDays} day(s), instantBuyable=${b.instantBuyable}\n`);
    for (const p of (b as { packages?: Array<{ name: string; price: string; delivery: string }> }).packages ?? []) process.stdout.write(`  • ${p.name}: ${p.price} ${b.currency} / ${p.delivery} d\n`);
    process.stdout.write(`${b.description}\n`);
  }
}
