import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Option, Record, Schema, Context } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

// `accountKey` is a stable, caller-supplied identifier for a credential when a
// provider holds several accounts (e.g. CHAI's account id). Optional, so legacy
// single-account credentials are unaffected.
export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  accountKey: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  accountKey: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
  accountKey: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
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
  /** The credential matching an accountKey for a provider, if any. */
  readonly getByKey: (providerID: string, accountKey: string) => Effect.Effect<Info | undefined, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  /** Adds/updates one account's credential for a provider WITHOUT dropping the
   *  others (matched by accountKey). The first stored credential is the active one. */
  readonly add: (providerID: string, info: Info) => Effect.Effect<void, AuthError>
  /** Makes the credential with the given accountKey active (moves it to the front). */
  readonly setActive: (providerID: string, accountKey: string) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

/** Stable identifier for a credential within a provider, when present. */
export function keyOf(info: Info): string | undefined {
  if (info.accountKey) return info.accountKey
  if (info.type === "oauth") return info.accountId
  return undefined
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

    const getByKey = Effect.fn("Auth.getByKey")(function* (providerID: string, accountKey: string) {
      const value = (yield* readRaw())[providerID]
      if (!value) return undefined
      const items = Array.isArray(value) ? value : [value]
      return items.find((info) => keyOf(info) === accountKey)
    })

    // Persist an array as a single value when only one remains, for tidy on-disk shape.
    const writeProvider = (data: Record<string, Info | Info[]>, providerID: string, items: Info[]) =>
      fsys
        .writeJson(file, { ...data, [providerID]: items.length === 1 ? items[0]! : items }, 0o600)
        .pipe(Effect.mapError(fail("Failed to write auth data")))

    const add = Effect.fn("Auth.add")(function* (providerID: string, info: Info) {
      const data = yield* readRaw()
      const existing = data[providerID]
      const items = existing ? (Array.isArray(existing) ? [...existing] : [existing]) : []
      const incomingKey = keyOf(info)
      const at = incomingKey ? items.findIndex((i) => keyOf(i) === incomingKey) : -1
      if (at >= 0) items[at] = info
      else items.push(info)
      yield* writeProvider(data, providerID, items)
    })

    const setActive = Effect.fn("Auth.setActive")(function* (providerID: string, accountKey: string) {
      const data = yield* readRaw()
      const existing = data[providerID]
      if (!existing) return
      const items = Array.isArray(existing) ? [...existing] : [existing]
      const at = items.findIndex((i) => keyOf(i) === accountKey)
      if (at <= 0) return
      const [chosen] = items.splice(at, 1)
      items.unshift(chosen!)
      yield* writeProvider(data, providerID, items)
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

    return Service.of({ get, all, list, getByKey, set, add, setActive, remove })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer))

export const node = LayerNode.make(layer, [FSUtil.node])

export * as Auth from "."
