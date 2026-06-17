// Integration smoke for the team runtime with mock providers.
//
// This stands in for the browser-level E2E in the pending doc (item 9). The app
// has no Playwright harness yet, and a full Electron/vite browser run isn't
// reproducible in CI on Windows — but the behaviour that item wanted to prove is
// the runtime contract: create a team, onboard, send to the team, then reopen the
// project and confirm messages/tasks/profile/sessions survived. That's exactly
// what this exercises end to end through the real ProjectTeamRuntime against an
// in-memory project filesystem, so it's deterministic and fast.

import { describe, expect, test } from "bun:test"
import type { ClaudeAgentSpec, ClaudeRunResult } from "@chai/orchestrator"
import type { ServerSDK } from "@/context/server-sdk"
import type { TeamAgent, TeamConfig } from "@/state/agents"
import { ProjectTeamRuntime, type ProjectTeamRuntimeDeps } from "./team-runtime"

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

function fakeServerSDK(): ServerSDK {
  return {
    client: { session: { abort: async () => undefined } },
    event: { on: () => () => undefined },
  } as unknown as ServerSDK
}

function deps(fs: ReturnType<typeof memFs>, over: Partial<ProjectTeamRuntimeDeps> = {}): ProjectTeamRuntimeDeps {
  return {
    serverSDK: fakeServerSDK(),
    runClaudeAgent: async () => ({ text: "ok", isError: false, sessionId: "s", exitCode: 0 }) as ClaudeRunResult,
    cancelClaudeAgent: async () => undefined,
    sessionForAgent: () => undefined,
    createSessionForAgent: async () => "sess",
    modelForProvider: () => ({ providerID: "anthropic", modelID: "claude-x" }),
    readProjectFile: fs.read,
    writeProjectFile: fs.write,
    appendProjectFile: fs.append,
    policy: { turnTimeoutMs: 5_000, maxRetries: 0, backoffBaseMs: 1, maxBackoffMs: 2, maxTeamTurns: 6 },
    ...over,
  }
}

describe("team runtime smoke: create -> onboard -> team -> reopen", () => {
  test("state survives closing and reopening the project", async () => {
    const fs = memFs()
    const agents: TeamAgent[] = [
      { accountId: "c", provider: "claude", account: "Coord", role: "coordinator", permissions: ["read_project"] },
      { accountId: "f", provider: "claude", account: "Front", role: "frontend", permissions: ["edit_project"] },
    ]
    const config: TeamConfig = {
      projectName: "Smoke",
      directory: "/proj/smoke",
      stack: "ts",
      agents,
      roleMode: "manual",
      visualTesting: false,
      computerControl: "off",
    }

    const run = async (_runId: string, spec: ClaudeAgentSpec): Promise<ClaudeRunResult> => {
      if (spec.prompt.includes("formando un equipo multi-agente")) {
        return { text: JSON.stringify({ summary: "perfil", capabilities: ["x"] }), isError: false, exitCode: 0 }
      }
      if (spec.prompt.includes("Divide la siguiente solicitud")) {
        return {
          text: JSON.stringify({ tasks: [{ title: "UI", assigneeRole: "frontend", priority: "high" }] }),
          isError: false,
          exitCode: 0,
        }
      }
      return {
        text: JSON.stringify({ text: "hecho", actions: [{ type: "final_result", summary: "ok", filesTouched: ["a.ts"] }] }),
        isError: false,
        exitCode: 0,
      }
    }

    // First open: onboard + a team round.
    const first = new ProjectTeamRuntime(config, deps(fs, { runClaudeAgent: run }))
    await first.ready
    await first.runOnboarding()
    const synthesis = await first.sendToTeam("crea la pantalla principal")
    await first.flushPersistence()

    expect(synthesis?.filesTouched).toContain("a.ts")
    expect(first.teamProfile()?.agents).toHaveLength(2)
    const firstMessageCount = first.messages().length
    expect(firstMessageCount).toBeGreaterThan(0)

    // Files were actually written.
    expect(fs.get(config.directory, ".chai/messages.jsonl")).toBeTruthy()
    expect(fs.get(config.directory, ".chai/tasks.json")).toBeTruthy()
    expect(fs.get(config.directory, ".chai/team-profile.json")).toBeTruthy()

    // Reopen: a fresh runtime over the same filesystem rehydrates everything.
    const reopened = new ProjectTeamRuntime(config, deps(fs, { runClaudeAgent: run }))
    await reopened.ready

    expect(reopened.messages().length).toBe(firstMessageCount)
    expect(reopened.teamProfile()?.projectName).toBe("Smoke")
    expect(reopened.tasks().length).toBe(first.tasks().length)
  })
})

