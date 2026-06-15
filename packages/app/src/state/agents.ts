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

function readTeams(): Record<string, TeamConfig> {
  try {
    return JSON.parse(localStorage.getItem(TEAMS_KEY) || "{}")
  } catch (err) {
    console.warn("[chai] could not read saved teams", err)
    return {}
  }
}

export const Teams = {
  /** Persist a team config. Returns false if storage failed (caller should warn). */
  save: (cfg: TeamConfig): boolean => {
    try {
      const all = readTeams()
      all[cfg.directory] = cfg
      localStorage.setItem(TEAMS_KEY, JSON.stringify(all))
      return true
    } catch (err) {
      console.error("[chai] could not persist team", err)
      return false
    }
  },
  get: (directory: string): TeamConfig | undefined => readTeams()[directory],
  list: (): TeamConfig[] => Object.values(readTeams()),
}
