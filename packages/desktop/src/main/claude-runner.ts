import spawn from "cross-spawn"
import type { ChildProcess } from "node:child_process"
import { buildClaudeInvocation, buildKimiInvocation, parseClaudeStreamLine, parseKimiStreamLine } from "@chai/orchestrator"
import type { ClaudeAgentSpec, ClaudeRunEvent, ClaudeRunResult } from "@chai/orchestrator"

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
      const text = result?.text ?? textBuf
      if (!result && !text && code !== 0) {
        reject(new Error(stderr.trim() || `${inv.command} terminó con código ${code}`))
        return
      }
      resolve({
        sessionId: result?.sessionId ?? initSessionId,
        text: text || "",
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