describe("team runtime: user interjects in the role debate", () => {
  test("a queued user message reaches the debate and the feed", async () => {
    const fs = memFs()
    const agents: TeamAgent[] = [
      { accountId: "a", provider: "claude", account: "Uno", role: "auto", permissions: ["read_project"] },
      { accountId: "b", provider: "claude", account: "Dos", role: "auto", permissions: ["read_project"] },
    ]
    const config: TeamConfig = {
      projectName: "Debate",
      directory: "/proj/debate",
      stack: "ts",
      agents,
      roleMode: "auto",
      visualTesting: false,
      computerControl: "off",
    }

    const prompts: string[] = []
    const run = async (_runId: string, spec: ClaudeAgentSpec): Promise<ClaudeRunResult> => {
      prompts.push(spec.prompt)
      if (spec.prompt.includes("formando un equipo multi-agente")) {
        return {
          text: JSON.stringify({ summary: "perfil", capabilities: ["x"], recommendedRole: "coordinator" }),
          isError: false,
          exitCode: 0,
        }
      }
      return { text: "Yo me encargo.\nROL: coordinator", isError: false, exitCode: 0 }
    }

    const rt = new ProjectTeamRuntime(config, deps(fs, { runClaudeAgent: run }))
    await rt.ready
    // The user speaks before the debate loop starts; it must be folded into the
    // transcript so the agents see it on their next turn.
    rt.interject("que alguien tome backend y otro la UI")
    await rt.runOnboarding()

    const debatePrompts = prompts.filter((p) => p.includes("decidir quién toma cada rol"))
    expect(debatePrompts.length).toBeGreaterThan(0)
    expect(debatePrompts.some((p) => p.includes("Usuario (interviene): que alguien tome backend y otro la UI"))).toBe(true)
    expect(rt.messages().some((m) => m.from === "user" && m.text.includes("que alguien tome backend"))).toBe(true)
    // The agents answering the interjection address the user ("→ Tú"), not a teammate.
    expect(rt.messages().some((m) => (m.from === "a" || m.from === "b") && m.to === "user")).toBe(true)
  })
})

describe("team runtime: there is always a coordinator", () => {
  test("assigns a coordinator even when nobody picks one in the debate", async () => {
    const fs = memFs()
    const agents: TeamAgent[] = [
      { accountId: "a", provider: "claude", account: "Uno", role: "auto", permissions: ["read_project"] },
      { accountId: "b", provider: "claude", account: "Dos", role: "auto", permissions: ["read_project"] },
    ]
    const config: TeamConfig = {
      projectName: "Coord",
      directory: "/proj/coord",
      stack: "ts",
      agents,
      roleMode: "auto",
      visualTesting: false,
      computerControl: "off",
    }

    // Both agents only ever want "frontend" — neither claims coordinator.
    const run = async (_runId: string, spec: ClaudeAgentSpec): Promise<ClaudeRunResult> => {
      if (spec.prompt.includes("formando un equipo multi-agente")) {
        return {
          text: JSON.stringify({ summary: "perfil", capabilities: ["ui"], recommendedRole: "frontend" }),
          isError: false,
          exitCode: 0,
        }
      }
      return { text: "Quiero frontend.\nROL: frontend", isError: false, exitCode: 0 }
    }

    const rt = new ProjectTeamRuntime(config, deps(fs, { runClaudeAgent: run }))
    await rt.ready
    await rt.runOnboarding()
    await rt.flushPersistence()

    const team = JSON.parse(fs.get(config.directory, ".chai/team.json") ?? "{}") as TeamConfig
    const roles = team.agents.map((a) => a.role)
    expect(roles).toContain("coordinator")
  })
})

