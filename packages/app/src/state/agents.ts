// CHAI agent/account model + local persistence.
// This is the front-end source of truth for the user's connected AI accounts and
// per-project team configuration. Real OAuth connection and the .chai/team.json
// file write are wired later; for the MVP we persist to localStorage.
import { createStore } from "solid-js/store"

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

export const ROLES = [
  "Coordinador",
  "Arquitecto",
  "Frontend / UI",
  "Backend",
  "Full-stack",
  "Ejecutor / Tester visual",
  "Tester",
  "Reviewer",
  "Documentación / Contexto",
] as const

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
  role: string
  permissions: string[]
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
  } catch {}
  return { accounts: [] }
}

const [accountStore, setAccountStore] = createStore<{ accounts: Account[] }>(loadAccounts())

function persistAccounts() {
  try {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accountStore))
  } catch {}
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

export const Teams = {
  save: (cfg: TeamConfig) => {
    try {
      const all = JSON.parse(localStorage.getItem(TEAMS_KEY) || "{}")
      all[cfg.directory] = cfg
      localStorage.setItem(TEAMS_KEY, JSON.stringify(all))
    } catch {}
  },
  get: (directory: string): TeamConfig | undefined => {
    try {
      const all = JSON.parse(localStorage.getItem(TEAMS_KEY) || "{}")
      return all[directory]
    } catch {
      return undefined
    }
  },
}
