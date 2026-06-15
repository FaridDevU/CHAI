import type { AccountRuntime, OrchestratorAgent, RuntimeIsolation } from "./types"

export class AccountRuntimeBusyError extends Error {
  constructor(readonly accountId: string) {
    super(`Account ${accountId} is already running another agent`)
    this.name = "AccountRuntimeBusyError"
  }
}

export class AccountRuntimeUnsupportedError extends Error {
  constructor(readonly runtime: AccountRuntime) {
    super(runtime.reason ?? `Account ${runtime.accountId} does not have a supported isolated runtime`)
    this.name = "AccountRuntimeUnsupportedError"
  }
}

export interface RuntimeProfileOptions {
  root: string
  claudeIsolation?: RuntimeIsolation
}

function cleanSegment(value: string): string {
  const segment = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  return segment || "account"
}

function joinPath(...parts: string[]): string {
  const filtered = parts.filter(Boolean)
  if (filtered.length === 0) return ""
  return filtered
    .map((part, index) => {
      const normalized = part.replaceAll("\\", "/")
      if (index === 0) return normalized.replace(/\/+$/g, "")
      return normalized.replace(/^\/+|\/+$/g, "")
    })
    .join("/")
}

export function createAccountRuntime(
  agent: Pick<OrchestratorAgent, "accountId" | "provider">,
  opts: RuntimeProfileOptions,
): AccountRuntime {
  const id = cleanSegment(agent.accountId)
  const provider = cleanSegment(agent.provider)
  const profilePath = joinPath(opts.root, `${provider}-${id}`)
  const homePath = joinPath(profilePath, "home")
  const configPath = joinPath(profilePath, "config")
  const tempPath = joinPath(profilePath, "tmp")
  const commonEnv = {
    CHAI_ACCOUNT_ID: agent.accountId,
    CHAI_PROVIDER: agent.provider,
    CHAI_RUNTIME_HOME: profilePath,
    HOME: homePath,
    USERPROFILE: homePath,
    APPDATA: joinPath(homePath, "AppData", "Roaming"),
    LOCALAPPDATA: joinPath(homePath, "AppData", "Local"),
    TMP: tempPath,
    TEMP: tempPath,
  }

  if (agent.provider === "codex") {
    return {
      accountId: agent.accountId,
      provider: agent.provider,
      profilePath,
      homePath,
      configPath,
      tempPath,
      env: {
        ...commonEnv,
        CODEX_HOME: joinPath(configPath, "codex"),
      },
      isolation: "home",
      isolated: true,
    } satisfies AccountRuntime
  }

  if (agent.provider === "claude") {
    const isolation = opts.claudeIsolation ?? "home"
    const isolated = isolation !== "unsupported"
    return {
      accountId: agent.accountId,
      provider: agent.provider,
      profilePath,
      homePath,
      configPath,
      tempPath,
      env: {
        ...commonEnv,
        CLAUDE_CONFIG_DIR: joinPath(configPath, "claude"),
      },
      isolation,
      isolated,
      reason: isolated
        ? undefined
        : "Claude Code needs an isolated HOME/USERPROFILE, WSL, OS user, or container for subscription multi-account.",
    } satisfies AccountRuntime
  }

  return {
    accountId: agent.accountId,
    provider: agent.provider,
    profilePath,
    homePath,
    configPath,
    tempPath,
    env: commonEnv,
    isolation: "home",
    isolated: true,
  } satisfies AccountRuntime
}

export class AccountRuntimeRegistry {
  private readonly runtimes = new Map<string, AccountRuntime>()
  private readonly locks = new Set<string>()

  constructor(private readonly opts: RuntimeProfileOptions) {}

  resolve(agent: OrchestratorAgent): AccountRuntime {
    const existing = agent.runtime ?? this.runtimes.get(agent.accountId)
    if (existing) return existing
    const runtime = createAccountRuntime(agent, this.opts)
    this.runtimes.set(agent.accountId, runtime)
    agent.runtime = runtime
    return runtime
  }

  isBusy(accountId: string): boolean {
    return this.locks.has(accountId)
  }

  async withLock<T>(runtime: AccountRuntime, fn: () => Promise<T>): Promise<T> {
    if (this.locks.has(runtime.accountId)) throw new AccountRuntimeBusyError(runtime.accountId)
    this.locks.add(runtime.accountId)
    try {
      return await fn()
    } finally {
      this.locks.delete(runtime.accountId)
    }
  }
}
