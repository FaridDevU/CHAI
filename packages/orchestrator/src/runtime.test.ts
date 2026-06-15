import { describe, expect, test } from "bun:test"
import { AccountRuntimeBusyError, AccountRuntimeRegistry, createAccountRuntime } from "./runtime"

describe("createAccountRuntime", () => {
  test("isolates a codex account under its own home/config/temp", () => {
    const rt = createAccountRuntime({ accountId: "codex-1", provider: "codex" }, { root: "/runtimes" })
    expect(rt.isolated).toBe(true)
    expect(rt.isolation).toBe("home")
    expect(rt.profilePath).toBe("/runtimes/codex-codex-1")
    expect(rt.homePath).toBe("/runtimes/codex-codex-1/home")
    // HOME/USERPROFILE point at the isolated profile, not the real user home.
    expect(rt.env.HOME).toBe(rt.homePath)
    expect(rt.env.USERPROFILE).toBe(rt.homePath)
    expect(rt.env.CODEX_HOME).toBe("/runtimes/codex-codex-1/config/codex")
    expect(rt.env.CHAI_ACCOUNT_ID).toBe("codex-1")
  })

  test("isolates a claude account and defaults to home isolation", () => {
    const rt = createAccountRuntime({ accountId: "claude-1", provider: "claude" }, { root: "/runtimes" })
    expect(rt.isolated).toBe(true)
    expect(rt.isolation).toBe("home")
    expect(rt.env.CLAUDE_CONFIG_DIR).toBe("/runtimes/claude-claude-1/config/claude")
    expect(rt.reason).toBeUndefined()
  })

  test("flags claude as not isolated when isolation is unsupported", () => {
    const rt = createAccountRuntime(
      { accountId: "claude-1", provider: "claude" },
      { root: "/runtimes", claudeIsolation: "unsupported" },
    )
    expect(rt.isolated).toBe(false)
    expect(rt.isolation).toBe("unsupported")
    expect(rt.reason).toContain("isolated HOME")
  })

  test("sanitizes hostile account/provider ids so they cannot escape the root", () => {
    const rt = createAccountRuntime(
      { accountId: "../../etc/passwd", provider: "claude/../x" },
      { root: "/runtimes" },
    )
    expect(rt.profilePath.startsWith("/runtimes/")).toBe(true)
    // The whole account folder collapses to a single segment: every path
    // separator is stripped, so no ".." can traverse out of the root.
    const tail = rt.profilePath.slice("/runtimes/".length)
    expect(tail.includes("/")).toBe(false)
  })

  test("normalizes windows-style roots to forward slashes", () => {
    const rt = createAccountRuntime({ accountId: "a", provider: "claude" }, { root: "C:\\Users\\x\\runtimes" })
    expect(rt.profilePath).toBe("C:/Users/x/runtimes/claude-a")
  })
})

describe("AccountRuntimeRegistry", () => {
  test("resolve caches the runtime per account and reuses it", () => {
    const reg = new AccountRuntimeRegistry({ root: "/runtimes" })
    const agent = { id: "a1", accountId: "claude-1", provider: "claude" } as any
    const first = reg.resolve(agent)
    const second = reg.resolve(agent)
    expect(second).toBe(first)
    expect(agent.runtime).toBe(first)
  })

  test("gives two accounts of the same provider fully separate isolated runtimes", () => {
    // The real multi-account case: two Claude (or Kimi/Codex) subscriptions side
    // by side. Each must get its own profile/config dir so their logins never mix.
    const a = createAccountRuntime({ accountId: "claude-1", provider: "claude" }, { root: "/runtimes" })
    const b = createAccountRuntime({ accountId: "claude-2", provider: "claude" }, { root: "/runtimes" })
    expect(a.isolated && b.isolated).toBe(true)
    expect(a.profilePath).not.toBe(b.profilePath)
    expect(a.env.CLAUDE_CONFIG_DIR).not.toBe(b.env.CLAUDE_CONFIG_DIR)
    expect(a.env.HOME).not.toBe(b.env.HOME)
  })

  test("locks per account, so DIFFERENT accounts run concurrently", async () => {
    const reg = new AccountRuntimeRegistry({ root: "/runtimes" })
    const a = createAccountRuntime({ accountId: "claude-1", provider: "claude" }, { root: "/runtimes" })
    const b = createAccountRuntime({ accountId: "claude-2", provider: "claude" }, { root: "/runtimes" })
    let releaseA!: () => void
    const gateA = new Promise<void>((resolve) => (releaseA = resolve))

    const first = reg.withLock(a, async () => {
      await gateA
      return "a"
    })
    expect(reg.isBusy("claude-1")).toBe(true)
    // Second account is independent — it must NOT be blocked by the first.
    expect(reg.isBusy("claude-2")).toBe(false)
    const second = await reg.withLock(b, async () => "b")
    expect(second).toBe("b")

    releaseA()
    expect(await first).toBe("a")
  })

  test("withLock serializes access and rejects concurrent use of one account", async () => {
    const reg = new AccountRuntimeRegistry({ root: "/runtimes" })
    const rt = createAccountRuntime({ accountId: "claude-1", provider: "claude" }, { root: "/runtimes" })
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))

    const first = reg.withLock(rt, async () => {
      await gate
      return "first"
    })
    expect(reg.isBusy("claude-1")).toBe(true)
    await expect(reg.withLock(rt, async () => "second")).rejects.toBeInstanceOf(AccountRuntimeBusyError)

    release()
    expect(await first).toBe("first")
    // Lock is released once the first task settles, so a later turn can run.
    expect(reg.isBusy("claude-1")).toBe(false)
    expect(await reg.withLock(rt, async () => "third")).toBe("third")
  })
})
