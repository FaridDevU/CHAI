// Pure core of the Codex agent runner: builds the invocation for the REAL `codex`
// (Codex CLI) in non-interactive `exec` mode and normalizes its JSONL output. No
// Node deps here (browser-safe) — the desktop main process spawns the child and
// consumes buildCodexInvocation + parseCodexStreamLine.
//
// Why the real CLI: like Claude and Kimi, OpenAI reserves "Sign in with ChatGPT"
// subscription auth for its first-party CLI; a subscription token cannot drive
// the generic OpenAI API (doing so returns a bare "api error"). Orchestrating the
// genuine `codex` binary (logged in via `codex login`) is the sanctioned
// subscription path. Identity = CODEX_HOME (per account), context = cwd (per
// project), and the orchestrator feeds a curated per-task prompt.
//
// CLI facts (codex-cli 0.139, `codex exec --help`):
// - headless: `codex exec --json <prompt>` (JSONL events to stdout, no TUI).
// - working root: `-C <dir>`. model: `-m <model>`.
// - permissions: `-s read-only|workspace-write|danger-full-access`; the full
//   -access level is `--dangerously-bypass-approvals-and-sandbox`. `exec` never
//   prompts (it rejects -a/--ask-for-approval). No --append-system-prompt, so
//   the role is folded into the prompt. NOTE: `exec` reads stdin when it isn't a
//   TTY, so the spawner MUST close the child's stdin or it blocks forever.
// - run outside a git repo: `--skip-git-repo-check`.
// - resume a thread: `codex exec [OPTS] resume <session_id> <prompt>`.
// - data/identity dir override: CODEX_HOME (default ~/.codex).
// - login: `codex login` (ChatGPT OAuth browser flow).
//
// JSONL event shape (codex-rs/exec/src/exec_events.rs, tagged by `type`):
//   {type:"thread.started", thread_id}                         -> session id
//   {type:"item.completed", item:{id, type:"agent_message", text}} -> final answer
//   {type:"item.completed", item:{type:"command_execution", command, ...}}
//   {type:"turn.completed", usage:{...}}                        -> token usage only
//   {type:"turn.failed", error:{message}}                      -> turn error
//   {type:"error", message}                                    -> fatal stream error

import type { ClaudeAgentSpec, ClaudeInvocation, ClaudeRunEvent } from "./claude-runner"

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access"

/** Translate CHAI permissions into a Codex sandbox mode. */
export function mapPermissionsToCodexSandbox(permissions: string[] = []): CodexSandboxMode {
  if (permissions.includes("computer_control")) return "danger-full-access"
  if (permissions.includes("edit_project") || permissions.includes("run_commands")) return "workspace-write"
  return "read-only"
}

/** Build the headless `codex exec` invocation for one agent task. */
export function buildCodexInvocation(spec: ClaudeAgentSpec, opts?: { command?: string }): ClaudeInvocation {
  // Codex has no system-prompt flag in exec mode, so fold the role into the prompt.
  const prompt = spec.role ? `[Rol asignado: ${spec.role}]\n\n${spec.prompt}` : spec.prompt

  const args = ["exec", "--json", "--skip-git-repo-check", "--color", "never", "-C", spec.projectDir]
  if (spec.model) args.push("-m", spec.model)

  // `codex exec` is already non-interactive (it never prompts for approval), and
  // it rejects -a/--ask-for-approval (that flag lives on the top-level command).
  // So only the sandbox bounds what the agent may touch; the dangerous full
  // -access level removes the sandbox entirely.
  const sandbox = mapPermissionsToCodexSandbox(spec.permissions)
  if (sandbox === "danger-full-access") {
    args.push("--dangerously-bypass-approvals-and-sandbox")
    // "Permitido" = total freedom, which also means live internet access. `exec`
    // has no --search flag (that's interactive-only), so enable the web_search
    // tool via a config override (verified key: `[tools] web_search`).
    args.push("-c", "tools.web_search=true")
  } else {
    args.push("-s", sandbox)
  }

  // Options precede the `resume` subcommand; the prompt is the trailing positional.
  if (spec.resumeSessionId) args.push("resume", spec.resumeSessionId)
  args.push(prompt)

  return {
    command: opts?.command ?? "codex",
    args,
    cwd: spec.projectDir,
    env: { CODEX_HOME: spec.configDir },
  }
}

/** Normalize one parsed Codex JSONL object into zero or more run events. */
export function parseCodexStreamEvent(raw: unknown): ClaudeRunEvent[] {
  if (!raw || typeof raw !== "object") return [{ type: "unknown", raw }]
  const e = raw as Record<string, any>

  switch (e.type) {
    case "thread.started":
      return e.thread_id ? [{ type: "init", sessionId: String(e.thread_id) }] : []
    case "item.completed": {
      const item = e.item as Record<string, any> | undefined
      if (!item || typeof item !== "object") return []
      // agent_message is the assistant's response text; reasoning is a separate
      // (skipped) item, so concatenating agent_message texts yields the answer.
      if (item.type === "agent_message" && typeof item.text === "string") return [{ type: "text", text: item.text }]
      if (item.type === "command_execution" && typeof item.command === "string")
        return [{ type: "tool", name: "bash", input: { command: item.command } }]
      return []
    }
    case "turn.failed": {
      const message = e.error?.message
      return [
        {
          type: "result",
          sessionId: "",
          text: typeof message === "string" ? message : "El turno de Codex falló.",
          isError: true,
        },
      ]
    }
    case "error":
      return [
        {
          type: "result",
          sessionId: "",
          text: typeof e.message === "string" ? e.message : "Error de Codex.",
          isError: true,
        },
      ]
    // turn.started / turn.completed / item.started / item.updated carry no
    // UI-relevant final signal here (success text comes from item.completed and
    // the exit code drives isError).
    case "turn.started":
    case "turn.completed":
    case "item.started":
    case "item.updated":
      return []
    default:
      return [{ type: "unknown", raw }]
  }
}

/** Parse one raw JSONL line; blank/non-JSON lines yield no events. */
export function parseCodexStreamLine(line: string): ClaudeRunEvent[] {
  const trimmed = line.trim()
  if (!trimmed) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }
  return parseCodexStreamEvent(parsed)
}
