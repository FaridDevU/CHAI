import { describe, expect, test } from "bun:test"
import { ProviderV2 } from "@opencode-ai/core/provider"

describe("ProviderV2 account providers", () => {
  test("formats and parses an account provider id", () => {
    const id = ProviderV2.accountProviderID(ProviderV2.ID.anthropic, "claude-2")
    expect(String(id)).toBe("anthropic#claude-2")
    expect(ProviderV2.isAccountProviderID(id)).toBe(true)
    const parsed = ProviderV2.parseProviderID(id)
    expect(String(parsed.base)).toBe("anthropic")
    expect(parsed.accountKey).toBe("claude-2")
    expect(String(ProviderV2.baseProviderID(id))).toBe("anthropic")
  })

  test("treats a plain provider id as a base with no account", () => {
    const id = ProviderV2.ID.anthropic
    expect(ProviderV2.isAccountProviderID(id)).toBe(false)
    const parsed = ProviderV2.parseProviderID(id)
    expect(String(parsed.base)).toBe("anthropic")
    expect(parsed.accountKey).toBeUndefined()
    expect(String(ProviderV2.baseProviderID(id))).toBe("anthropic")
  })

  test("keeps hyphenated base providers intact", () => {
    const id = ProviderV2.accountProviderID(ProviderV2.ID.googleVertex, "work")
    expect(String(id)).toBe("google-vertex#work")
    const parsed = ProviderV2.parseProviderID(id)
    expect(String(parsed.base)).toBe("google-vertex")
    expect(parsed.accountKey).toBe("work")
  })

  test("preserves a generated account id with hyphens", () => {
    const id = ProviderV2.accountProviderID(ProviderV2.ID.anthropic, "claude-mh1abc-2")
    expect(ProviderV2.parseProviderID(id).accountKey).toBe("claude-mh1abc-2")
  })
})