describe("team runtime: agents can message each other in the chat", () => {
  test("an agent delegates to a teammate by name and wraps up for the user", async () => {
    const fs = memFs()
    const agents: TeamAgent[] = [
      { accountId: "codex", provider: "codex", account: "Codex", role: "coordinator", permissions: ["read_project"] },
      { accountId: "kimi", provider: "kimi", account: "Kimi", role: "frontend", permissions: ["read_project"] },
    ]
    const config: TeamConfig = {
      projectName: "Deleg",
      directory: "/proj/deleg",
      stack: "ts",
      agents,
      roleMode: "manual",
      visualTesting: false,
      computerControl: "off",
    }

    const run = async (_runId: string, spec: ClaudeAgentSpec): Promise<ClaudeRunResult> => {
      if (spec.prompt.includes("te habla a TI")) {
        // Codex's chat turn: it hands the UI question to Kimi by name.
        return {
          text: JSON.stringify({
            text: "Le pregunto a Kimi, que lleva el frontend.",
            actions: [{ type: "delegate", toAgent: "Kimi", instructions: "¿Puedes encargarte de la UI?" }],
          }),
          isError: false,
          exitCode: 0,
        }
      }
      if (spec.prompt.includes("te delega esta tarea")) {
        return { text: JSON.stringify({ text: "Sí, yo me encargo de la UI.", actions: [] }), isError: false, exitCode: 0 }
      }
      if (spec.prompt.includes("Consultaste a tus compañeros")) {
        return { text: "Listo: Kimi se encarga de la UI.", isError: false, exitCode: 0 }
      }
      return { text: JSON.stringify({ text: "ok", actions: [] }), isError: false, exitCode: 0 }
    }

    const rt = new ProjectTeamRuntime(config, deps(fs, { runClaudeAgent: run }))
    await rt.ready
    await rt.sendToAgent("codex", "¿quién hace la UI?")

    const msgs = rt.messages()
    // Codex asked Kimi (agent-to-agent), and Kimi answered Codex — not the user.
    expect(msgs.some((m) => m.from === "codex" && m.to === "kimi")).toBe(true)
    expect(msgs.some((m) => m.from === "kimi" && m.to === "codex" && m.text.includes("me encargo"))).toBe(true)
    // Codex still gives the user a final answer.
    expect(msgs.some((m) => m.from === "codex" && m.to === "user")).toBe(true)
  })

  test("a role change agreed in the chat is applied and persisted, keeping a coordinator", async () => {
    const fs = memFs()
    const agents: TeamAgent[] = [
      { accountId: "codex", provider: "codex", account: "Codex", role: "coordinator", permissions: ["read_project"] },
      { accountId: "kimi", provider: "kimi", account: "Kimi", role: "frontend", permissions: ["read_project"] },
    ]
    const config: TeamConfig = {
      projectName: "Roles",
      directory: "/proj/roles",
      stack: "ts",
      agents,
      roleMode: "manual",
      visualTesting: false,
      computerControl: "off",
    }

    const run = async (_runId: string, spec: ClaudeAgentSpec): Promise<ClaudeRunResult> => {
      if (spec.prompt.includes("te habla a TI")) {
        return {
          text: JSON.stringify({
            text: "De acuerdo, que Kimi coordine.",
            actions: [{ type: "set_role", toAgent: "Kimi", role: "coordinator" }],
          }),
          isError: false,
          exitCode: 0,
        }
      }
      return { text: JSON.stringify({ text: "ok", actions: [] }), isError: false, exitCode: 0 }
    }

    const rt = new ProjectTeamRuntime(config, deps(fs, { runClaudeAgent: run }))
    await rt.ready
    await rt.sendToAgent("codex", "¿seguro que tú coordinas? confírmalo con Kimi")
    await rt.flushPersistence()

    const team = JSON.parse(fs.get(config.directory, ".chai/team.json") ?? "{}") as TeamConfig
    const roleOf = (id: string) => team.agents.find((a) => a.accountId === id)?.role
    // Kimi took coordinator; Codex swapped into Kimi's old role. Exactly one coordinator.
    expect(roleOf("kimi")).toBe("coordinator")
    expect(roleOf("codex")).toBe("frontend")
    expect(team.agents.filter((a) => a.role === "coordinator")).toHaveLength(1)
  })
})
