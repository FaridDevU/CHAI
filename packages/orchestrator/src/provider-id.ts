// Account-scoped provider id helpers, browser-safe (no Node deps) so the
// renderer can use them. Mirrors the server-side copy in
// @opencode-ai/core/provider — keep the separator in sync across both.
// An "account provider" is a base provider scoped to one connected account,
// encoded as `${base}#${accountKey}` (e.g. "anthropic#claude-2").

export const PROVIDER_ACCOUNT_SEPARATOR = "#"

/** Build the provider id for a base provider scoped to one account. */
export function accountProviderId(base: string, accountKey: string): string {
  return `${base}${PROVIDER_ACCOUNT_SEPARATOR}${accountKey}`
}

/** Split a provider id into its base provider and optional account key. */
export function parseProviderId(id: string): { base: string; accountKey?: string } {
  const at = id.indexOf(PROVIDER_ACCOUNT_SEPARATOR)
  if (at === -1) return { base: id }
  return { base: id.slice(0, at), accountKey: id.slice(at + 1) || undefined }
}

/** True when the provider id is scoped to a specific account. */
export function isAccountProviderId(id: string): boolean {
  return id.includes(PROVIDER_ACCOUNT_SEPARATOR)
}
