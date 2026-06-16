import { describe, expect, test } from "bun:test"
import {
  buildClaudeInvocation,
  mapPermissionsToClaude,
  parseClaudeStreamLine,
  parseClaudeStreamEvent,
} from "./claude-runner"

describe("mapPermissionsToClaude", () => {
  test("maps CHAI permissions to allowed tools", () => {
    const { allowedTools, permissionMode } = mapPermissionsToClaude(["read_project", "edit_project", "run_commands"])
    expect(allowedTools).toEqual(["Read", "Glob", "Grep", "Edit", "Write", "Bash"])
    expect(permissionMode).toBe("dontAsk")
  })

  test("computer_control grants full access", () => {
    expect(mapPermissionsToClaude(["computer_control"]).permissionMode).toBe("bypassPermissions")
  })

  test("read-only agent only gets read tools and never hangs (dontAsk)", () => {
    const { allowedTools, permissionMode } = mapPermissionsToClaude(["read_project"])
    expect(allowedTools).toEqual(["Read", "Glob", "Grep"])
    expect(permissionMode).toBe("dontAsk")
  })
})

describe("buildClaudeInvocation", () => {
  test("isolates account via CLAUDE_CONFIG_DIR and project via cwd", () => {
    const inv = buildClaudeInvocation({
      configDir: "/accounts/claude-1",
      projectDir: "/work/proj",
      prompt: "implement login",
      model: "claude-sonnet-4-5",
      role: "Eres el agente Backend.",
      permissions: ["read_project", "edit_project"],
      maxTurns: 12,
    })
    expect(inv.command).toBe("claude")
    expect(inv.cwd).toBe("/work/proj")
    expect(inv.env.CLAUDE_CONFIG_DIR).toBe("/accounts/claude-1")
    // headless stream-json is on, with the role/model/turns threaded through.
    expect(inv.args).toContain("-p")
    // The prompt rides stdin (not argv) to dodge the Windows command-line limit.
    expect(inv.stdin).toBe("implement login")
    expect(inv.args).not.toContain("implement login")
    expect(inv.args.join(" ")).toContain("--output-format stream-json --verbose")
    expect(inv.args).toContain("--model")
    expect(inv.args).toContain("claude-sonnet-4-5")
    expect(inv.args).toContain("--append-system-prompt")
    expect(inv.args).toContain("Eres el agente Backend.")
    expect(inv.args).toContain("--allowedTools")
    expect(inv.args).toContain("Read,Glob,Grep,Edit,Write")
    expect(inv.args).toContain("--permission-mode")
    expect(inv.args).toContain("dontAsk")
    expect(inv.args).toContain("--max-turns")
    expect(inv.args).toContain("12")
    // Never bare / never an API key: the subscription login in configDir is used.
    expect(inv.args).not.toContain("--bare")
    expect(inv.env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  test("resumes a session and adds extra dirs when asked", () => {
    const inv = buildClaudeInvocation({
      configDir: "/c",
      projectDir: "/p",
      prompt: "continue",
      resumeSessionId: "sess-123",
      addDirs: ["/shared"],
    })
    expect(inv.args).toContain("--resume")
    expect(inv.args).toContain("sess-123")
    expect(inv.args).toContain("--add-dir")
    expect(inv.args).toContain("/shared")
  })

  test("conversational turns disable the agentic tools so the reply is text", () => {
    const inv = buildClaudeInvocation({
      configDir: "/c",
      projectDir: "/p",
      prompt: "preséntate al equipo",
      conversational: true,
    })
    // --disallowedTools removes the agentic tools from what the model can call,
    // so an onboarding/role-debate turn can't emit a tool_use and dead-end at
    // error_max_turns; it answers in text instead.
    expect(inv.args).toContain("--disallowedTools")
    const disallowed = inv.args[inv.args.indexOf("--disallowedTools") + 1] ?? ""
    for (const tool of ["Bash", "Read", "Glob", "Grep", "Edit", "Write", "Task", "WebSearch", "ToolSearch", "Skill"])
      expect(disallowed).toContain(tool)
  })

  test("non-conversational turns leave the tools available", () => {
    const inv = buildClaudeInvocation({ configDir: "/c", projectDir: "/p", prompt: "do work" })
    expect(inv.args).not.toContain("--disallowedTools")
  })
})

describe("parseClaudeStreamEvent", () => {
  test("captures the init session id", () => {
    expect(parseClaudeStreamEvent({ type: "system", subtype: "init", session_id: "s1", model: "m" })).toEqual([
      { type: "init", sessionId: "s1", model: "m" },
    ])
  })

  test("splits an assistant message into text and tool events", () => {
    const events = parseClaudeStreamEvent({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Voy a leer el archivo." },
          { type: "tool_use", name: "Read", input: { file_path: "a.ts" } },
        ],
      },
    })
    expect(events).toEqual([
      { type: "text", text: "Voy a leer el archivo." },
      { type: "tool", name: "Read", input: { file_path: "a.ts" } },
    ])
  })

  test("normalizes the final result", () => {
    const events = parseClaudeStreamEvent({
      type: "result",
      subtype: "success",
      result: "Listo",
      session_id: "s1",
      total_cost_usd: 0.012,
      num_turns: 3,
      is_error: false,
    })
    expect(events).toEqual([
      { type: "result", sessionId: "s1", text: "Listo", costUsd: 0.012, turns: 3, isError: false },
    ])
  })

  test("surfaces api retries", () => {
    expect(parseClaudeStreamEvent({ type: "system", subtype: "api_retry", attempt: 2, error: "overloaded" })).toEqual([
      { type: "retry", attempt: 2, error: "overloaded" },
    ])
  })
})

describe("parseClaudeStreamLine", () => {
  test("ignores blank and non-JSON lines", () => {
    expect(parseClaudeStreamLine("")).toEqual([])
    expect(parseClaudeStreamLine("   ")).toEqual([])
    expect(parseClaudeStreamLine("not json")).toEqual([])
  })

  test("parses a result line", () => {
    const line = JSON.stringify({ type: "result", result: "ok", session_id: "s", is_error: false })
    expect(parseClaudeStreamLine(line)).toEqual([
      { type: "result", sessionId: "s", text: "ok", costUsd: undefined, turns: undefined, isError: false },
    ])
  })
})
