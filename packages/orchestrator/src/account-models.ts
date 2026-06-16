import type { AccountRuntime } from "./types"

/** A selectable model surfaced to the UI. `disabled` ones are shown but not pickable. */
export type AccountModelOption = {
  value: string
  label?: string
  disabled?: boolean
}

/** Which account (provider + isolated runtime) to read the local model cache for. */
export type AccountModelsSpec = {
  provider: string
  runtime: AccountRuntime
}

/**
 * Parse Codex's `models_cache.json` (the same file its `/model` picker reads).
 * Shape: `{ models: [{ slug, display_name, visibility, priority, ... }] }`.
 * Only `visibility: "list"` entries are user-selectable; the rest (e.g. the
 * internal `codex-auto-review`, marked `hide`) are dropped. Sorted by the
 * picker's own `priority` so the default lands first.
 */
export function parseCodexModelsCache(json: string): AccountModelOption[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  const models = (parsed as { models?: unknown })?.models
  if (!Array.isArray(models)) return []
  return models
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object" && m["visibility"] === "list")
    .map((m) => ({ slug: String(m["slug"] ?? ""), label: m["display_name"], priority: Number(m["priority"] ?? 0) }))
    .filter((m) => m.slug)
    .sort((a, b) => a.priority - b.priority)
    .map((m) => ({ value: m.slug, label: typeof m.label === "string" ? m.label : undefined }))
}

const TRAILING_VARIANT = /\[[^\]]*\]\s*$/

/**
 * Parse Claude Code's `.claude.json` `additionalModelOptionsCache` — the extra
 * picker entries the CLI fetched from the account (e.g. `Fable (disabled)`),
 * each carrying a real `disabled` flag. The standard families (Opus/Sonnet/
 * Haiku) are NOT in this file (they're built into the binary), so callers merge
 * these onto a curated base. The `[1m]`-style variant suffix is stripped so the
 * value matches the base `--model` alias.
 */
export function parseClaudeModelOptions(json: string): AccountModelOption[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  const cache = (parsed as { additionalModelOptionsCache?: unknown })?.additionalModelOptionsCache
  if (!Array.isArray(cache)) return []
  const out: AccountModelOption[] = []
  for (const entry of cache) {
    if (!entry || typeof entry !== "object") continue
    const raw = (entry as Record<string, unknown>)["value"]
    if (typeof raw !== "string" || !raw) continue
    const value = raw.replace(TRAILING_VARIANT, "")
    const label = (entry as Record<string, unknown>)["label"]
    out.push({
      value,
      label: typeof label === "string" ? label : undefined,
      disabled: (entry as Record<string, unknown>)["disabled"] === true,
    })
  }
  return out
}

/** Where each provider keeps its local model cache, relative to the runtime env. */
export function modelCacheEnvKey(provider: string): { envKey: string; file: string } | undefined {
  if (provider === "codex") return { envKey: "CODEX_HOME", file: "models_cache.json" }
  if (provider === "claude") return { envKey: "CLAUDE_CONFIG_DIR", file: ".claude.json" }
  return undefined
}
