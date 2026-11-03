import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { getConfig } from "../config.js";
import { logger } from "../log.js";

const log = logger("oauth");

/**
 * The hosted MCP servers of Runway and Suno sign in with the user's own account (OAuth 2.1:
 * dynamic client registration + PKCE + refresh tokens). `npm run auth -- <provider>` does the
 * browser sign-in once; the service then keeps the grant alive with the refresh token stored in
 * DATA_DIR/oauth/<provider>.json. Credits are spent from that account, exactly as in the app.
 */
export const PROVIDERS = {
  runway: { label: "Runway", mcpUrl: "https://mcp.runwayml.com/mcp", scope: "openid api:read_write" },
  suno: {
    label: "Suno",
    mcpUrl: "https://api.suno.com/mcp",
    scope: "api:v0 credits:spend download library:read library:search library:write offline_access profile:read",
  },
} as const;
export type ProviderId = keyof typeof PROVIDERS;

export function isProvider(x: string): x is ProviderId {
  return x in PROVIDERS;
}

interface AuthServerMeta {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

export interface StoredGrant {
  provider: ProviderId;
  resource: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  accessToken: string;
  refreshToken?: string;
  /** epoch ms */
  expiresAt: number;
  scope?: string;
  obtainedAt: string;
  refreshedAt?: string;
}

function grantFile(p: ProviderId): string {
  return path.join(getConfig().dataDir, "oauth", `${p}.json`);
}

export function loadGrant(p: ProviderId): StoredGrant | undefined {
  try {
    return JSON.parse(fs.readFileSync(grantFile(p), "utf8")) as StoredGrant;
  } catch {
    return undefined;
  }
}

function saveGrant(g: StoredGrant): void {
  const file = grantFile(g.provider);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(g, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

async function getJson<T>(url: string): Promise<T | undefined> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

/** RFC 9728 → RFC 8414: from the MCP endpoint to its authorization server's metadata. */
async function discover(mcpUrl: string): Promise<AuthServerMeta> {
  const u = new URL(mcpUrl);
  const prm =
    (await getJson<{ authorization_servers?: string[] }>(`${u.origin}/.well-known/oauth-protected-resource${u.pathname}`)) ??
    (await getJson<{ authorization_servers?: string[] }>(`${u.origin}/.well-known/oauth-protected-resource`));
  const issuer = prm?.authorization_servers?.[0] ?? u.origin;
  const iu = new URL(issuer);
  const tail = iu.pathname.replace(/\/+$/, "");
  const candidates = [
    `${iu.origin}/.well-known/oauth-authorization-server${tail}`,
    `${issuer.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`,
    `${iu.origin}/.well-known/openid-configuration${tail}`,
  ];
  for (const c of candidates) {
    const meta = await getJson<AuthServerMeta>(c);
    if (meta?.authorization_endpoint && meta.token_endpoint) return meta;
  }
  throw new Error(`no OAuth authorization-server metadata for ${mcpUrl} (issuer ${issuer})`);
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function tokenRequest(endpoint: string, form: Record<string, string>, clientSecret?: string): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (clientSecret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(form.client_id)}:${encodeURIComponent(clientSecret)}`).toString("base64")}`;
  const res = await fetch(endpoint, { method: "POST", headers, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  if (!res.ok || !body.access_token) throw new Error(`token endpoint HTTP ${res.status}: ${text.slice(0, 300)}`);
  return body;
}

/**
 * Interactive sign-in: registers a client, prints the authorization URL and waits for the
 * redirect on http://127.0.0.1:<OAUTH_CALLBACK_PORT>/callback. On a server, forward the port
 * first (`ssh -L 53682:127.0.0.1:53682 …`) and open the URL in your local browser.
 */
export async function authorize(p: ProviderId): Promise<StoredGrant> {
  const prov = PROVIDERS[p];
  const port = getConfig().oauth.callbackPort;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const meta = await discover(prov.mcpUrl);
  if (!meta.registration_endpoint) throw new Error(`${prov.label} offers no dynamic client registration`);
  const reg = await fetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Montage Studio (Termix agents)",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: prov.scope,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const regText = await reg.text();
  if (!reg.ok) throw new Error(`client registration HTTP ${reg.status}: ${regText.slice(0, 300)}`);
  const client = JSON.parse(regText) as { client_id: string; client_secret?: string };

  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const url = new URL(meta.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: prov.scope,
    resource: prov.mcpUrl,
  }).toString();

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", redirectUri);
      if (u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const err = u.searchParams.get("error");
      const got = u.searchParams.get("code");
      const ok = !err && got && u.searchParams.get("state") === state;
      res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
      res.end(ok ? `<h2>${prov.label} connected.</h2><p>You can close this tab.</p>` : `<h2>Sign-in failed</h2><pre>${err ?? "state mismatch"}</pre>`);
      server.close();
      if (ok) resolve(got!);
      else reject(new Error(`authorization failed: ${err ?? "state mismatch"} ${u.searchParams.get("error_description") ?? ""}`));
    });
    server.listen(port, "127.0.0.1", () => {
      process.stdout.write(`\nOpen this URL in your browser and sign in to ${prov.label}:\n\n${url.toString()}\n\nWaiting for the redirect to ${redirectUri} …\n`);
    });
    server.on("error", reject);
    setTimeout(() => {
      server.close();
      reject(new Error("timed out waiting for the browser sign-in (2 h)"));
    }, 2 * 3600_000).unref();
  });

  const tok = await tokenRequest(
    meta.token_endpoint,
    { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier, resource: prov.mcpUrl },
    client.client_secret,
  );
  const grant: StoredGrant = {
    provider: p,
    resource: prov.mcpUrl,
    tokenEndpoint: meta.token_endpoint,
    clientId: client.client_id,
    clientSecret: client.client_secret,
    accessToken: String(tok.access_token),
    refreshToken: tok.refresh_token ? String(tok.refresh_token) : undefined,
    expiresAt: Date.now() + Number(tok.expires_in ?? 3600) * 1000,
    scope: tok.scope ? String(tok.scope) : prov.scope,
    obtainedAt: new Date().toISOString(),
  };
  saveGrant(grant);
  log.info(`${prov.label}: signed in (refresh token: ${grant.refreshToken ? "yes" : "NO — the grant ends when the access token expires"})`);
  return grant;
}

const refreshing = new Map<ProviderId, Promise<StoredGrant>>();

/** A valid access token, refreshed (and the rotated refresh token persisted) when it is about to expire. */
export async function accessToken(p: ProviderId, opts: { force?: boolean } = {}): Promise<string> {
  const g = loadGrant(p);
  if (!g) throw new Error(`${PROVIDERS[p].label} is not connected: run \`npm run auth -- ${p}\``);
  if (!opts.force && g.expiresAt - Date.now() > 120_000) return g.accessToken;
  if (!g.refreshToken) throw new Error(`${PROVIDERS[p].label} access token expired and there is no refresh token: run \`npm run auth -- ${p}\``);
  let pending = refreshing.get(p);
  if (!pending) {
    pending = (async () => {
      const tok = await tokenRequest(g.tokenEndpoint, { grant_type: "refresh_token", refresh_token: g.refreshToken!, client_id: g.clientId, resource: g.resource }, g.clientSecret);
      const next: StoredGrant = {
        ...g,
        accessToken: String(tok.access_token),
        refreshToken: tok.refresh_token ? String(tok.refresh_token) : g.refreshToken,
        expiresAt: Date.now() + Number(tok.expires_in ?? 3600) * 1000,
        refreshedAt: new Date().toISOString(),
      };
      saveGrant(next);
      log.info(`${PROVIDERS[p].label}: access token refreshed`);
      return next;
    })().finally(() => refreshing.delete(p));
    refreshing.set(p, pending);
  }
  return (await pending).accessToken;
}
