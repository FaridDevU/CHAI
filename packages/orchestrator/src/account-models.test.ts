import { describe, expect, test } from "bun:test"
import { parseCodexModelsCache, parseClaudeModelOptions } from "./account-models"

describe("parseCodexModelsCache", () => {
  test("keeps visible models, drops hidden ones, sorts by priority", () => {
    const json = JSON.stringify({
      models: [
        { slug: "gpt-5.4", display_name: "GPT-5.4", visibility: "list", priority: 16 },
        { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", priority: 9 },
        { slug: "codex-auto-review", display_name: "Auto Review", visibility: "hide", priority: 43 },
      ],
    })
    expect(parseCodexModelsCache(json)).toEqual([
      { value: "gpt-5.5", label: "GPT-5.5" },
      { value: "gpt-5.4", label: "GPT-5.4" },
    ])
  })

  test("returns [] on garbage or missing models", () => {
    expect(parseCodexModelsCache("not json")).toEqual([])
    expect(parseCodexModelsCache("{}")).toEqual([])
  })
})

describe("parseClaudeModelOptions", () => {
  test("reads disabled flag and strips the [1m] variant suffix", () => {
    const json = JSON.stringify({
      additionalModelOptionsCache: [
        { value: "claude-fable-5[1m]", label: "Fable (disabled)", disabled: true },
      ],
    })
    expect(parseClaudeModelOptions(json)).toEqual([
      { value: "claude-fable-5", label: "Fable (disabled)", disabled: true },
    ])
  })

  test("returns [] when the cache key is absent", () => {
    expect(parseClaudeModelOptions(JSON.stringify({ other: 1 }))).toEqual([])
    expect(parseClaudeModelOptions("nope")).toEqual([])
  })
})
