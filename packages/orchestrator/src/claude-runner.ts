// Pure core of the Claude agent runner: it builds the invocation for the REAL
// `claude` CLI in headless mode and normalizes its stream-json output. No Node
// deps here (browser-safe) — the actual child_process spawn lives in the
// desktop main process and consumes buildClaudeInvocation + parseClaudeStreamLine.
//
// Why the real CLI: orchestrating the genuine Claude Code binary on a
// subscription is sanctioned (Agent SDK / `claude -p`), unlike using a stolen
// OAuth token in our own code. Context stays scoped because each run is bounded:
// identity = CLAUDE_CONFIG_DIR (per account), context = cwd (per project),
// and the orchestrator feeds a curated per-task prompt instead of a firehose.

export type ClaudePermissionMode = "default" | "acceptEdits" | "dontAsk" | "bypassPermissions" | "plan"

/** Which CLI backs this agent run. Defaults to "claude". See kimi-runner.ts / codex-runner.ts. */
export type AgentCli = "claude" | "kimi" | "codex"

export interface ClaudeAgentSpec {
  /** Which CLI to run (claude | kimi). Defaults to "claude" when omitted. */
  cli?: AgentCli
  /** Isolated config/home dir for this account — its identity/login.
   *  Maps to CLAUDE_CONFIG_DIR (claude) or KIMI_CODE_HOME (kimi). */
  configDir: string
  /** Project working directory — Claude scopes its transcript to this path. */
  projectDir: string
  /** The curated task brief the agent should act on. */
  prompt: string
  /** Role instructions appended to Claude Code's default system prompt. */
  role?: string
  /** Model id, e.g. "claude-sonnet-4-5". Omit to use the account default. */
  model?: string
  /** CHAI permission ids granted to this agent (see PERMISSIONS). */
  permissions?: string[]
  /** Resume a specific prior session for continuity; omit to start fresh. */
  resumeSessionId?: string
  /** Bound the agent loop so a run can't spiral. */
  maxTurns?: number
  /** Extra directories the agent may read beyond the project. */
  addDirs?: string[]
  /** Emit token-level deltas (--include-partial-messages). */
  partialMessages?: boolean
  /** Pure-conversation turn (onboarding / role debate): disable the agentic tools
   *  so Claude answers from its own knowledge in a single text turn instead of
   *  emitting a tool_use that would burn the turn budget and fail with
   *  error_max_turns. See CONVERSATIONAL_DISALLOWED_TOOLS. */
  conversational?: boolean
}

export interface ClaudeInvocation {
  command: string
  args: string[]
  cwd: string
  /** Env overrides to merge over the parent process env when spawning. */
  env: Record<string, string>
  /** When set, write this to the child's stdin instead of passing it via argv
   *  (Claude reads the prompt from stdin). Avoids Windows' command-line length
   *  limit, which a long role-debate transcript blows past via the claude.cmd shim. */
  stdin?: string
}

/** The outcome of a finished claude agent run. */
export interface ClaudeRunResult {
  /** Session id for resuming this agent's thread later. */
  sessionId?: string
  /** The agent's final text answer. */
  text: string
  isError: boolean
  costUsd?: number
  turns?: number
  /** Process exit code (null if killed). */
  exitCode: number | null
}

// CHAI permission id -> Claude Code tool names auto-approved for the agent.
const TOOLS_BY_PERMISSION: Record<string, string[]> = {
  read_project: ["Read", "Glob", "Grep"],
  edit_project: ["Edit", "Write"],
  run_commands: ["Bash"],
  // browser_testing / screenshots map to MCP tools wired later; computer_control
  // is handled via the permission mode below rather than a single tool.
}

/** Translate CHAI permissions into Claude's allowedTools + a permission mode. */
export function mapPermissionsToClaude(permissions: string[] = []): {
  allowedTools: string[]
  permissionMode: ClaudePermissionMode
} {
  const allowed = new Set<string>()
  for (const p of permissions) for (const tool of TOOLS_BY_PERMISSION[p] ?? []) allowed.add(tool)
  // "dontAsk" keeps headless runs from hanging on a prompt: anything outside the
  // allowed set (and the read-only command set) is denied instead of asked.
  // "computer_control" is the dangerous, explicitly-approved level → full access.
  const permissionMode: ClaudePermissionMode = permissions.includes("computer_control")
    ? "bypassPermissions"
    : "dontAsk"
  return { allowedTools: [...allowed], permissionMode }
}

