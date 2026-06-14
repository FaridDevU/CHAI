import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Auth } from "../../src/auth"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(Auth.defaultLayer, node))

describe("Auth", () => {
  it.instance("set normalizes trailing slashes in keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeDefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set cleans up pre-existing trailing-slash entry", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "old",
      })
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "new",
      })
      const data = yield* auth.all()
      const keys = Object.keys(data).filter((key) => key.includes("example.com"))
      expect(keys).toEqual(["https://example.com"])
      const entry = data["https://example.com"]!
      expect(entry.type).toBe("wellknown")
      if (entry.type === "wellknown") expect(entry.token).toBe("new")
    }),
  )

  it.instance("remove deletes both trailing-slash and normalized keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      yield* auth.remove("https://example.com/")
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeUndefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set and remove are no-ops on keys without trailing slashes", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("anthropic", {
        type: "api",
        key: "sk-test",
      })
      const data = yield* auth.all()
      expect(data["anthropic"]).toBeDefined()
      yield* auth.remove("anthropic")
      const after = yield* auth.all()
      expect(after["anthropic"]).toBeUndefined()
    }),
  )

  it.instance("add stores multiple accounts per provider and keeps the first active", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.add("anthropic", { type: "api", key: "k1", accountKey: "claude-1", label: "Claude 1" })
      yield* auth.add("anthropic", { type: "api", key: "k2", accountKey: "claude-2", label: "Claude 2" })

      expect(yield* auth.list("anthropic")).toHaveLength(2)
      // all() stays back-compat: one active (first) credential per provider.
      const active = (yield* auth.all())["anthropic"]
      expect(active?.type === "api" && active.key).toBe("k1")
      const byKey = yield* auth.getByKey("anthropic", "claude-2")
      expect(byKey?.type === "api" && byKey.key).toBe("k2")
    }),
  )

  it.instance("add replaces the matching account and setActive promotes one", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.add("anthropic", { type: "api", key: "k1", accountKey: "claude-1" })
      yield* auth.add("anthropic", { type: "api", key: "k2", accountKey: "claude-2" })
      // re-adding the same accountKey updates in place, not appends.
      yield* auth.add("anthropic", { type: "api", key: "k1b", accountKey: "claude-1" })
      expect(yield* auth.list("anthropic")).toHaveLength(2)

      yield* auth.setActive("anthropic", "claude-2")
      const active = (yield* auth.all())["anthropic"]
      expect(active?.type === "api" && active.key).toBe("k2")
    }),
  )
})
