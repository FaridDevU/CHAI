import spawn from "cross-spawn"
import type { ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import {
  buildClaudeInvocation,
  buildCodexInvocation,
  buildKimiInvocation,
  kimiPermissionMode,
  parseClaudeStreamLine,
  parseCodexStreamLine,
  parseKimiStreamLine,
} from "@chai/orchestrator"
import type { AgentCli } from "@chai/orchestrator"
import type { ClaudeAgentSpec, ClaudeRunEvent, ClaudeRunResult } from "@chai/orchestrator"
import { getLogger } from "./logging"

// One child per run id, so a run can be cancelled by id.
const running = new Map<string, ChildProcess>()

/**
 * Kimi's print mode can't take a `--yolo`/`--auto` flag, so grant permissions
 * by writing `default_permission_mode` into the account's isolated config.toml
 * right before launch. It's a top-level TOML key, so we replace an existing line
 * or insert one ahead of the first `[table]`. Rewritten every run from the
 * agent's current permissions; runs for one account are sequential, so there's
 * no race. Best-effort — a write failure must not block the agent.
 */
function applyKimiPermissionMode(configDir: string, permissions: string[] = []): void {
  const mode = kimiPermissionMode(permissions)
  const file = join(configDir, "config.toml")
  const line = `default_permission_mode = "${mode}"`
  try {
    mkdirSync(configDir, { recursive: true })
    let content = existsSync(file) ? readFileSync(file, "utf8") : ""
    if (/^\s*default_permission_mode\s*=.*$/m.test(content)) {
      content = content.replace(/^\s*default_permission_mode\s*=.*$/m, line)
    } else {
      const firstTable = content.search(/^\s*\[/m)
      content =
        firstTable === -1
          ? `${content}${content && !content.endsWith("\n") ? "\n" : ""}${line}\n`
          : `${content.slice(0, firstTable)}${line}\n${content.slice(firstTable)}`
    }
    writeFileSync(file, content, "utf8")
  } catch (err) {
    getLogger()?.info(`[agent kimi] could not set permission mode: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Resolve the agent CLI to a runnable path WITHOUT relying on PATH. A desktop app
 * launched from the GUI doesn't inherit the user's shell PATH, so `claude`/`kimi`
 * installed by their official installers (e.g. ~/.kimi-code/bin/kimi.exe) are
 * invisible to a bare spawn and fail with ENOENT. We probe the known install
 * locations per platform and fall back to the bare command (PATH) only if none
 * exist. Returns the command plus extra dirs to prepend to PATH so the CLI can
 * find its own sibling tools (e.g. kimi ships fd.exe next to kimi.exe).
 */
export function resolveCliCommand(cli: AgentCli): { command: string; extraPath: string[] } {
  const home = homedir()
  const win = process.platform === "win32"
  const candidatesByCli: Record<AgentCli, string[]> = {
    kimi: win
      ? [join(home, ".kimi-code", "bin", "kimi.exe")]
      : [join(home, ".kimi-code", "bin", "kimi")],
    codex: win
      ? [
          join(home, "AppData", "Local", "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
          join(home, "AppData", "Roaming", "npm", "codex.cmd"),
          join(home, "AppData", "Roaming", "npm", "codex.exe"),
        ]
      : [
          join(home, ".codex", "bin", "codex"),
          "/opt/homebrew/bin/codex",
          "/usr/local/bin/codex",
          join(home, ".npm-global", "bin", "codex"),
        ],
    claude: win
      ? [join(home, "AppData", "Roaming", "npm", "claude.cmd"), join(home, "AppData", "Roaming", "npm", "claude.exe")]
      : [
          join(home, ".claude", "local", "claude"),
          "/opt/homebrew/bin/claude",
          "/usr/local/bin/claude",
          join(home, ".npm-global", "bin", "claude"),
        ],
  }
  for (const candidate of candidatesByCli[cli]) {
    if (existsSync(candidate)) return { command: candidate, extraPath: [dirname(candidate)] }
  }
  // Not found in a known location — let cross-spawn try PATH, but still widen
  // PATH with the usual bin dirs in case the GUI launch dropped them.
  const extraPath = win
    ? [
        join(home, "AppData", "Roaming", "npm"),
        join(home, ".kimi-code", "bin"),
        join(home, "AppData", "Local", "Programs", "OpenAI", "Codex", "bin"),
      ]
    : ["/opt/homebrew/bin", "/usr/local/bin", join(home, ".npm-global", "bin"), join(home, ".codex", "bin")]
  return { command: cli, extraPath }
}

/**
 * Spawn the real agent CLI (`claude` or `kimi`, chosen by spec.cli) headless for
 * one agent task, stream its stream-json events to `onEvent`, and resolve with
 * the final result. Uses cross-spawn so the Windows `.cmd` shim runs without a
 * shell (no command injection from the prompt). The prompt/role are passed as
 * argv, never through a shell.
 */
export function runClaudeAgent(
  runId: string,
  spec: ClaudeAgentSpec,
  onEvent: (event: ClaudeRunEvent) => void,
): Promise<ClaudeRunResult> {
  const cli: AgentCli = spec.cli === "kimi" ? "kimi" : spec.cli === "codex" ? "codex" : "claude"
  const inv =
    cli === "kimi" ? buildKimiInvocation(spec) : cli === "codex" ? buildCodexInvocation(spec) : buildClaudeInvocation(spec)
  const parseStreamLine =
    cli === "kimi" ? parseKimiStreamLine : cli === "codex" ? parseCodexStreamLine : parseClaudeStreamLine
  // Resolve the CLI from its known install location (PATH-independent) and widen
  // the child PATH so a GUI-launched app still finds it and its sibling tools.
  const { command, extraPath } = resolveCliCommand(cli)
  const env: Record<string, string | undefined> = { ...process.env, ...inv.env }
  if (extraPath.length) env.PATH = [...extraPath, env.PATH ?? env.Path ?? ""].filter(Boolean).join(delimiter)
  // Kimi grants permissions via config, not a flag (print mode rejects --yolo).
  if (cli === "kimi" && inv.env?.KIMI_CODE_HOME) applyKimiPermissionMode(inv.env.KIMI_CODE_HOME, spec.permissions)

  return new Promise<ClaudeRunResult>((resolve, reject) => {
    let child: ChildProcess
    // Claude takes its (potentially huge) prompt via stdin to dodge Windows'
    // command-line length limit, which a long role-debate transcript overflows
    // through the claude.cmd shim. codex/kimi keep stdin closed: the prompt rides
    // argv and `codex exec` would otherwise block forever reading a non-TTY pipe.
    const promptViaStdin = typeof inv.stdin === "string"
    try {
      child = spawn(command, inv.args, {
        cwd: inv.cwd,
        env,
        windowsHide: true,
        stdio: [promptViaStdin ? "pipe" : "ignore", "pipe", "pipe"],
      })
    } catch (err) {
      reject(err)
      return
    }
    if (promptViaStdin && child.stdin) {
      child.stdin.on("error", () => {}) // ignore EPIPE if the child exits early
      child.stdin.end(inv.stdin)
    }
    running.set(runId, child)
    // Diagnostics: log the resolved command + isolated config dir (never the
    // prompt) so a CLI failure can be traced to path/auth/flags/version.
    getLogger()?.info(
      `[agent ${runId}] launching ${command} (${cli}) cwd=${inv.cwd} configDir=${
        inv.env?.KIMI_CODE_HOME ?? inv.env?.CODEX_HOME ?? inv.env?.CLAUDE_CONFIG_DIR ?? "?"
      } args=${inv.args.filter((a) => a !== spec.prompt && !a.startsWith("[Rol")).join(" ")}`,
    )

    let stdout = ""
    let stderr = ""
    let result: Extract<ClaudeRunEvent, { type: "result" }> | undefined
    // Fallbacks for CLIs (e.g. kimi) that may not emit a `result` event: we
    // accumulate streamed text and the last init session id and synthesize the
    // result on close. Claude always emits `result`, so this is a no-op for it.
    let textBuf = ""
    let initSessionId: string | undefined

    const handleLine = (line: string) => {
      for (const event of parseStreamLine(line)) {
        if (event.type === "result") result = event
        if (event.type === "init") initSessionId = event.sessionId
        if (event.type === "text") textBuf += event.text
        try {
          onEvent(event)
        } catch {}
      }
    }

    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk
      let nl: number
      while ((nl = stdout.indexOf("\n")) >= 0) {
        handleLine(stdout.slice(0, nl))
        stdout = stdout.slice(nl + 1)
      }
    })

    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk
    })

    child.on("error", (err: Error) => {
      running.delete(runId)
      reject(
        new Error(
          `No se pudo ejecutar '${command}': ${err.message}. ¿Está instalado el CLI de ${
            cli === "kimi" ? "Kimi Code" : cli === "codex" ? "Codex" : "Claude"
          }?`,
        ),
      )
    })

    child.on("close", (code: number | null) => {
      running.delete(runId)
      if (stdout.trim()) handleLine(stdout) // flush a trailing partial line
      const baseText = result?.text ?? textBuf
      const isError = result?.isError ?? code !== 0
      const detail = stderr.trim()
      if (isError) {
        getLogger()?.warn(`[agent ${runId}] ${command} exit=${code} stderr=${detail.slice(0, 800) || "(vacío)"}`)
      }
      if (!result && !baseText && code !== 0) {
        reject(new Error(detail || `${command} terminó con código ${code}`))
        return
      }
      // On error, surface the CLI's stderr detail to the UI instead of letting a
      // bare "api error" stand alone — so the real cause (auth/flags) is visible.
      const text = isError && detail ? [baseText, detail].filter(Boolean).join(" — ").slice(0, 600) : baseText || ""
      resolve({
        sessionId: result?.sessionId ?? initSessionId,
        text,
        isError,
        costUsd: result?.costUsd,
        turns: result?.turns,
        exitCode: code,
      })
    })
  })
}

export function cancelClaudeAgent(runId: string) {
  const child = running.get(runId)
  if (!child) return
  running.delete(runId)
  child.kill()
}
