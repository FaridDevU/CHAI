import { describe, expect, test } from "bun:test"
import { parseCliModels } from "./account-diagnostics"

describe("parseCliModels", () => {
  test("reads model ids from json arrays and objects", () => {
    expect(parseCliModels(JSON.stringify({ models: [{ id: "gpt-5-codex" }, { name: "kimi-k2" }] }))).toEqual([
      "gpt-5-codex",
      "kimi-k2",
    ])
  })

  test("reads model ids from table-like text", () => {
    const text = `
Available models
gpt-5-codex        default
claude-sonnet-4-5  available
- kimi-k2
`
    expect(parseCliModels(text)).toEqual(["claude-sonnet-4-5", "gpt-5-codex", "kimi-k2"])
  })

  test("returns empty for unrelated help text", () => {
    expect(parseCliModels("Usage: tool [options]\n--help Show help")).toEqual([])
  })
})

