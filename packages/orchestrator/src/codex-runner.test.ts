import { describe, expect, test } from "bun:test"
import {
  buildCodexInvocation,
  mapPermissionsToCodexSandbox,
  parseCodexStreamEvent,
  parseCodexStreamLine,
} from "./codex-runner"

describe("mapPermissionsToCodexSandbox", () => {
  test("escalates from read-only to workspace-write to full access", () => {
    expect(mapPermissionsToCodexSandbox([])).toBe("read-only")
    expect(mapPermissionsToCodexSandbox(["read_project"])).toBe("read-only")
    expect(mapPermissionsToCodexSandbox(["edit_project"])).toBe("workspace-write")
    expect(mapPermissionsToCodexSandbox(["run_commands"])).toBe("workspace-write")
    expect(mapPermissionsToCodexSandbox(["computer_control"])).toBe("danger-full-access")
  })
})

describe("buildCodexInvocation", () => {
  test("isolates account via CODEX_HOME and project via -C/cwd, folds role into prompt", () => {
    const inv = buildCodexInvocation({
      cli: "codex",
      configDir: "/accounts/codex-1",
      projectDir: "/work/proj",
      prompt: "implement login",
      model: "gpt-5-codex",
      role: "Eres el agente Backend.",
      permissions: ["read_project", "edit_project"],
    })
    expect(inv.command).toBe("codex")
    expect(inv.cwd).toBe("/work/proj")
    expect(inv.env.CODEX_HOME).toBe("/accounts/codex-1")
    // headless JSONL exec; working root + model threaded.
    expect(inv.args.slice(0, 2)).toEqual(["exec", "--json"])
    expect(inv.args).toContain("--skip-git-repo-check")
    expect(inv.args[inv.args.indexOf("-C") + 1]).toBe("/work/proj")
    expect(inv.args[inv.args.indexOf("-m") + 1]).toBe("gpt-5-codex")
    // exec is already non-interactive and rejects -a; only the sandbox is set.
    expect(inv.args).not.toContain("-a")
    expect(inv.args[inv.args.indexOf("-s") + 1]).toBe("workspace-write")
    const prompt = inv.args[inv.args.length - 1]
    expect(prompt).toContain("Eres el agente Backend.")
    expect(prompt).toContain("implement login")
  })

  test("read-only when no write permission is granted", () => {
    const inv = buildCodexInvocation({ cli: "codex", configDir: "/c", projectDir: "/p", prompt: "look" })
    expect(inv.args[inv.args.indexOf("-s") + 1]).toBe("read-only")
  })

  test("computer_control bypasses approvals + sandbox and omits -a/-s", () => {
    const inv = buildCodexInvocation({
      cli: "codex",
      configDir: "/c",
      projectDir: "/p",
      prompt: "do it",
      permissions: ["computer_control"],
    })
    expect(inv.args).toContain("--dangerously-bypass-approvals-and-sandbox")
    expect(inv.args).not.toContain("-s")
  })

  test("resume passes the session id as the resume subcommand before the prompt", () => {
    const inv = buildCodexInvocation({
      cli: "codex",
      configDir: "/c",
      projectDir: "/p",
      prompt: "continue",
      resumeSessionId: "thread-123",
    })
    const i = inv.args.indexOf("resume")
    expect(i).toBeGreaterThan(0)
    expect(inv.args[i + 1]).toBe("thread-123")
    expect(inv.args[i + 2]).toBe("continue")
  })
})

describe("parseCodexStreamEvent", () => {
  test("thread.started yields an init event with the thread id as session", () => {
    expect(parseCodexStreamEvent({ type: "thread.started", thread_id: "t1" })).toEqual([
      { type: "init", sessionId: "t1" },
    ])
  })

  test("agent_message item.completed yields the answer text", () => {
    expect(
      parseCodexStreamEvent({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "Listo." } }),
    ).toEqual([{ type: "text", text: "Listo." }])
  })

  test("command_execution item.completed yields a tool event", () => {
    expect(
      parseCodexStreamEvent({
        type: "item.completed",
        item: { id: "i2", type: "command_execution", command: "ls", status: "completed" },
      }),
    ).toEqual([{ type: "tool", name: "bash", input: { command: "ls" } }])
  })

  test("turn.failed and top-level error become error results", () => {
    expect(parseCodexStreamEvent({ type: "turn.failed", error: { message: "boom" } })).toEqual([
      { type: "result", sessionId: "", text: "boom", isError: true },
    ])
    expect(parseCodexStreamEvent({ type: "error", message: "fatal" })).toEqual([
      { type: "result", sessionId: "", text: "fatal", isError: true },
    ])
  })

  test("reasoning, turn.completed and in-progress items carry no UI signal", () => {
    expect(parseCodexStreamEvent({ type: "item.completed", item: { id: "r", type: "reasoning", text: "..." } })).toEqual([])
    expect(parseCodexStreamEvent({ type: "turn.completed", usage: { input_tokens: 10 } })).toEqual([])
    expect(parseCodexStreamEvent({ type: "item.started", item: { id: "i", type: "agent_message", text: "" } })).toEqual([])
  })
})

describe("parseCodexStreamLine", () => {
  test("ignores blank and non-JSON lines", () => {
    expect(parseCodexStreamLine("")).toEqual([])
    expect(parseCodexStreamLine("not json")).toEqual([])
  })

  test("parses an item.completed line", () => {
    const line = JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "ok" } })
    expect(parseCodexStreamLine(line)).toEqual([{ type: "text", text: "ok" }])
  })
})
