import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Credential } from "@opencode-ai/core/credential"
import { Database } from "@opencode-ai/core/database/database"
import { Integration } from "@opencode-ai/core/integration"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

function layer(directory: string) {
  return Credential.layer.pipe(
    Layer.provide(Database.layerFromPath(path.join(directory, "credential.db")).pipe(Layer.fresh)),
  )
}

describe("Credential", () => {
  it.live("stores, updates, lists, and removes credentials", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const integrationID = Integration.ID.make("openai")
          const created = yield* credentials.create({
            integrationID,
            label: "Work",
            value: new Credential.Key({ type: "key", key: "secret" }),
          })

          expect(yield* credentials.list(integrationID)).toEqual([created])
          yield* credentials.update(created.id, { label: "Personal" })
          expect((yield* credentials.list(integrationID))[0]?.label).toBe("Personal")

          const replacement = yield* credentials.create({
            integrationID,
            label: "Replacement",
            value: new Credential.Key({ type: "key", key: "replacement" }),
          })
          expect(yield* credentials.list(integrationID)).toEqual([replacement])

          yield* credentials.remove(replacement.id)
          expect(yield* credentials.list(integrationID)).toEqual([])
        }).pipe(Effect.provide(layer(tmp.path))),
      ),
    ),
  )

  it.live("supports multiple accounts per integration with active selection", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const integrationID = Integration.ID.make("anthropic")

          const first = yield* credentials.add({
            integrationID,
            label: "Claude 1",
            value: new Credential.Key({ type: "key", key: "k1" }),
          })
          const second = yield* credentials.add({
            integrationID,
            label: "Claude 2",
            value: new Credential.Key({ type: "key", key: "k2" }),
          })

          // add() keeps both, and the first added is active by default.
          expect(yield* credentials.list(integrationID)).toHaveLength(2)
          expect(first.active).toBe(true)
          expect(second.active).toBe(false)
          expect((yield* credentials.getActive(integrationID))?.id).toBe(first.id)

          // setActive moves the active flag to the second and deactivates the first.
          yield* credentials.setActive(second.id)
          const after = yield* credentials.list(integrationID)
          expect(after.find((c) => c.id === second.id)?.active).toBe(true)
          expect(after.find((c) => c.id === first.id)?.active).toBe(false)
          expect((yield* credentials.getActive(integrationID))?.id).toBe(second.id)
        }).pipe(Effect.provide(layer(tmp.path))),
      ),
    ),
  )
})
