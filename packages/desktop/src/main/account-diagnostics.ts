import spawn from "cross-spawn"
import type { ChildProcess } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { delimiter } from "node:path"
import type { AccountDiagnosticResult, AccountDiagnosticSpec, AgentCli } from "@chai/orchestrator"
import { getLogger } from "./logging"
import { resolveCliCommand } from "./claude-runner"

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_OUTPUT_CHARS = 120_000

function providerCli(provider: string): AgentCli {
  if (provider === "kimi") return "kimi"
  if (provider === "codex") return "codex"
  return "claude"
}

function capOutput(value: string) {
  return value.length > MAX_OUTPUT_CHARS ? value.slice(-MAX_OUTPUT_CHARS) : value
}

export async function runAccountDiagnostic(spec: AccountDiagnosticSpec): Promise<AccountDiagnosticResult> {
  const cli = providerCli(spec.provider)
  const { command, extraPath } = resolveCliCommand(cli)
  const env: Record<string, string | undefined> = { ...process.env, ...spec.runtime.env }
  if (extraPath.length) env.PATH = [...extraPath, env.PATH ?? env.Path ?? ""].filter(Boolean).join(delimiter)
  const cwd = spec.cwd ?? spec.runtime.profilePath
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS
  await Promise.all([
    mkdir(spec.runtime.profilePath, { recursive: true }),
    spec.runtime.homePath ? mkdir(spec.runtime.homePath, { recursive: true }) : undefined,
    spec.runtime.configPath ? mkdir(spec.runtime.configPath, { recursive: true }) : undefined,
    spec.runtime.tempPath ? mkdir(spec.runtime.tempPath, { recursive: true }) : undefined,
  ])

  return new Promise((resolve, reject) => {
    let child: ChildProcess
    let settled = false
    let timedOut = false
    let stdout = ""
    let stderr = ""
    try {
      child = spawn(command, spec.args, {
        cwd,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (err) {
      reject(err)
      return
    }

    getLogger()?.info(`[diagnostic ${spec.provider}] launching ${command} args=${spec.args.join(" ")} cwd=${cwd}`)

    const finish = (exitCode: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        ok: !timedOut && exitCode === 0,
        provider: spec.provider,
        command,
        args: spec.args,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode,
        timedOut,
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
      finish(null)
    }, timeoutMs)

    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      stdout = capOutput(stdout + chunk)
    })
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => {
      stderr = capOutput(stderr + chunk)
    })
    child.on("error", (err: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`No se pudo ejecutar '${command}': ${err.message}`))
    })
    child.on("close", (code: number | null) => finish(code))
  })
}
