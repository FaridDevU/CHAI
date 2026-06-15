import spawn from "cross-spawn"
import type { ChildProcess } from "node:child_process"
import { buildClaudeInvocation, buildKimiInvocation, parseClaudeStreamLine, parseKimiStreamLine } from "@chai/orchestrator"
import type { ClaudeAgentSpec, ClaudeRunEvent, ClaudeRunResult } from "@chai/orchestrator"
import { getLogger } from "./logging"

// One child per run id, so a run can be cancelled by id.
const running = new Map<string, ChildProcess>()

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
  const isKimi = spec.cli === "kimi"
  const inv = isKimi ? buildKimiInvocation(spec) : buildClaudeInvocation(spec)
  const parseStreamLine = isKimi ? parseKimiStreamLine : parseClaudeStreamLine

  return new Promise<ClaudeRunResult>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(inv.command, inv.args, {
        cwd: inv.cwd,
        env: { ...process.env, ...inv.env },
        windowsHide: true,
      })
    } catch (err) {
      reject(err)
      return
    }
    running.set(runId, child)
    // Diagnostics: log the command + isolated config dir (never the prompt) so a
    // CLI failure like Kimi's "api error" can be traced to auth/flags/version.
    getLogger()?.info(
      `[agent ${runId}] launching ${inv.command} (${isKimi ? "kimi" : "claude"}) cwd=${inv.cwd} configDir=${
        inv.env?.KIMI_CODE_HOME ?? inv.env?.CLAUDE_CONFIG_DIR ?? "?"
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
          `No se pudo ejecutar '${inv.command}': ${err.message}. ¿Está instalado el CLI de ${isKimi ? "Kimi Code" : "Claude"}?`,
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
        getLogger()?.warn(`[agent ${runId}] ${inv.command} exit=${code} stderr=${detail.slice(0, 800) || "(vacío)"}`)
      }
      if (!result && !baseText && code !== 0) {
        reject(new Error(detail || `${inv.command} terminó con código ${code}`))
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
