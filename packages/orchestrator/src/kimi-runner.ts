// Pure core of the Kimi agent runner: builds the invocation for the REAL `kimi`
// (Kimi Code) CLI in headless mode and normalizes its stream-json output. No
// Node deps here (browser-safe) — the desktop main process spawns the child and
// consumes buildKimiInvocation + parseKimiStreamLine.
//
// Why the real CLI: like Claude, Moonshot reserves OAuth subscription auth for
// its first-party CLI; third-party tools must use an API key. Orchestrating the
// genuine `kimi` binary (logged in via `kimi login`) is the sanctioned
// subscription path. Identity = KIMI_CODE_HOME (per account), context = cwd (per
// project), and the orchestrator feeds a curated per-task prompt.
//
// CLI facts (kimi-code reference + print-mode docs):
// - headless: `kimi -p "<prompt>" --output-format stream-json` (no TUI).
// - model: `--model`/`-m`. permissions are coarse: `--auto` (auto-approve) or
//   `--yolo` (approve everything). There is NO --append-system-prompt /
//   --allowedTools / --add-dir / --max-turns, so the role is prepended to the
//   prompt and granular tool allow-lists are not available.
// - login: `kimi login` (RFC 8628 device-code, non-interactive).
// - data/identity dir override: KIMI_CODE_HOME (default ~/.kimi-code).
// - stream-json is OpenAI-style chat messages, one JSON object per line:
//   {role:"assistant", content, tool_calls:[{function:{name,arguments}}]},
//   {role:"tool", tool_call_id, content}. Some builds may also emit a wrapping
//   {type:"result"|"system", ...}; we handle both shapes defensively.
//
// NOTE: Kimi's exact print-mode flags/stream shape are not fully pinned by the
// public docs; these are the documented defaults. Verify on the first real run
// (see CHAI-docs) and adjust the flags/parser here if the CLI differs.

import type { ClaudeAgentSpec, ClaudeInvocation, ClaudeRunEvent } from "./claude-runner"

export type KimiPermissionMode = "yolo" | "auto" | "default"

/**
 * Kimi's print mode (`-p`) rejects the `--yolo`/`--auto` flags, so the only way
 * to grant unattended permission is the `default_permission_mode` config key
 * (values: manual | auto | yolo). Map CHAI permissions onto it:
 *  - computer_control ("Permitido") → yolo: approve everything, no restrictions.
 *  - run_commands / edit_project    → auto: auto permission mode.
 *  - otherwise                      → default.
 * The desktop runner writes this into the account's isolated config.toml before
 * launching kimi (kimi's web search/fetch services are already built in).
 */
export function kimiPermissionMode(permissions: string[] = []): KimiPermissionMode {
  if (permissions.includes("computer_control")) return "yolo"
  if (permissions.includes("run_commands") || permissions.includes("edit_project")) return "auto"
  return "default"
}

/** Build the headless `kimi` invocation for one agent task. */
export function buildKimiInvocation(spec: ClaudeAgentSpec, opts?: { command?: string }): ClaudeInvocation {
  // Kimi has no system-prompt flag, so fold the role into the prompt text.
  const prompt = spec.role ? `[Rol asignado: ${spec.role}]\n\n${spec.prompt}` : spec.prompt
  const args = ["-p", prompt, "--output-format", "stream-json"]
  if (spec.model) args.push("--model", spec.model)
  // NOTE: --auto / --yolo are INTERACTIVE-mode permission flags; kimi rejects
  // them in print mode ("Cannot combine --prompt with --auto/--yolo"). `-p` is
  // already non-interactive, so no approval flag is passed (permissions are
  // coarse and not flag-controllable here).
  // Resume a prior thread when available (best-effort; print-mode resume support
  // varies by version). Each task is task-scoped, so missing resume is fine.
  if (spec.resumeSessionId) args.push("--session", spec.resumeSessionId)

  return {
    command: opts?.command ?? "kimi",
    args,
    cwd: spec.projectDir,
    env: { KIMI_CODE_HOME: spec.configDir },
  }
}

function textOfKimiContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((b): b is { type?: string; text: string } => !!b && typeof b === "object" && typeof (b as any).text === "string")
    .map((b) => b.text)
    .join("")
}

/** Normalize one parsed Kimi stream-json object into zero or more run events. */
export function parseKimiStreamEvent(raw: unknown): ClaudeRunEvent[] {
  if (!raw || typeof raw !== "object") return [{ type: "unknown", raw }]
  const e = raw as Record<string, any>

  // Wrapping envelope shape (if a build emits one).
  if (typeof e.type === "string") {
    if (e.type === "result") {
      return [
        {
          type: "result",
          sessionId: e.session_id ?? e.sessionId ?? "",
          text: typeof e.result === "string" ? e.result : textOfKimiContent(e.content),
          costUsd: e.total_cost_usd ?? e.cost,
          turns: e.num_turns ?? e.turns,
          isError: Boolean(e.is_error ?? e.error),
        },
      ]
    }
    if ((e.type === "system" || e.type === "init") && (e.session_id || e.sessionId)) {
      return [{ type: "init", sessionId: e.session_id ?? e.sessionId, model: e.model }]
    }
    // Print mode emits the session id on a trailing meta line, e.g.
    // {role:"meta", type:"session.resume_hint", session_id:"session_..."}.
    if (e.type === "session.resume_hint" && (e.session_id || e.sessionId)) {
      return [{ type: "init", sessionId: String(e.session_id ?? e.sessionId) }]
    }
  }

  // OpenAI-style chat message lines.
  if (e.role === "assistant") {
    const events: ClaudeRunEvent[] = []
    const text = textOfKimiContent(e.content)
    if (text) events.push({ type: "text", text })
    if (Array.isArray(e.tool_calls)) {
      for (const tc of e.tool_calls) {
        const name = tc?.function?.name ?? tc?.name
        if (!name) continue
        let input: unknown = tc?.function?.arguments
        if (typeof input === "string") {
          try {
            input = JSON.parse(input)
          } catch {
            /* keep raw string */
          }
        }
        events.push({ type: "tool", name, input })
      }
    }
    return events.length ? events : [{ type: "unknown", raw }]
  }

  // user / tool / system / meta echo lines carry no further UI-relevant signal
  // (the meta session id is captured above).
  if (e.role === "user" || e.role === "tool" || e.role === "system" || e.role === "meta") return []

  return [{ type: "unknown", raw }]
}

/** Parse one raw NDJSON line; blank/non-JSON lines yield no events. */
export function parseKimiStreamLine(line: string): ClaudeRunEvent[] {
  const trimmed = line.trim()
  if (!trimmed) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }
  return parseKimiStreamEvent(parsed)
}
