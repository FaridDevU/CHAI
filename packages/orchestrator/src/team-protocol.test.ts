import { describe, expect, test } from "bun:test"
import {
  coordinatorPlanInstructions,
  extractJsonBlock,
  parseCoordinatorPlan,
  parseTeamEnvelope,
  teamProtocolInstructions,
} from "./team-protocol"

describe("extractJsonBlock", () => {
  test("pulls JSON out of a ```json fence", () => {
    const text = "Aqui esta:\n```json\n{ \"a\": 1 }\n```\nlisto"
    expect(extractJsonBlock(text)).toBe('{ "a": 1 }')
  })

  test("pulls the first balanced object from inline prose", () => {
    const text = 'antes { "a": { "b": 2 } } despues { "c": 3 }'
    expect(extractJsonBlock(text)).toBe('{ "a": { "b": 2 } }')
  })

  test("ignores braces inside strings", () => {
    const text = '{ "a": "no { cierra }", "b": 1 }'
    expect(extractJsonBlock(text)).toBe('{ "a": "no { cierra }", "b": 1 }')
  })

  test("returns undefined when there is no object", () => {
    expect(extractJsonBlock("solo texto")).toBeUndefined()
  })
})

describe("parseCoordinatorPlan", () => {
  test("parses a plan and normalizes priority/roles", () => {
    const plan = parseCoordinatorPlan(
      `\`\`\`json
      {
        "summary": "plan inicial",
        "tasks": [
          { "title": "UI", "assigneeRole": "frontend", "priority": "high" },
          { "title": "API", "role": "backend" }
        ],
        "nextAgent": "claude-1",
        "done": false
      }
      \`\`\``,
    )
    expect(plan?.summary).toBe("plan inicial")
    expect(plan?.tasks).toHaveLength(2)
    expect(plan?.tasks[0]).toMatchObject({ title: "UI", assigneeRole: "frontend", priority: "high" })
    // missing priority defaults to medium; legacy "role" key maps to assigneeRole
    expect(plan?.tasks[1]).toMatchObject({ title: "API", assigneeRole: "backend", priority: "medium" })
    expect(plan?.nextAgent).toBe("claude-1")
    expect(plan?.done).toBe(false)
  })

  test("drops tasks without a title and invalid roles", () => {
    const plan = parseCoordinatorPlan('{ "tasks": [ { "priority": "high" }, { "title": "ok", "assigneeRole": "wizard" } ] }')
    expect(plan?.tasks).toHaveLength(1)
    expect(plan?.tasks[0]?.title).toBe("ok")
    expect(plan?.tasks[0]?.assigneeRole).toBeUndefined()
  })

  test("returns undefined when there is no JSON", () => {
    expect(parseCoordinatorPlan("no hay plan aqui")).toBeUndefined()
  })
})

describe("parseTeamEnvelope", () => {
  test("falls back to plain text when there is no JSON", () => {
    const env = parseTeamEnvelope("Hice el trabajo y todo bien.")
    expect(env.text).toBe("Hice el trabajo y todo bien.")
    expect(env.actions).toEqual([])
    expect(env.done).toBe(false)
  })

  test("parses known actions and drops unknown/invalid ones", () => {
    const env = parseTeamEnvelope(
      JSON.stringify({
        text: "listo",
        done: true,
        actions: [
          { type: "complete_task", summary: "hecho" },
          { type: "delegate", toRole: "tester", instructions: "probar login" },
          { type: "request_permission", permission: "run_commands", reason: "tests" },
          { type: "request_permission", permission: "nope" }, // invalid -> dropped
          { type: "final_result", summary: "ok", filesTouched: ["a.ts"], tests: ["unit"] },
          { type: "telepathy" }, // unknown -> dropped
        ],
      }),
    )
    expect(env.done).toBe(true)
    expect(env.actions.map((a) => a.type)).toEqual([
      "complete_task",
      "delegate",
      "request_permission",
      "final_result",
    ])
    const delegate = env.actions.find((a) => a.type === "delegate")
    expect(delegate).toMatchObject({ toRole: "tester", instructions: "probar login" })
    const final = env.actions.find((a) => a.type === "final_result")
    expect(final).toMatchObject({ summary: "ok", filesTouched: ["a.ts"], tests: ["unit"] })
  })

  test("drops actions missing required fields", () => {
    const env = parseTeamEnvelope(JSON.stringify({ actions: [{ type: "delegate" }, { type: "report_block" }] }))
    expect(env.actions).toEqual([])
  })
})

describe("prompt instructions", () => {
  test("plan instructions list selectable roles and priorities", () => {
    const text = coordinatorPlanInstructions()
    expect(text).toContain("assigneeRole")
    expect(text).toContain("frontend")
    expect(text).not.toContain("auto,") // "auto" is excluded from the assignable list
    expect(text).toContain("low, medium o high")
  })

  test("protocol instructions document the action types", () => {
    const text = teamProtocolInstructions()
    expect(text).toContain("complete_task")
    expect(text).toContain("final_result")
    expect(text).toContain("request_permission")
  })
})
