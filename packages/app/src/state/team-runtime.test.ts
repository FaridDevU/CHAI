import { describe, expect, mock, test } from "bun:test"
import type { ClaudeAgentSpec, ClaudeRunResult } from "@chai/orchestrator"
import type { ServerSDK } from "@/context/server-sdk"
import type { TeamAgent, TeamConfig } from "@/state/agents"
import { ProjectTeamRuntime, type ProjectTeamRuntimeDeps } from "./team-runtime"

// In-memory project filesystem backing the .chai/* persistence.
function memFs() {
  const files = new Map<string, string>()
  const key = (dir: string, rel: string) => `${dir}::${rel}`
  return {
    files,
    get: (dir: string, rel: string) => files.get(key(dir, rel)),
    read: async (dir: string, rel: string) => files.get(key(dir, rel)) ?? null,
    write: async (dir: string, rel: string, content: string) => {
      files.set(key(dir, rel), content)
      return key(dir, rel)
    },
    append: async (dir: string, rel: string, content: string) => {
      files.set(key(dir, rel), (files.get(key(dir, rel)) ?? "") + content)
      return key(dir, rel)
    },
  }
}

// Minimal ServerSDK stub — CLI-only teams never touch the session transport,
// but cancel/abort paths reference client.session.abort.
function fakeServerSDK(): ServerSDK {
  return {
    client: { session: { abort: async () => undefined } },
    event: { on: () => () => undefined },
  } as unknown as ServerSDK
}

function agent(over: Partial<TeamAgent> = {}): TeamAgent {
  return {
    accountId: "claude-1",
    provider: "claude",
    account: "Claude 1",
    role: "coordinator",
    permissions: ["read_project"],
    ...over,
  }
}

let dirSeq = 0
function team(agents: TeamAgent[], over: Partial<TeamConfig> = {}): TeamConfig {
  dirSeq += 1
  return {
    projectName: "Demo",
    directory: `/proj/${dirSeq}`,
    stack: "ts",
    agents,
    roleMode: "manual",
    visualTesting: false,
    computerControl: "off",
    ...over,
  }
}

function result(over: Partial<ClaudeRunResult> = {}): ClaudeRunResult {
  return { text: "ok", isError: false, sessionId: "sess-1", exitCode: 0, ...over }
}

function baseDeps(fs: ReturnType<typeof memFs>, over: Partial<ProjectTeamRuntimeDeps> = {}): ProjectTeamRuntimeDeps {
  return {
    serverSDK: fakeServerSDK(),
    runClaudeAgent: async () => result(),
    cancelClaudeAgent: async () => undefined,
    sessionForAgent: () => undefined,
    createSessionForAgent: async () => "sess-new",
    modelForProvider: () => ({ providerID: "anthropic", modelID: "claude-x" }),
    readProjectFile: fs.read,
    writeProjectFile: fs.write,
    appendProjectFile: fs.append,
    // Fast policy so retry/backoff/timeout tests stay quick.
    policy: { turnTimeoutMs: 5_000, maxRetries: 0, backoffBaseMs: 1, maxBackoffMs: 2, maxTeamTurns: 6 },
    ...over,
  }
}

describe("ProjectTeamRuntime.sendToAgent", () => {
  test("dispatches, records messages and persists to messages.jsonl", async () => {
    const fs = memFs()
    const t = team([agent()])
    const rt = new ProjectTeamRuntime(t, baseDeps(fs, { runClaudeAgent: async () => result({ text: "hecho" }) }))
    await rt.ready

    const reply = await rt.sendToAgent("claude-1", "haz X")
    await rt.flushPersistence()

    expect(reply?.type).toBe("respuesta")
    expect(reply?.text).toBe("hecho")
    expect(rt.messages().map((m) => m.type)).toEqual(["pregunta", "respuesta"])
    expect(rt.tasks().at(-1)?.status).toBe("done")

    const log = fs.get(t.directory, ".chai/messages.jsonl") ?? ""
    expect(log.trim().split("\n")).toHaveLength(2)
  })

  test("marks the agent timeout (not error) when a turn exceeds the limit", async () => {
    const fs = memFs()
    const cancel = mock(async () => undefined)
    const rt = new ProjectTeamRuntime(
      team([agent()]),
      baseDeps(fs, {
        runClaudeAgent: () => new Promise<ClaudeRunResult>(() => {}), // never resolves
        cancelClaudeAgent: cancel,
        policy: { turnTimeoutMs: 20, maxRetries: 0, backoffBaseMs: 1, maxBackoffMs: 2, maxTeamTurns: 6 },
      }),
    )
    await rt.ready

    const reply = await rt.sendToAgent("claude-1", "haz X")
    expect(reply?.type).toBe("error")
    expect(reply?.data?.timeout).toBe(true)
    expect(rt.agentStates()["claude-1"]).toBe("timeout")
    expect(cancel).toHaveBeenCalled()
  })

  test("retries once on a failing turn before surfacing the error", async () => {
    const fs = memFs()
    let calls = 0
    const rt = new ProjectTeamRuntime(
      team([agent()]),
      baseDeps(fs, {
        runClaudeAgent: async () => {
          calls += 1
          if (calls === 1) return result({ isError: true, text: "fallo" })
          return result({ text: "recuperado" })
        },
        policy: { turnTimeoutMs: 5_000, maxRetries: 1, backoffBaseMs: 1, maxBackoffMs: 2, maxTeamTurns: 6 },
      }),
    )
    await rt.ready

    const reply = await rt.sendToAgent("claude-1", "haz X")
    expect(calls).toBe(2)
    expect(reply?.text).toBe("recuperado")
  })
})

