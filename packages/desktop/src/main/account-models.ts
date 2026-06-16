import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  modelCacheEnvKey,
  parseClaudeModelOptions,
  parseCodexModelsCache,
  type AccountModelOption,
  type AccountModelsSpec,
} from "@chai/orchestrator"
import { getLogger } from "./logging"

/**
 * Read a provider's local model cache from its isolated account runtime and
 * return the picker options. Codex caches the full visible list in
 * `models_cache.json`; Claude only caches the extra/disabled options in
 * `.claude.json` (callers merge those onto a curated base). Missing or
 * unreadable files resolve to `[]` so the UI falls back to its known list.
 */
export async function readAccountModels(spec: AccountModelsSpec): Promise<AccountModelOption[]> {
  const target = modelCacheEnvKey(spec.provider)
  if (!target) return []
  const dir = spec.runtime.env?.[target.envKey]
  if (!dir) return []
  const path = join(dir, target.file)
  let json: string
  try {
    json = await readFile(path, "utf8")
  } catch {
    return []
  }
  try {
    return spec.provider === "codex" ? parseCodexModelsCache(json) : parseClaudeModelOptions(json)
  } catch (err) {
    getLogger()?.info(`[models ${spec.provider}] parse failed: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}
