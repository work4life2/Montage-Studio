// The dev release stamps its frontend origin here. Production/local builds
// keep backend-provided URLs unless the operator explicitly overrides them.
const DEFAULT_WEB_ORIGIN = "";

export function resolveWebUrl(url) {
  const origin = (process.env.AACP_WEB_URL || "").trim() || DEFAULT_WEB_ORIGIN;
  if (!origin) return url;
  const target = new URL(origin);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password ||
      target.pathname !== '/' || target.search || target.hash) {
    throw new Error("AACP_WEB_URL must be an http(s) origin without credentials, path, query or fragment.");
  }
  const source = new URL(url);
  // Preserve chain prefixes and request identifiers; never rewrite signing data.
  source.protocol = target.protocol;
  source.host = target.host;
  source.username = "";
  source.password = "";
  return source.href;
}
