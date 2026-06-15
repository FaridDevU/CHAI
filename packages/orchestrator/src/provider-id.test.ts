import { describe, expect, test } from "bun:test"
import { accountProviderId, parseProviderId, isAccountProviderId } from "./provider-id"

describe("provider-id helpers", () => {
  test("formats and parses an account provider id", () => {
    const id = accountProviderId("anthropic", "claude-2")
    expect(id).toBe("anthropic#claude-2")
    expect(isAccountProviderId(id)).toBe(true)
    expect(parseProviderId(id)).toEqual({ base: "anthropic", accountKey: "claude-2" })
  })

  test("treats a plain provider id as a base with no account", () => {
    expect(isAccountProviderId("anthropic")).toBe(false)
    expect(parseProviderId("anthropic")).toEqual({ base: "anthropic" })
  })

  test("keeps hyphenated base providers and account ids intact", () => {
    const id = accountProviderId("google-vertex", "claude-mh1abc-2")
    expect(id).toBe("google-vertex#claude-mh1abc-2")
    expect(parseProviderId(id)).toEqual({ base: "google-vertex", accountKey: "claude-mh1abc-2" })
  })
})
