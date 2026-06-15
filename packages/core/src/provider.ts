export * as ProviderV2 from "./provider"

import { withStatics } from "./schema"
import { Schema } from "effect"
import { Credential } from "./credential"

export const ID = Schema.String.pipe(
  Schema.brand("ProviderV2.ID"),
  withStatics((schema) => ({
    // Well-known providers
    opencode: schema.make("opencode"),
    anthropic: schema.make("anthropic"),
    openai: schema.make("openai"),
    google: schema.make("google"),
    googleVertex: schema.make("google-vertex"),
    githubCopilot: schema.make("github-copilot"),
    amazonBedrock: schema.make("amazon-bedrock"),
    azure: schema.make("azure"),
    openrouter: schema.make("openrouter"),
    mistral: schema.make("mistral"),
    gitlab: schema.make("gitlab"),
  })),
)
export type ID = typeof ID.Type

// CHAI: an "account provider" is a base provider scoped to one connected
// account, encoded as `${base}#${accountKey}` (e.g. "anthropic#claude-2"). It
// lets several subscription accounts of the same provider run in parallel:
// each becomes its own provider id with its own credential, reusing opencode's
// existing per-provider resolution, caching and routing. `#` never appears in a
// base provider id, so it is a safe, unambiguous separator.
export const ACCOUNT_SEPARATOR = "#"

/** Build the provider id for a base provider scoped to one account. */
export function accountProviderID(base: ID, accountKey: string): ID {
  return ID.make(`${base}${ACCOUNT_SEPARATOR}${accountKey}`)
}

/** Split a provider id into its base provider and optional account key. */
export function parseProviderID(id: ID): { base: ID; accountKey?: string } {
  const at = id.indexOf(ACCOUNT_SEPARATOR)
  if (at === -1) return { base: id }
  return { base: ID.make(id.slice(0, at)), accountKey: id.slice(at + 1) || undefined }
}

/** The underlying base provider id (drops any account scope). */
export function baseProviderID(id: ID): ID {
  return parseProviderID(id).base
}

/** True when the provider id is scoped to a specific account. */
export function isAccountProviderID(id: ID): boolean {
  return id.includes(ACCOUNT_SEPARATOR)
}

export const AISDK = Schema.Struct({
  type: Schema.Literal("aisdk"),
  package: Schema.String,
  url: Schema.String.pipe(Schema.optional),
  settings: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
})

export const Native = Schema.Struct({
  type: Schema.Literal("native"),
  url: Schema.String.pipe(Schema.optional),
  settings: Schema.Record(Schema.String, Schema.Unknown),
})

export const Api = Schema.Union([AISDK, Native]).pipe(Schema.toTaggedUnion("type"))
export type Api = typeof Api.Type

export const Request = Schema.Struct({
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.Record(Schema.String, Schema.Any),
})
export type Request = typeof Request.Type

export class Info extends Schema.Class<Info>("ProviderV2.Info")({
  id: ID,
  name: Schema.String,
  enabled: Schema.Union([
    Schema.Literal(false),
    Schema.Struct({
      via: Schema.Literal("env"),
      name: Schema.String,
    }),
    Schema.Struct({
      via: Schema.Literal("credential"),
      credentialID: Credential.ID,
    }),
    Schema.Struct({
      via: Schema.Literal("custom"),
      data: Schema.Record(Schema.String, Schema.Any),
    }),
  ]),
  env: Schema.String.pipe(Schema.Array),
  api: Api,
  request: Request,
}) {
  static empty(providerID: ID): Info {
    return new Info({
      id: providerID,
      name: providerID,
      enabled: false,
      env: [],
      api: {
        type: "native",
        settings: {},
      },
      request: {
        headers: {},
        body: {},
      },
    })
  }
}
