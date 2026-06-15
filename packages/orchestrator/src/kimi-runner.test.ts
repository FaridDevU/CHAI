import { describe, expect, test } from "bun:test"
import { buildKimiInvocation, parseKimiStreamEvent, parseKimiStreamLine } from "./kimi-runner"

describe("buildKimiInvocation", () => {
  test("isolates account via KIMI_CODE_HOME and project via cwd, folds role into prompt", () => {
    const inv = buildKimiInvocation({
      cli: "kimi",
      configDir: "/accounts/kimi-1",
      projectDir: "/work/proj",
      prompt: "implement login",
      model: "kimi-k2.6",
      role: "Eres el agente Backend.",
      permissions: ["read_project", "edit_project"],
    })
    expect(inv.command).toBe("kimi")
    expect(inv.cwd).toBe("/work/proj")
    expect(inv.env.KIMI_CODE_HOME).toBe("/accounts/kimi-1")
    // headless stream-json on; model threaded; role prepended (no system-prompt flag).
    expect(inv.args).toContain("-p")
    expect(inv.args.join(" ")).toContain("--output-format stream-json")
    expect(inv.args).toContain("--model")
    expect(inv.args).toContain("kimi-k2.6")
    const prompt = inv.args[inv.args.indexOf("-p") + 1]
    expect(prompt).toContain("Eres el agente Backend.")
    expect(prompt).toContain("implement login")
    // non-dangerous agent -> auto-approve mode (never hangs headless).
    expect(inv.args).toContain("--auto")
    expect(inv.args).not.toContain("--yolo")
  })

  test("computer_control grants full auto-approve (--yolo) and resume passes a session", () => {
    const inv = buildKimiInvocation({
      cli: "kimi",
      configDir: "/c",
      projectDir: "/p",
      prompt: "continue",
      permissions: ["computer_control"],
      resumeSessionId: "sess-123",
    })
    expect(inv.args).toContain("--yolo")
    expect(inv.args).not.toContain("--auto")
    expect(inv.args).toContain("--session")
    expect(inv.args).toContain("sess-123")
  })
})

describe("parseKimiStreamEvent", () => {
  test("splits an OpenAI-style assistant message into text and tool events", () => {
    const events = parseKimiStreamEvent({
      role: "assistant",
      content: "Voy a leer el archivo.",
      tool_calls: [{ type: "function", id: "tc_1", function: { name: "Read", arguments: '{"file_path":"a.ts"}' } }],
    })
    expect(events).toEqual([
      { type: "text", text: "Voy a leer el archivo." },
      { type: "tool", name: "Read", input: { file_path: "a.ts" } },
    ])
  })

  test("reads array content parts", () => {
    expect(parseKimiStreamEvent({ role: "assistant", content: [{ type: "text", text: "hola" }] })).toEqual([
      { type: "text", text: "hola" },
    ])
  })

  test("ignores user/tool/system echo lines", () => {
    expect(parseKimiStreamEvent({ role: "user", content: "x" })).toEqual([])
    expect(parseKimiStreamEvent({ role: "tool", tool_call_id: "tc_1", content: "ok" })).toEqual([])
  })

  test("normalizes a wrapping result envelope when present", () => {
    expect(
      parseKimiStreamEvent({ type: "result", result: "Listo", session_id: "s1", is_error: false }),
    ).toEqual([{ type: "result", sessionId: "s1", text: "Listo", costUsd: undefined, turns: undefined, isError: false }])
  })
})

describe("parseKimiStreamLine", () => {
  test("ignores blank and non-JSON lines", () => {
    expect(parseKimiStreamLine("")).toEqual([])
    expect(parseKimiStreamLine("not json")).toEqual([])
  })

  test("parses an assistant line", () => {
    const line = JSON.stringify({ role: "assistant", content: "ok" })
    expect(parseKimiStreamLine(line)).toEqual([{ type: "text", text: "ok" }])
  })
})
