// CHAI agent/account model + local persistence.
// This is the front-end source of truth for the user's connected AI accounts and
// per-project team configuration. Real OAuth connection and the .chai/team.json
// file write are wired later; for the MVP we persist to localStorage.
import { createStore } from "solid-js/store"
import type { AccountRuntime, Role } from "@chai/orchestrator"

export type AccountStatus = "ready" | "pending" | "unconfigured"

export type Account = {
  id: string
  provider: string
  label: string
  status: AccountStatus
}

export const PROVIDERS = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "kimi", label: "Kimi" },
  { id: "local", label: "Modelo local" },
] as const

export function providerLabel(id: string) {
  return PROVIDERS.find((p) => p.id === id)?.label ?? id
}

// Providers that connect + run as their own real CLI (the sanctioned
// subscription path) instead of an opencode provider/OAuth: Claude (`claude`)
// and Kimi (`kimi`). Their readiness is the account status the user confirms
// after the CLI login, and their agent runs go through the desktop CLI runner.
export const CLI_PROVIDERS = ["claude", "kimi"] as const
export function isCliProvider(provider: string): provider is (typeof CLI_PROVIDERS)[number] {
  return (CLI_PROVIDERS as readonly string[]).includes(provider)
}

// Maps CHAI's provider buckets to the underlying opencode provider id used by the
// real connect flow. Empty = no direct opencode mapping yet.
export const OPENCODE_PROVIDER: Record<string, string> = {
  claude: "anthropic",
  codex: "openai",
  kimi: "moonshotai",
  local: "",
}

// Selectable roles. `id` is the stable logical key shared with the orchestrator
// (never translated); `label` is the display string (translate this, not the id).
export const ROLES: { id: Role; label: string }[] = [
  { id: "coordinator", label: "Coordinador" },
  { id: "architect", label: "Arquitecto" },
  { id: "frontend", label: "Frontend / UI" },
  { id: "backend", label: "Backend" },
  { id: "fullstack", label: "Full-stack" },
  { id: "executor", label: "Ejecutor / Tester visual" },
  { id: "tester", label: "Tester" },
  { id: "reviewer", label: "Reviewer" },
  { id: "docs", label: "Documentación / Contexto" },
]

export function roleLabel(id: string) {
  if (id === "auto") return "Rol automático"
  return ROLES.find((r) => r.id === id)?.label ?? id
}

// The session title CHAI gives each agent when the team starts. Used both to
// create the sessions and to match them back to agents, so it must stay a
// single shared definition. "Agente" is kept for auto so older titles match.
export function agentSessionTitle(agent: { role: Role; account: string }) {
  const role = agent.role === "auto" ? "Agente" : roleLabel(agent.role)
  return `${role} · ${agent.account}`
}

export const PERMISSIONS = [
  { id: "read_project", label: "Leer proyecto" },
  { id: "edit_project", label: "Editar proyecto" },
  { id: "run_commands", label: "Ejecutar comandos" },
  { id: "browser_testing", label: "Probar en navegador" },
  { id: "screenshots", label: "Capturas de pantalla" },
  { id: "computer_control", label: "Control del PC" },
] as const

export type TeamAgent = {
  accountId: string
  provider: string
  account: string
  role: Role
  permissions: string[]
  runtime?: AccountRuntime
}

export type RoleMode = "manual" | "auto" | "hybrid"

export type TeamConfig = {
  projectName: string
  directory: string
  stack: string
  agents: TeamAgent[]
  roleMode: RoleMode
  visualTesting: boolean
  computerControl: "off" | "approval_required" | "allowed"
}

const ACCOUNTS_KEY = "chai.accounts.v1"
const TEAMS_KEY = "chai.teams.v1"

function loadAccounts(): { accounts: Account[] } {
  try {
    const v = localStorage.getItem(ACCOUNTS_KEY)
    if (v) return JSON.parse(v)
  } catch (err) {
    console.warn("[chai] could not read saved accounts; starting empty", err)
  }
  return { accounts: [] }
}

const [accountStore, setAccountStore] = createStore<{ accounts: Account[] }>(loadAccounts())

function persistAccounts(): boolean {
  try {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accountStore))
    return true
  } catch (err) {
    console.error("[chai] could not persist accounts", err)
    return false
  }
}

export const Accounts = {
  list: () => accountStore.accounts,
  byId: (id: string) => accountStore.accounts.find((a) => a.id === id),
  add: (provider: string, label: string): string => {
    const id = `${provider}-${Date.now().toString(36)}`
    setAccountStore("accounts", (a) => [...a, { id, provider, label, status: "unconfigured" as AccountStatus }])
    persistAccounts()
    return id
  },
  remove: (id: string) => {
    setAccountStore("accounts", (a) => a.filter((x) => x.id !== id))
    persistAccounts()
  },
  setStatus: (id: string, status: AccountStatus) => {
    setAccountStore("accounts", (a) => a.id === id, "status", status)
    persistAccounts()
  },
}

/** The authoritative on-disk team config, relative to the project directory. */
export const TEAM_FILE = ".chai/team.json"

type TeamsMap = Record<string, TeamConfig>

function loadTeams(): TeamsMap {
  try {
    return JSON.parse(localStorage.getItem(TEAMS_KEY) || "{}")
  } catch (err) {
    console.warn("[chai] could not read cached teams", err)
    return {}
  }
}

// Reactive cache of teams by directory, seeded from localStorage. The real
// source of truth is each project's .chai/team.json; this cache is refreshed
// from that file via hydrate() so the UI updates even on a fresh machine.
const [teamStore, setTeamStore] = createStore<TeamsMap>(loadTeams())
const hydrated = new Set<string>()

function persistTeams(): boolean {
  try {
    localStorage.setItem(TEAMS_KEY, JSON.stringify(teamStore))
    return true
  } catch (err) {
    console.error("[chai] could not persist team cache", err)
    return false
  }
}

export const Teams = {
  /** Update the cache for a team. Returns false if the cache write failed.
   *  The on-disk .chai/team.json (written at "Iniciar equipo") stays the source
   *  of truth; this only keeps the fast reactive cache in sync. */
  save: (cfg: TeamConfig): boolean => {
    setTeamStore(cfg.directory, cfg)
    return persistTeams()
  },
  get: (directory: string): TeamConfig | undefined => teamStore[directory],
  list: (): TeamConfig[] => Object.values(teamStore),
  /** Refresh the cache for a directory from its .chai/team.json (file wins).
   *  Runs at most once per directory; pass platform.readProjectFile as `read`. */
  hydrate: async (
    directory: string,
    read: (directory: string, relativePath: string) => Promise<string | null>,
  ): Promise<TeamConfig | undefined> => {
    if (!directory || hydrated.has(directory)) return teamStore[directory]
    hydrated.add(directory)
    try {
      const raw = await read(directory, TEAM_FILE)
      if (raw) {
        const cfg = JSON.parse(raw) as TeamConfig
        setTeamStore(directory, cfg)
        persistTeams()
        return cfg
      }
    } catch (err) {
      console.warn("[chai] could not read .chai/team.json; using cached team", err)
    }
    return teamStore[directory]
  },
}
