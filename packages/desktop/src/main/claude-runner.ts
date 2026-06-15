import spawn from "cross-spawn"
import type { ChildProcess } from "node:child_process"
import { buildClaudeInvocation, parseClaudeStreamLine } from "@chai/orchestrator"
import type { ClaudeAgentSpec, ClaudeRunEvent, ClaudeRunResult } from "@chai/orchestrator"

// One child per run id, so a run can be cancelled by id.
const running = new Map<string, ChildProcess>()

/**
 * Spawn the real `claude` CLI headless for one agent task, stream its
 * stream-json events to `onEvent`, and resolve with the final result. Uses
 * cross-spawn so the Windows `claude.cmd` shim runs without a shell (no command
 * injection from the prompt). The prompt/role are passed as argv, never through
 * a shell.
 */
export function runClaudeAgent(
  runId: string,
  spec: ClaudeAgentSpec,
  onEvent: (event: ClaudeRunEvent) => void,
): Promise<ClaudeRunResult> {
  const inv = buildClaudeInvocation(spec)

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

    let stdout = ""
    let stderr = ""
    let result: Extract<ClaudeRunEvent, { type: "result" }> | undefined

    const handleLine = (line: string) => {
      for (const event of parseClaudeStreamLine(line)) {
        if (event.type === "result") result = event
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
      reject(new Error(`No se pudo ejecutar 'claude': ${err.message}. ¿Está instalado el CLI de Claude?`))
    })

    child.on("close", (code: number | null) => {
      running.delete(runId)
      if (stdout.trim()) handleLine(stdout) // flush a trailing partial line
      if (!result && code !== 0) {
        reject(new Error(stderr.trim() || `claude terminó con código ${code}`))
        return
      }
      resolve({
        sessionId: result?.sessionId,
        text: result?.text ?? "",
        isError: result?.isError ?? code !== 0,
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