describe("ProjectTeamRuntime run control", () => {
  test("pause/resume toggle the run state around a gated turn", async () => {
    const fs = memFs()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const rt = new ProjectTeamRuntime(
      team([agent()]),
      baseDeps(fs, {
        runClaudeAgent: async () => {
          await gate
          return result()
        },
      }),
    )
    await rt.ready

    const pending = rt.sendToAgent("claude-1", "haz X")
    expect(rt.runState()).toBe("running")
    rt.pause()
    expect(rt.runState()).toBe("paused")
    rt.resume()
    expect(rt.runState()).toBe("running")
    release()
    await pending
    expect(rt.runState()).toBe("idle")
  })

  test("rejects a second concurrent run", async () => {
    const fs = memFs()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const rt = new ProjectTeamRuntime(
      team([agent()]),
      baseDeps(fs, {
        runClaudeAgent: async () => {
          await gate
          return result()
        },
      }),
    )
    await rt.ready

    const first = rt.sendToAgent("claude-1", "uno")
    expect(() => rt.sendToAgent("claude-1", "dos")).toThrow("ejecucion activa")
    release()
    await first
  })

  test("cancelActiveRuns cancels the active CLI run and resets state", async () => {
    const fs = memFs()
    const cancel = mock(async () => undefined)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const rt = new ProjectTeamRuntime(
      team([agent()]),
      baseDeps(fs, {
        cancelClaudeAgent: cancel,
        runClaudeAgent: async () => {
          await gate
          return result()
        },
      }),
    )
    await rt.ready

    const pending = rt.sendToAgent("claude-1", "haz X")
    await Promise.resolve() // let the run register its active runId
    await rt.cancelActiveRuns()
    expect(cancel).toHaveBeenCalled()
    expect(rt.runState()).toBe("idle")
    expect(rt.agentStates()["claude-1"]).toBe("ready")
    release()
    await pending.catch(() => undefined)
  })
})

describe("ProjectTeamRuntime.runOnboarding", () => {
  test("parses the profile JSON and assigns roles in auto mode", async () => {
    const fs = memFs()
    const onTeamUpdated = mock((_team: TeamConfig) => undefined)
    const t = team([agent({ role: "auto" })], { roleMode: "auto" })
    const rt = new ProjectTeamRuntime(
      t,
      baseDeps(fs, {
        onTeamUpdated,
        runClaudeAgent: async () =>
          result({
            text: JSON.stringify({
              summary: "soy backend",
              capabilities: ["apis"],
              recommendedRole: "backend",
            }),
          }),
      }),
    )
    await rt.ready

    const profile = await rt.runOnboarding()
    await rt.flushPersistence()
    expect(profile?.agents[0]?.recommendedRole).toBe("backend")
    expect(onTeamUpdated).toHaveBeenCalled()
    const updated = onTeamUpdated.mock.calls[0]?.[0] as TeamConfig
    expect(updated.agents[0]?.role).toBe("backend")
    expect(fs.get(t.directory, ".chai/team-profile.json")).toBeTruthy()
  })
})

