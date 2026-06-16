import type { AccountRuntime } from "./types"

export type AccountDiagnosticKind = "models" | "version" | "custom"

export type AccountDiagnosticSpec = {
  provider: string
  runtime: AccountRuntime
  kind: AccountDiagnosticKind
  args: string[]
  cwd?: string
  timeoutMs?: number
}

export type AccountDiagnosticResult = {
  ok: boolean
  provider: string
  command: string
  args: string[]
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut?: boolean
}

const KNOWN_MODEL_IDS = [
  // OpenAI / Codex-style
  "gpt-5",
  "gpt-5-codex",
  "gpt-4.1",
  "gpt-4o",
  "o3",
  "o4-mini",
  // Claude-style
  "opus",
  "sonnet",
  "haiku",
  "claude-opus",
  "claude-sonnet",
  "claude-haiku",
  // Kimi-style
  "kimi-k2",
  "kimi",
]

function cleanModelToken(value: string): string | undefined {
  const token = value
    .trim()
    .replace(/^["'`[{(]+|["'`\]},)]+$/g, "")
    .replace(/[,;:]$/g, "")
  if (!token || token.length < 2 || token.length > 80) return undefined
  if (!/[a-z]/i.test(token)) return undefined
  if (/^(model|models|available|default|current|name|id|true|false|null)$/i.test(token)) return undefined
  return token
}

/**
 * Best-effort parser for CLI model listings. CLIs often print JSON, tables,
 * bullets or plain help text. This extracts likely model ids without coupling
 * CHAI to a hardcoded provider list.
 */
export function parseCliModels(output: string): string[] {
  const found = new Set<string>()
  const text = output.trim()
  if (!text) return []

  try {
    const parsed = JSON.parse(text)
    const visit = (value: unknown) => {
      if (typeof value === "string") {
        const cleaned = cleanModelToken(value)
        if (cleaned) found.add(cleaned)
        return
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item)
        return
      }
      if (value && typeof value === "object") {
        const obj = value as Record<string, unknown>
        for (const key of ["id", "name", "model", "modelID", "modelId"]) visit(obj[key])
        if (!("id" in obj) && !("name" in obj)) {
          for (const item of Object.values(obj)) visit(item)
        }
      }
    }
    visit(parsed)
  } catch {
    // fall through to text parsing
  }

  for (const known of KNOWN_MODEL_IDS) {
    const re = new RegExp(`\\b${known.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[a-z0-9._:-]*\\b`, "gi")
    for (const match of text.matchAll(re)) {
      const cleaned = cleanModelToken(match[0])
      if (cleaned) found.add(cleaned)
    }
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    const match =
      trimmed.match(/^(?:[-*]\s*)?([a-zA-Z][a-zA-Z0-9._:-]{2,})\s*(?:$|\s{2,}|\t|#|available|default)/i) ??
      trimmed.match(/["']?(?:id|name|model|modelID|modelId)["']?\s*[:=]\s*["']?([^"',\s}]+)/i)
    const cleaned = match?.[1] ? cleanModelToken(match[1]) : undefined
    if (cleaned) found.add(cleaned)
  }

  const models = [...found]
  return models
    .filter((model) => !models.some((other) => other !== model && other.endsWith(model)))
    .sort((a, b) => a.localeCompare(b))
}