// Claude Code's built-in agentic/meta tools. For a pure-conversation turn we
// pass these to --disallowedTools so they're removed from the set the model can
// call: an onboarding/role-debate reply must come back as TEXT, not a tool_use.
// (Passing no --allowedTools does NOT disable them — that flag only governs
// auto-approval; the tools stay available and Claude, being an agentic CLI,
// will sometimes call one and then hit error_max_turns.)
const CONVERSATIONAL_DISALLOWED_TOOLS = [
  "Task", "Bash", "BashOutput", "KillShell", "Glob", "Grep", "Read", "Edit", "Write",
  "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch", "TodoWrite", "PowerShell", "Skill",
  "ToolSearch", "AskUserQuestion", "DesignSync", "PushNotification", "RemoteTrigger", "Monitor",
  "ScheduleWakeup", "EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ExitWorktree",
  "CronCreate", "CronDelete", "CronList", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate",
  "TaskOutput", "TaskStop",
]

/** Build the headless `claude` invocation for one agent task. */
export function buildClaudeInvocation(spec: ClaudeAgentSpec, opts?: { command?: string }): ClaudeInvocation {
  // Note: no --bare (it skips OAuth/keychain and would force ANTHROPIC_API_KEY),
  // and we deliberately do NOT set ANTHROPIC_API_KEY so the subscription login
  // in configDir is used.
  // The prompt goes via stdin (see ClaudeInvocation.stdin), NOT argv: a long
  // role-debate transcript would otherwise overflow the Windows command line.
  const args = ["-p", "--output-format", "stream-json", "--verbose"]
  if (spec.partialMessages) args.push("--include-partial-messages")
  if (spec.model) args.push("--model", spec.model)
  if (spec.role) args.push("--append-system-prompt", spec.role)

  const { allowedTools, permissionMode } = mapPermissionsToClaude(spec.permissions)
  if (allowedTools.length) args.push("--allowedTools", allowedTools.join(","))
  // Conversation-only turns disable the agentic tools so the reply is text, not a
  // tool_use that would dead-end at error_max_turns.
  if (spec.conversational) args.push("--disallowedTools", CONVERSATIONAL_DISALLOWED_TOOLS.join(","))
  args.push("--permission-mode", permissionMode)

  if (typeof spec.maxTurns === "number") args.push("--max-turns", String(spec.maxTurns))
  if (spec.resumeSessionId) args.push("--resume", spec.resumeSessionId)
  for (const dir of spec.addDirs ?? []) args.push("--add-dir", dir)

  return {
    command: opts?.command ?? "claude",
    args,
    cwd: spec.projectDir,
    env: { CLAUDE_CONFIG_DIR: spec.configDir },
    stdin: spec.prompt,
  }
}

export type ClaudeRunEvent =
  | { type: "init"; sessionId: string; model?: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; input?: unknown }
  | { type: "retry"; attempt: number; error: string }
  | { type: "result"; sessionId: string; text: string; costUsd?: number; turns?: number; isError: boolean }
  | { type: "unknown"; raw: unknown }

function textOfBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ""
  return blocks
    .filter((b): b is { type: string; text: string } => !!b && typeof b === "object" && (b as any).type === "text")
    .map((b) => b.text)
    .join("")
}

/** Normalize one parsed stream-json object into zero or more run events. */
export function parseClaudeStreamEvent(raw: unknown): ClaudeRunEvent[] {
  if (!raw || typeof raw !== "object") return [{ type: "unknown", raw }]
  const e = raw as Record<string, any>
  switch (e.type) {
    case "system":
      if (e.subtype === "init") return [{ type: "init", sessionId: e.session_id, model: e.model }]
      if (e.subtype === "api_retry") return [{ type: "retry", attempt: e.attempt, error: e.error }]
      return [{ type: "unknown", raw }]
    case "assistant": {
      const blocks = e.message?.content
      const events: ClaudeRunEvent[] = []
      const text = textOfBlocks(blocks)
      if (text) events.push({ type: "text", text })
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b && typeof b === "object" && b.type === "tool_use") {
            events.push({ type: "tool", name: b.name, input: b.input })
          }
        }
      }
      return events.length ? events : [{ type: "unknown", raw }]
    }
    case "stream_event":
      if (e.event?.delta?.type === "text_delta") return [{ type: "text", text: e.event.delta.text }]
      return [{ type: "unknown", raw }]
    case "result":
      return [
        {
          type: "result",
          sessionId: e.session_id,
          text: typeof e.result === "string" ? e.result : "",
          costUsd: e.total_cost_usd,
          turns: e.num_turns,
          isError: Boolean(e.is_error),
        },
      ]
    default:
      return [{ type: "unknown", raw }]
  }
}

/** Parse one raw NDJSON line; blank/non-JSON lines yield no events. */
export function parseClaudeStreamLine(line: string): ClaudeRunEvent[] {
  const trimmed = line.trim()
  if (!trimmed) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }
  return parseClaudeStreamEvent(parsed)
}
