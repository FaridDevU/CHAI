// Domain model for the CHAI multi-agent orchestrator.
// Pure types — no opencode/SDK dependency so the engine stays portable and testable.

export type Role =
  | "Coordinador"
  | "Arquitecto"
  | "Frontend / UI"
  | "Backend"
  | "Full-stack"
  | "Ejecutor / Tester visual"
  | "Tester"
  | "Reviewer"
  | "Documentación / Contexto"
  | "auto"

export type Permission =
  | "read_project"
  | "edit_project"
  | "run_commands"
  | "browser_testing"
  | "screenshots"
  | "computer_control"

export type AgentStatus = "ready" | "working" | "pending" | "error" | "offline"

/** Special conversation participants besides concrete agent ids. */
export const COORDINATOR = "coordinator"
/** The human, talking to the team through CHAI. */
export const USER = "user"

/** An agent id, or one of the special participants above. */
export type ParticipantId = string

export interface OrchestratorAgent {
  id: string
  provider: string
  /** Stable CHAI account id. Multiple agents may share an account, but not concurrently. */
  accountId: string
  account: string
  role: Role
  permissions: Permission[]
  /** Isolated runtime used to launch this account without touching global CLI auth. */
  runtime?: AccountRuntime
  /** Session this agent runs in, once the app has opened one for it. */
  sessionId?: string
  status: AgentStatus
}

export type RuntimeIsolation = "profile" | "home" | "os-user" | "wsl" | "container" | "unsupported"

export interface AccountRuntime {
  accountId: string
  provider: string
  /** Root folder for this account's isolated home/config/auth files. */
  profilePath: string
  /** Fake HOME/USERPROFILE for providers that keep extra state outside config dirs. */
  homePath?: string
  /** Provider-specific config directory, when supported by the CLI. */
  configPath?: string
  /** Working temp directory for this account. */
  tempPath?: string
  env: Record<string, string>
  isolation: RuntimeIsolation
  /** True when CHAI can safely run this account without the provider's global session. */
  isolated: boolean
  reason?: string
}

export type MessageType = "info" | "pregunta" | "respuesta" | "feedback" | "error" | "entrega" | "revisión"

export interface Message {
  id: string
  from: ParticipantId
  to: ParticipantId
  type: MessageType
  text: string
  /** Optional structured payload (task ref, file list, etc.). */
  data?: Record<string, unknown>
  timestamp: number
}

/** A message as produced by a caller, before the router stamps id + timestamp. */
export type MessageInput = Omit<Message, "id" | "timestamp">

export type TaskStatus = "pending" | "assigned" | "in_progress" | "blocked" | "done" | "failed"

export interface Task {
  id: string
  title: string
  description?: string
  assignedTo?: string
  status: TaskStatus
  createdAt: number
  updatedAt: number
}

/**
 * Delivers a routed message to a concrete agent and optionally returns its reply.
 * The app implements this by prompting the agent's session via the SDK; the pure
 * core stays transport-agnostic (and unit-testable with a fake transport).
 */
export interface Transport {
  deliver(agent: OrchestratorAgent, message: Message, runtime: AccountRuntime): Promise<MessageInput | void>
}
