import { describe, expect, test } from "bun:test"
import { Coordinator } from "./coordinator"
import { AccountRuntimeRegistry } from "./runtime"
import type { OrchestratorAgent, Transport } from "./types"

function agent(over: Partial<OrchestratorAgent> = {}): OrchestratorAgent {
  return {
    id: "a1",
    provider: "claude",
    accountId: "claude-1",
    account: "Claude 1",
    role: "Coordinador",
    permissions: ["read_project"],
    status: "ready",
    ...over,
  }
}

describe("Coordinator", () => {
  test("registers agents and picks the Coordinador as coordinator", () => {
    const c = new Coordinator()
    c.register(agent({ id: "a1", role: "Backend" }))
    c.register(agent({ id: "a2", role: "Coordinador" }))

    expect(c.list()).toHaveLength(2)
    expect(c.coordinator()?.id).toBe("a2")
  })

  test("falls back to the first agent when no Coordinador exists", () => {
    const c = new Coordinator()
    c.register(agent({ id: "a1", role: "Backend" }))
    c.register(agent({ id: "a2", role: "Tester" }))

    expect(c.coordinator()?.id).toBe("a1")
  })

  test("dispatch records the outgoing message even without a transport", async () => {
    const c = new Coordinator()
    c.register(agent({ id: "a1" }))

    const out = await c.dispatch("a1", "haz X")
    expect(out?.to).toBe("a1")
    expect(c.router.history()).toHaveLength(1)
  })

  test("dispatch relays the agent reply and toggles status via transport", async () => {
    const transport: Transport = {
      async deliver(a, message, runtime) {
        expect(runtime.accountId).toBe("claude-1")
        expect(runtime.isolation).toBe("home")
        return { from: a.id, to: message.from, type: "respuesta", text: `ok: ${message.text}` }
      },
    }
    const c = new Coordinator({
      transport,
      runtimes: new AccountRuntimeRegistry({ root: ".chai/runtimes" }),
    })
    c.register(agent({ id: "a1" }))

    const reply = await c.dispatch("a1", "haz X")
    expect(reply?.type).toBe("respuesta")
    expect(reply?.text).toBe("ok: haz X")
    expect(c.get("a1")?.status).toBe("ready")
    expect(c.router.history().map((m) => m.type)).toEqual(["pregunta", "respuesta"])
  })

  test("dispatch surfaces transport failures as error messages", async () => {
    const transport: Transport = {
      async deliver() {
        throw new Error("boom")
      },
    }
    const c = new Coordinator({ transport })
    c.register(agent({ id: "a1", provider: "codex", accountId: "codex-1" }))

    const reply = await c.dispatch("a1", "haz X")
    expect(reply?.type).toBe("error")
    expect(reply?.text).toBe("boom")
    expect(c.get("a1")?.status).toBe("error")
  })

  test("dispatch locks the account runtime while transport is running", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const transport: Transport = {
      async deliver(a, message) {
        await gate
        return { from: a.id, to: message.from, type: "respuesta", text: "done" }
      },
    }
    const c = new Coordinator({
      transport,
      runtimes: new AccountRuntimeRegistry({ root: ".chai/runtimes" }),
    })
    c.register(agent({ id: "a1", accountId: "claude-1" }))
    c.register(agent({ id: "a2", accountId: "claude-1", account: "Claude 1 copy" }))

    const first = c.dispatch("a1", "uno")
    const second = await c.dispatch("a2", "dos")
    expect(second?.type).toBe("error")
    expect(second?.text).toContain("already running")
    release()
    await first
  })

  test("dispatch rejects Claude when isolation is explicitly unsupported", async () => {
    const transport: Transport = {
      async deliver() {
        throw new Error("should not run")
      },
    }
    const c = new Coordinator({
      transport,
      runtimes: new AccountRuntimeRegistry({ root: ".chai/runtimes", claudeIsolation: "unsupported" }),
    })
    c.register(agent({ id: "a1", provider: "claude", accountId: "claude-1" }))

    const reply = await c.dispatch("a1", "haz X")
    expect(reply?.type).toBe("error")
    expect(reply?.text).toContain("Claude Code needs an isolated HOME")
    expect(c.get("a1")?.status).toBe("error")
  })

  test("tracks task lifecycle", () => {
    const c = new Coordinator()
    const task = c.createTask({ title: "Implementar login", assignedTo: "a1" })
    expect(task.status).toBe("assigned")

    c.updateTask(task.id, "done")
    expect(c.listTasks()[0]?.status).toBe("done")
  })
})
