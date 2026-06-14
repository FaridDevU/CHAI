import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Option, Record, Schema, Context } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface Interface {
  /** The active credential for a provider (the first when several are stored). */
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  /** One active credential per provider — back-compat shape for existing consumers. */
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  /** Every stored credential for a provider (supports multiple accounts). */
  readonly list: (providerID: string) => Effect.Effect<Info[], AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const decode = Schema.decodeUnknownOption(Info)

    // Raw on-disk shape: a provider key maps to a single credential (legacy) OR an
    // array of credentials (multiple accounts). Writers operate on this so extra
    // accounts are never dropped; readers below normalize for back-compat.
    const readRaw = Effect.fn("Auth.readRaw")(function* () {
      let data: Record<string, unknown> = {}
      if (process.env.OPENCODE_AUTH_CONTENT) {
        try {
          data = JSON.parse(process.env.OPENCODE_AUTH_CONTENT)
        } catch (err) {}
      } else {
        data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      }

      const out: Record<string, Info | Info[]> = {}
      for (const [key, value] of Object.entries(data)) {
        if (Array.isArray(value)) {
          const infos: Info[] = []
          for (const item of value) {
            const decoded = decode(item)
            if (Option.isSome(decoded)) infos.push(decoded.value)
          }
          if (infos.length > 0) out[key] = infos
        } else {
          const decoded = decode(value)
          if (Option.isSome(decoded)) out[key] = decoded.value
        }
      }
      return out
    })

    // The active credential is the first one when several are stored.
    const activeOf = (value: Info | Info[]): Info => (Array.isArray(value) ? value[0]! : value)

    const all = Effect.fn("Auth.all")(function* () {
      return Record.map(yield* readRaw(), activeOf)
    })

    const list = Effect.fn("Auth.list")(function* (providerID: string) {
      const value = (yield* readRaw())[providerID]
      if (!value) return []
      return Array.isArray(value) ? value : [value]
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      const value = (yield* readRaw())[providerID]
      return value ? activeOf(value) : undefined
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* readRaw()
      if (norm !== key) delete data[key]
      delete data[norm + "/"]
      yield* fsys
        .writeJson(file, { ...data, [norm]: info }, 0o600)
        .pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* readRaw()
      delete data[key]
      delete data[norm]
      yield* fsys.writeJson(file, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    return Service.of({ get, all, list, set, remove })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer))

export const node = LayerNode.make(layer, [FSUtil.node])

export * as Auth from "."