describe("ProjectTeamRuntime.sendToTeam planner", () => {
  test("plans subtasks, runs them and consolidates a synthesis", async () => {
    const fs = memFs()
    const agents = [
      agent({ accountId: "c", account: "Coord", role: "coordinator" }),
      agent({ accountId: "f", account: "Front", role: "frontend" }),
      agent({ accountId: "t", account: "Test", role: "tester" }),
    ]
    const rt = new ProjectTeamRuntime(
      team(agents),
      baseDeps(fs, {
        runClaudeAgent: async (_runId: string, spec: ClaudeAgentSpec) => {
          if (spec.prompt.includes("Divide la siguiente solicitud")) {
            return result({
              text: JSON.stringify({
                summary: "plan",
                tasks: [
                  { title: "Construir UI", assigneeRole: "frontend", priority: "high" },
                  { title: "Probar", assigneeRole: "tester", priority: "medium" },
                ],
                done: false,
              }),
            })
          }
          return result({
            text: JSON.stringify({
              text: "subtarea hecha",
              actions: [{ type: "final_result", summary: "listo", filesTouched: ["ui.tsx"], tests: ["unit"] }],
              done: true,
            }),
          })
        },
      }),
    )
    await rt.ready

    const synthesis = await rt.sendToTeam("construye una pantalla")
    expect(synthesis?.perAgent.map((a) => a.accountId)).toEqual(["f", "t"])
    expect(synthesis?.filesTouched).toContain("ui.tsx")
    expect(synthesis?.tests).toContain("unit")
    // root task + 2 subtasks, all resolved
    expect(rt.tasks().filter((task) => task.status === "done").length).toBeGreaterThanOrEqual(3)
    // the consolidated result is recorded on the router
    expect(rt.messages().some((m) => m.type === "entrega")).toBe(true)
  })

  test("queues a permission request the agent asks for and grants on approval", async () => {
    const fs = memFs()
    const onTeamUpdated = mock(() => undefined)
    const agents = [
      agent({ accountId: "c", account: "Coord", role: "coordinator" }),
      agent({ accountId: "x", account: "Exec", role: "executor", permissions: ["read_project"] }),
    ]
    const rt = new ProjectTeamRuntime(
      team(agents),
      baseDeps(fs, {
        onTeamUpdated,
        runClaudeAgent: async (_runId: string, spec: ClaudeAgentSpec) => {
          if (spec.prompt.includes("Divide la siguiente solicitud")) {
            return result({
              text: JSON.stringify({ tasks: [{ title: "correr build", assigneeRole: "executor", priority: "high" }] }),
            })
          }
          return result({
            text: JSON.stringify({
              text: "necesito permiso",
              actions: [{ type: "request_permission", permission: "run_commands", reason: "ejecutar build" }],
            }),
          })
        },
      }),
    )
    await rt.ready

    await rt.sendToTeam("compila el proyecto")
    const requests = rt.permissionRequests()
    expect(requests).toHaveLength(1)
    expect(requests[0]?.permission).toBe("run_commands")

    rt.resolvePermissionRequest(requests[0]!.id, true)
    expect(rt.permissionRequests()).toHaveLength(0)
    expect(rt.effectivePermissions("x")).toContain("run_commands")
    expect(onTeamUpdated).toHaveBeenCalled()
  })
})

describe("ProjectTeamRuntime rehydration", () => {
  test("loads messages, tasks and profile from .chai/* on construction", async () => {
    const fs = memFs()
    const t = team([agent()])
    const msg = { id: "m1", from: "user", to: "claude-1", type: "info", text: "hola", timestamp: 1 }
    await fs.write(t.directory, ".chai/messages.jsonl", JSON.stringify(msg) + "\n")
    await fs.write(
      t.directory,
      ".chai/tasks.json",
      JSON.stringify([{ id: "t1", title: "vieja", status: "done", createdAt: 1, updatedAt: 1 }]),
    )
    await fs.write(
      t.directory,
      ".chai/team-profile.json",
      JSON.stringify({ projectName: "Demo", directory: t.directory, roleMode: "manual", generatedAt: 1, agents: [] }),
    )

    const rt = new ProjectTeamRuntime(t, baseDeps(fs))
    await rt.ready

    expect(rt.messages().some((m) => m.id === "m1")).toBe(true)
    expect(rt.tasks().some((task) => task.id === "t1")).toBe(true)
    expect(rt.teamProfile()?.projectName).toBe("Demo")
  })

  test("tolerates a partially written last jsonl line", async () => {
    const fs = memFs()
    const t = team([agent()])
    const good = JSON.stringify({ id: "m1", from: "user", to: "claude-1", type: "info", text: "ok", timestamp: 1 })
    await fs.write(t.directory, ".chai/messages.jsonl", good + "\n" + '{"id":"m2","broke') // truncated tail

    const rt = new ProjectTeamRuntime(t, baseDeps(fs))
    await rt.ready

    expect(rt.messages().map((m) => m.id)).toEqual(["m1"])
  })

  test("reconnectAgent forgets the stored session", async () => {
    const fs = memFs()
    const t = team([agent({ provider: "codex", accountId: "codex-1", account: "Codex" })])
    await fs.write(
      t.directory,
      ".chai/sessions.json",
      JSON.stringify({ "codex-1": { accountId: "codex-1", sessionId: "old", updatedAt: 1 } }),
    )
    const rt = new ProjectTeamRuntime(t, baseDeps(fs))
    await rt.ready

    rt.reconnectAgent("codex-1")
    await rt.flushPersistence()
    const sessions = JSON.parse(fs.get(t.directory, ".chai/sessions.json") ?? "{}")
    expect(sessions["codex-1"]).toBeUndefined()
    expect(rt.agentStates()["codex-1"]).toBe("ready")
  })
})
