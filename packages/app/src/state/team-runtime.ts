import { createSignal, type Accessor } from "solid-js"
import { COORDINATOR, Orchestrator, type Message, type Permission, type Role, type Transport } from "@chai/orchestrator"
import type {
  ClaudeAgentSpec,
  ClaudeRunResult,
  CoordinatorPlan,
  PlannedTask,
  TeamAction,
  TeamEnvelope,
} from "@chai/orchestrator"
import {
  coordinatorPlanInstructions,
  parseCoordinatorPlan,
  parseTeamEnvelope,
  teamProtocolInstructions,
} from "@chai/orchestrator"
import type { ServerSDK } from "@/context/server-sdk"
import type { TeamAgent, TeamConfig } from "@/state/agents"
import { OPENCODE_PROVIDER, ROLES, isCliProvider, roleLabel } from "@/state/agents"
import {
  createClaudeTransport,
  createTeamTransport,
  toOrchestratorAgent,
  waitForAssistantReply,
} from "@/components/team-orchestrator"

export type TeamRuntimePolicy = {
  /** Hard ceiling per agent turn before CHAI cancels and (maybe) retries. */
  turnTimeoutMs: number
  /** How many times a failed/timed-out turn is retried. */
  maxRetries: number
  /** First backoff delay; doubles per attempt up to maxBackoffMs. */
  backoffBaseMs: number
  maxBackoffMs: number
  /** Total agent turns a single team round may spend (loop guard). */
  maxTeamTurns: number
}

export type ProjectTeamRuntimeDeps = {
  serverSDK: ServerSDK
  runClaudeAgent?: (runId: string, spec: ClaudeAgentSpec) => Promise<ClaudeRunResult>
  cancelClaudeAgent?: (runId: string) => Promise<void>
  sessionForAgent: (agent: TeamAgent) => string | undefined
  createSessionForAgent: (agent: TeamAgent) => Promise<string>
  modelForProvider: (providerID: string) => { providerID: string; modelID: string } | undefined
  readProjectFile?: (directory: string, relativePath: string) => Promise<string | null>
  writeProjectFile?: (directory: string, relativePath: string, content: string) => Promise<string>
  /** Optional incremental append; when absent the jsonl log is rewritten whole. */
  appendProjectFile?: (directory: string, relativePath: string, content: string) => Promise<string>
  onTeamUpdated?: (team: TeamConfig) => void
  policy?: Partial<TeamRuntimePolicy>
}

const runtimes = new Map<string, ProjectTeamRuntime>()
// Reactive version bumped when a runtime is created, so peekProjectTeamRuntime()
// callers (e.g. the session header badge) recompute once a team starts running.
const [runtimesVersion, bumpRuntimesVersion] = createSignal(0)
const MESSAGES_JSONL = ".chai/messages.jsonl"
const MESSAGES_LEGACY = ".chai/messages.json"
const TASKS_FILE = ".chai/tasks.json"
const SESSIONS_FILE = ".chai/sessions.json"
const TEAM_PROFILE_FILE = ".chai/team-profile.json"
const TEAM_FILE = ".chai/team.json"

const DEFAULT_POLICY: TeamRuntimePolicy = {
  turnTimeoutMs: 180_000,
  maxRetries: 1,
  backoffBaseMs: 1_000,
  maxBackoffMs: 15_000,
  maxTeamTurns: 6,
}

const ROLE_IDS = new Set<Role>(ROLES.map((role) => role.id))

class TimeoutError extends Error {
  constructor() {
    super("Tiempo agotado en el turno del agente")
    this.name = "TimeoutError"
  }
}

function inferRole(summary: string, provider: string): Role | undefined {
  const text = summary.toLowerCase()
  const direct = [...ROLE_IDS].find((role) => role !== "auto" && text.includes(role))
  if (direct) return direct
  if (text.includes("arquitect")) return "architect"
  if (text.includes("frontend") || text.includes("ui") || text.includes("interfaz")) return "frontend"
  if (text.includes("backend") || text.includes("api") || text.includes("servidor")) return "backend"
  if (text.includes("full-stack") || text.includes("fullstack")) return "fullstack"
  if (text.includes("ejecutor") || text.includes("terminal") || text.includes("comando")) return "executor"
  if (text.includes("tester") || text.includes("prueba") || text.includes("qa")) return "tester"
  if (text.includes("review") || text.includes("revisor")) return "reviewer"
  if (text.includes("document") || text.includes("contexto")) return "docs"
  if (provider === "codex") return "executor"
  if (provider === "kimi") return "docs"
  if (provider === "claude") return "architect"
  return undefined
}

function parseOnboardingProfile(text: string): Partial<TeamRuntimeAgentProfile> {
  const trimmed = text.trim()
  const jsonText =
    trimmed.match(/```json\s*([\s\S]*?)```/i)?.[1]?.trim() ??
    trimmed.match(/```\s*([\s\S]*?)```/)?.[1]?.trim() ??
    trimmed
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>
    const strings = (key: string) =>
      Array.isArray(parsed[key]) ? parsed[key].filter((item): item is string => typeof item === "string") : undefined
    const recommendedRole =
      typeof parsed.recommendedRole === "string" && ROLE_IDS.has(parsed.recommendedRole as Role)
        ? (parsed.recommendedRole as Role)
        : undefined
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : trimmed,
      capabilities: strings("capabilities"),
      limits: strings("limits"),
      bestTasks: strings("bestTasks"),
      neededPermissions: strings("neededPermissions"),
      recommendedRole,
    }
  } catch {
    return { summary: trimmed }
  }
}

export type TeamRuntimeAgentState = "ready" | "working" | "waiting" | "error" | "timeout" | "offline"
export type TeamRuntimeRunState = "idle" | "running" | "paused" | "cancelling"

export type TeamRuntimeTask = {
  id: string
  title: string
  status: "pending" | "in_progress" | "done" | "failed"
  assignedTo?: string
  createdAt: number
  updatedAt: number
}

export type TeamRuntimeSessionRecord = {
  accountId: string
  sessionId: string
  updatedAt: number
}

export type TeamRuntimePermissionRequest = {
  id: string
  accountId: string
  permission: Permission
  reason?: string
  createdAt: number
}

export type TeamRuntimeAgentProfile = {
  accountId: string
  account: string
  provider: string
  role: string
  summary: string
  capabilities?: string[]
  limits?: string[]
  bestTasks?: string[]
  neededPermissions?: string[]
  recommendedRole?: Role
  createdAt: number
}

export type TeamRuntimeTeamProfile = {
  projectName: string
  directory: string
  roleMode: TeamConfig["roleMode"]
  generatedAt: number
  agents: TeamRuntimeAgentProfile[]
}

export type TeamRuntimeSynthesis = {
  request: string
  summary: string
  perAgent: { accountId: string; account: string; role: string; text: string; ok: boolean }[]
  filesTouched: string[]
  tests: string[]
  nextActions: string[]
  blockers: string[]
  generatedAt: number
}

type RoundEntry = {
  agent: TeamAgent
  reply?: Message
  envelope?: TeamEnvelope
  ok: boolean
}

/**
 * Return the live runtime for a project if one was already created, WITHOUT
 * needing its deps. Lets read-only surfaces (e.g. the session header) react to a
 * running team's state/permission requests without constructing a full runtime.
 */
export function peekProjectTeamRuntime(directory: string | undefined): ProjectTeamRuntime | undefined {
  runtimesVersion() // track creation so reactive callers recompute when a team starts
  return directory ? runtimes.get(directory) : undefined
}

export function getProjectTeamRuntime(team: TeamConfig, deps: ProjectTeamRuntimeDeps) {
  const existing = runtimes.get(team.directory)
  if (existing) {
    existing.update(team, deps)
    return existing
  }
  const runtime = new ProjectTeamRuntime(team, deps)
  runtimes.set(team.directory, runtime)
  bumpRuntimesVersion((v) => v + 1)
  return runtime
}

/**
 * Forget the cached runtime for a directory so the next getProjectTeamRuntime
 * builds a fresh one (reloading state from disk). Used when a team is (re)started
 * from the wizard, so a previous team's in-memory conversation/roles don't leak
 * into the new one even when the same project folder is reused.
 */
export function dropProjectTeamRuntime(directory: string) {
  const existing = runtimes.get(directory)
  if (!existing) return
  existing.dispose()
  runtimes.delete(directory)
  bumpRuntimesVersion((v) => v + 1)
}

export class ProjectTeamRuntime {
  private team: TeamConfig
  private deps: ProjectTeamRuntimeDeps
  private orchestrator: Orchestrator
  private policy: TeamRuntimePolicy
  private cliSessions: Record<string, string> = {}
  private unsubscribe?: () => void
  private loadedMessages: Message[] = []
  private taskList: TeamRuntimeTask[] = []
  private sessionRecords: Record<string, TeamRuntimeSessionRecord> = {}
  private agentStateMap: Record<string, TeamRuntimeAgentState> = {}
  private teamProfileValue: TeamRuntimeTeamProfile | undefined
  private activeCliRuns = new Map<string, string>()
  private activeSessionIds = new Map<string, string>()
  private cancelled = false
  private persistChain = Promise.resolve()
  /** How many messages are already on disk in the jsonl log (for incremental append). */
  private persistedMessageCount = 0
  /** Resolves once the initial on-disk state has been loaded. */
  readonly ready: Promise<void>
  private readonly messagesSignal = createSignal<Message[]>([])
  readonly messages: Accessor<Message[]> = this.messagesSignal[0]
  private readonly setMessages = this.messagesSignal[1]
  private readonly tasksSignal = createSignal<TeamRuntimeTask[]>([])
  readonly tasks: Accessor<TeamRuntimeTask[]> = this.tasksSignal[0]
  private readonly setTasks = this.tasksSignal[1]
  private readonly statesSignal = createSignal<Record<string, TeamRuntimeAgentState>>({})
  readonly agentStates: Accessor<Record<string, TeamRuntimeAgentState>> = this.statesSignal[0]
  private readonly setAgentStates = this.statesSignal[1]
  private readonly runStateSignal = createSignal<TeamRuntimeRunState>("idle")
  readonly runState: Accessor<TeamRuntimeRunState> = this.runStateSignal[0]
  private readonly setRunState = this.runStateSignal[1]
  private readonly teamProfileSignal = createSignal<TeamRuntimeTeamProfile | undefined>(undefined)
  readonly teamProfile: Accessor<TeamRuntimeTeamProfile | undefined> = this.teamProfileSignal[0]
  private readonly setTeamProfile = this.teamProfileSignal[1]
  private readonly synthesisSignal = createSignal<TeamRuntimeSynthesis | undefined>(undefined)
  readonly synthesis: Accessor<TeamRuntimeSynthesis | undefined> = this.synthesisSignal[0]
  private readonly setSynthesis = this.synthesisSignal[1]
  private readonly permissionsSignal = createSignal<TeamRuntimePermissionRequest[]>([])
  readonly permissionRequests: Accessor<TeamRuntimePermissionRequest[]> = this.permissionsSignal[0]
  private readonly setPermissionRequests = this.permissionsSignal[1]
  /** User messages typed into the live role debate, drained by discussRoles. */
  private userInterjections: string[] = []

  constructor(team: TeamConfig, deps: ProjectTeamRuntimeDeps) {
    this.team = team
    this.deps = deps
    this.policy = { ...DEFAULT_POLICY, ...deps.policy }
    this.orchestrator = this.createOrchestrator()
    this.initializeAgentStates()
    this.subscribe()
    this.ready = this.loadPersistedState()
  }

  update(team: TeamConfig, deps: ProjectTeamRuntimeDeps) {
    this.team = team
    this.deps = deps
    this.policy = { ...DEFAULT_POLICY, ...deps.policy }
    const current = this.orchestrator.agents().map((agent) => agent.accountId).join("\0")
    const next = team.agents.map((agent) => agent.accountId).join("\0")
    if (current === next) return
    // Never swap the orchestrator out from under an in-flight run (onboarding /
    // a team turn) — it would drop the live conversation and reset the feed.
    if (this.runState() !== "idle") return
    this.rebuildOrchestrator()
  }

  /**
   * Recreate the orchestrator (e.g. after the agent set or roles change) WITHOUT
   * losing the conversation so far: the current router messages are folded into
   * loadedMessages first, so the timeline survives the rebuild instead of
   * blanking out (a fresh orchestrator starts with an empty router).
   */
  private rebuildOrchestrator() {
    const seen = new Set(this.loadedMessages.map((m) => m.id))
    for (const m of this.orchestrator.messages()) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      this.loadedMessages.push(m)
    }
    this.orchestrator = this.createOrchestrator()
    this.initializeAgentStates()
    this.subscribe()
    this.syncMessages()
  }

  agents() {
    return this.orchestrator.agents()
  }

  /** Resolves once all queued disk writes have flushed (used by tests/teardown). */
  flushPersistence(): Promise<void> {
    return this.persistChain
  }

  pause() {
    if (this.runState() === "running") this.setRunState("paused")
  }

  resume() {
    if (this.runState() === "paused") this.setRunState("running")
  }

  /**
   * The user speaks into the LIVE role debate. The text is queued and folded
   * into the debate transcript on the next turn (see discussRoles), so the
   * agents react to it before they settle on roles, and the debate is extended
   * enough that they actually answer a late intervention. Echoed to the feed
   * right away as a "Tú → CHAI" line.
   */
  interject(text: string) {
    const clean = text.trim()
    if (!clean) return
    this.userInterjections.push(clean)
    this.orchestrator.router.send({ from: "user", to: COORDINATOR, type: "info", text: clean })
    this.syncMessages()
  }

  async cancelActiveRuns() {
    this.cancelled = true
    this.setRunState("cancelling")
    await Promise.allSettled([
      ...[...this.activeCliRuns.values()].map((runId) => this.deps.cancelClaudeAgent?.(runId)),
      ...[...this.activeSessionIds.values()].map((sessionID) =>
        this.deps.serverSDK.client.session.abort({ sessionID }).catch(() => undefined),
      ),
    ])
    this.activeCliRuns.clear()
    this.activeSessionIds.clear()
    this.setAllAgentStates("ready")
    this.setRunState("idle")
  }

  /** Forget an agent's stored session so its next turn opens a fresh one. */
  reconnectAgent(accountId: string) {
    delete this.cliSessions[accountId]
    if (this.sessionRecords[accountId]) {
      const { [accountId]: _omit, ...rest } = this.sessionRecords
      this.sessionRecords = rest
      void this.persistSessions()
    }
    this.setAgentState(accountId, "ready")
  }

  /** Effective permissions currently granted to an agent (per-agent + team toggles). */
  effectivePermissions(accountId: string): string[] {
    const base = this.team.agents.find((agent) => agent.accountId === accountId)?.permissions ?? []
    const perms = new Set<string>(base)
    // "Control del PC = Permitido" grants full machine control team-wide.
    if (this.team.computerControl === "allowed") perms.add("computer_control")
    return [...perms]
  }

  grantPermission(accountId: string, permission: Permission) {
    let changed = false
    const agents = this.team.agents.map((agent) => {
      if (agent.accountId !== accountId || agent.permissions.includes(permission)) return agent
      changed = true
      return { ...agent, permissions: [...agent.permissions, permission] }
    })
    if (!changed) return
    this.team = { ...this.team, agents }
    void this.persistTeam()
    this.deps.onTeamUpdated?.(this.team)
  }

  revokePermission(accountId: string, permission: Permission) {
    let changed = false
    const agents = this.team.agents.map((agent) => {
      if (agent.accountId !== accountId || !agent.permissions.includes(permission)) return agent
      changed = true
      return { ...agent, permissions: agent.permissions.filter((p) => p !== permission) }
    })
    if (!changed) return
    this.team = { ...this.team, agents }
    void this.persistTeam()
    this.deps.onTeamUpdated?.(this.team)
  }

  resolvePermissionRequest(id: string, approve: boolean) {
    const request = this.permissionRequests().find((r) => r.id === id)
    if (request && approve) this.grantPermission(request.accountId, request.permission)
    this.setPermissionRequests(this.permissionRequests().filter((r) => r.id !== id))
  }

  async runOnboarding() {
    this.assertCanRun()
    this.cancelled = false
    this.setRunState("running")
    const task = this.createTask("Onboarding del equipo", undefined)
    const profiles: TeamRuntimeAgentProfile[] = []
    this.setAllAgentStates("waiting")

    try {
      for (const agent of this.team.agents) {
        this.assertNotCancelled()
        await this.waitIfPaused()
        this.setAgentState(agent.accountId, "working")
        const result = await this.dispatchWithPolicy(agent.accountId, this.onboardingPrompt(agent), {
          from: COORDINATOR,
          type: "pregunta",
          data: { onboarding: true },
        })
        const raw = result?.text?.trim() || "(sin respuesta de onboarding)"
        const parsed = parseOnboardingProfile(raw)
        profiles.push({
          accountId: agent.accountId,
          account: agent.account,
          provider: agent.provider,
          role: agent.role,
          summary: parsed.summary ?? raw,
          capabilities: parsed.capabilities,
          limits: parsed.limits,
          bestTasks: parsed.bestTasks,
          neededPermissions: parsed.neededPermissions,
          recommendedRole: parsed.recommendedRole,
          createdAt: Date.now(),
        })
        this.setAgentState(agent.accountId, result?.type === "error" ? "error" : "ready")
      }
      // After everyone has answered CHAI, the agents talk to EACH OTHER to agree
      // on distinct roles (always, so the user sees them coordinate).
      await this.discussRoles(profiles)
      this.teamProfileValue = {
        projectName: this.team.projectName,
        directory: this.team.directory,
        roleMode: this.team.roleMode,
        generatedAt: Date.now(),
        agents: profiles,
      }
      this.applyProfileRoles(this.teamProfileValue)
      this.setTeamProfile(this.teamProfileValue)
      void this.persistTeamProfile()
      this.finishTask(task.id, "done")
      this.syncMessages()
      return this.teamProfileValue
    } catch (err) {
      this.finishTask(task.id, "failed")
      throw err
    } finally {
      if (this.runState() !== "cancelling") this.setRunState("idle")
    }
  }

  async sendToAgent(accountId: string, text: string) {
    this.assertCanRun()
    this.cancelled = false
    this.setRunState("running")
    const task = this.createTask(`Mensaje directo a ${this.agentLabel(accountId)}`, accountId)
    this.setAgentState(accountId, "working")
    try {
      const result = await this.dispatchWithPolicy(accountId, text, { from: "user", type: "pregunta" })
      const ok = result?.type !== "error"
      this.finishTask(task.id, ok ? "done" : "failed")
      this.setAgentState(accountId, ok ? "ready" : result?.data?.timeout ? "timeout" : "error")
      const envelope = result ? parseTeamEnvelope(result.text) : undefined
      if (envelope) this.applyActions(this.team.agents.find((a) => a.accountId === accountId), envelope, text)
      this.syncMessages()
      return result
    } catch (err) {
      this.finishTask(task.id, "failed")
      this.setAgentState(accountId, "error")
      throw err
    } finally {
      if (this.runState() !== "cancelling") this.setRunState("idle")
    }
  }

  /**
   * Plan-then-execute team round: the coordinator breaks the goal into subtasks,
   * CHAI assigns each by role/capabilities, runs them (with one-level delegation),
   * then consolidates everything into a final synthesis. Falls back to a simple
   * sequential chain when the coordinator doesn't return a usable plan.
   */
  async sendToTeam(text: string) {
    this.assertCanRun()
    this.cancelled = false
    this.setRunState("running")
    const agents = this.team.agents
    if (agents.length === 0) {
      this.setRunState("idle")
      throw new Error("No hay agentes en el equipo")
    }
    const coordinator = agents.find((agent) => agent.role === "coordinator") ?? agents[0]
    if (!coordinator) {
      this.setRunState("idle")
      throw new Error("No hay coordinador disponible")
    }

    const rootTask = this.createTask(text.slice(0, 96) || "Tarea de equipo", coordinator.accountId)
    this.setAllAgentStates("waiting")
    const round: RoundEntry[] = []

    try {
      // 1. Ask the coordinator for a plan.
      this.setAgentState(coordinator.accountId, "working")
      const planReply = await this.dispatchWithPolicy(coordinator.accountId, this.planPrompt(text), {
        from: "user",
        type: "pregunta",
      })
      this.setAgentState(coordinator.accountId, planReply?.type === "error" ? "error" : "ready")
      const plan = planReply ? parseCoordinatorPlan(planReply.text) : undefined

      // 2. Turn the plan into concrete steps (or fall back to a chain).
      const steps = this.planToSteps(text, plan, coordinator, planReply)

      // 3. Execute, bounded by maxTeamTurns, with one level of delegation.
      let executed = 0
      for (const step of steps) {
        if (executed >= this.policy.maxTeamTurns) break
        this.assertNotCancelled()
        await this.waitIfPaused()
        this.setAgentState(step.agent.accountId, "working")
        const reply = await this.dispatchWithPolicy(step.agent.accountId, step.instructions, {
          from: coordinator.accountId,
          type: "pregunta",
          data: { originalUserRequest: text, taskId: step.taskId },
        })
        executed++
        const ok = reply?.type !== "error"
        const envelope = reply ? parseTeamEnvelope(reply.text) : undefined
        this.setAgentState(step.agent.accountId, ok ? "ready" : reply?.data?.timeout ? "timeout" : "error")
        if (step.taskId) this.finishTask(step.taskId, ok ? "done" : "failed")
        if (envelope) this.applyActions(step.agent, envelope, text)
        round.push({ agent: step.agent, reply, envelope, ok })

        // One-level delegation: an agent may hand off to another agent once.
        const delegations = envelope?.actions.filter((a): a is Extract<TeamAction, { type: "delegate" }> => a.type === "delegate") ?? []
        for (const delegation of delegations) {
          if (executed >= this.policy.maxTeamTurns) break
          const target =
            (delegation.toAgent && agents.find((a) => a.accountId === delegation.toAgent)) ||
            this.agentForRole(delegation.toRole)
          if (!target || target.accountId === step.agent.accountId) continue
          this.assertNotCancelled()
          await this.waitIfPaused()
          this.setAgentState(target.accountId, "working")
          const delegatedTask = this.createTask(`Delegado: ${delegation.instructions.slice(0, 64)}`, target.accountId)
          const dReply = await this.dispatchWithPolicy(target.accountId, this.delegationInstructions(step.agent, delegation.instructions, text), {
            from: step.agent.accountId,
            type: "pregunta",
            data: { delegated: true, originalUserRequest: text },
          })
          executed++
          const dOk = dReply?.type !== "error"
          const dEnv = dReply ? parseTeamEnvelope(dReply.text) : undefined
          this.setAgentState(target.accountId, dOk ? "ready" : dReply?.data?.timeout ? "timeout" : "error")
          this.finishTask(delegatedTask.id, dOk ? "done" : "failed")
          if (dEnv) this.applyActions(target, dEnv, text)
          round.push({ agent: target, reply: dReply, envelope: dEnv, ok: dOk })
        }
      }

      // 4. Consolidate into a final synthesis (deterministic, from collected work).
      const synthesis = this.buildSynthesis(text, plan, round)
      this.finishTask(rootTask.id, "done")
      this.syncMessages()
      this.setRunState("idle")
      return synthesis
    } catch (err) {
      this.finishTask(rootTask.id, "failed")
      if (this.runState() !== "cancelling") this.setRunState("idle")
      throw err
    }
  }

  private planToSteps(
    text: string,
    plan: CoordinatorPlan | undefined,
    coordinator: TeamAgent,
    planReply: Message | undefined,
  ): { agent: TeamAgent; instructions: string; taskId?: string }[] {
    const others = this.team.agents.filter((agent) => agent.accountId !== coordinator.accountId)
    if (plan && plan.tasks.length) {
      return plan.tasks.slice(0, this.policy.maxTeamTurns).map((planned, index) => {
        const assignee = this.resolveAssignee(planned, index, coordinator)
        const task = this.createTask(planned.title, assignee.accountId)
        return { agent: assignee, instructions: this.taskInstructions(text, planned), taskId: task.id }
      })
    }
    // Fallback: sequential chain across the remaining agents.
    const base = planReply?.text ?? text
    return others.slice(0, Math.max(0, this.policy.maxTeamTurns - 1)).map((agent) => ({
      agent,
      instructions: this.chainInstructions(base, agent),
    }))
  }

  private resolveAssignee(planned: PlannedTask, index: number, coordinator: TeamAgent): TeamAgent {
    if (planned.assigneeId) {
      const byId = this.team.agents.find((a) => a.accountId === planned.assigneeId)
      if (byId) return byId
    }
    const byRole = this.agentForRole(planned.assigneeRole)
    if (byRole) return byRole
    const others = this.team.agents.filter((a) => a.accountId !== coordinator.accountId)
    if (others.length) return others[index % others.length]!
    return coordinator
  }

  private agentForRole(role?: Role): TeamAgent | undefined {
    if (!role || role === "auto") return undefined
    return this.team.agents.find((agent) => agent.role === role)
  }

  private applyActions(agent: TeamAgent | undefined, envelope: TeamEnvelope, request: string) {
    for (const action of envelope.actions) {
      switch (action.type) {
        case "create_task": {
          const assignee =
            (action.assigneeId && this.team.agents.find((a) => a.accountId === action.assigneeId)) ||
            this.agentForRole(action.assigneeRole)
          this.createTask(action.title, assignee?.accountId ?? agent?.accountId)
          break
        }
        case "complete_task": {
          const match = this.taskList.find(
            (task) =>
              task.status !== "done" &&
              ((action.taskId && task.id === action.taskId) ||
                (action.title && task.title.toLowerCase().includes(action.title.toLowerCase()))),
          )
          if (match) this.finishTask(match.id, "done")
          break
        }
        case "request_permission": {
          if (!agent) break
          if (this.effectivePermissions(agent.accountId).includes(action.permission)) break
          this.queuePermissionRequest(agent.accountId, action.permission, action.reason)
          break
        }
        // create_task/delegate/report_block/final_result/request_review either
        // handled by the round loop (delegate) or folded into the synthesis.
        default:
          break
      }
    }
  }

  private queuePermissionRequest(accountId: string, permission: Permission, reason?: string) {
    const exists = this.permissionRequests().some((r) => r.accountId === accountId && r.permission === permission)
    if (exists) return
    const request: TeamRuntimePermissionRequest = {
      id: `perm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      accountId,
      permission,
      reason,
      createdAt: Date.now(),
    }
    this.setPermissionRequests([...this.permissionRequests(), request])
  }

  private buildSynthesis(request: string, plan: CoordinatorPlan | undefined, round: RoundEntry[]): TeamRuntimeSynthesis {
    const filesTouched = new Set<string>()
    const tests = new Set<string>()
    const nextActions = new Set<string>()
    const blockers: string[] = []
    const perAgent = round.map((entry) => {
      const env = entry.envelope
      for (const action of env?.actions ?? []) {
        if (action.type === "final_result") {
          action.filesTouched?.forEach((f) => filesTouched.add(f))
          action.tests?.forEach((t) => tests.add(t))
          action.nextActions?.forEach((n) => nextActions.add(n))
        }
        if (action.type === "report_block") blockers.push(`${this.agentLabel(entry.agent.accountId)}: ${action.reason}`)
      }
      return {
        accountId: entry.agent.accountId,
        account: entry.agent.account,
        role: entry.agent.role,
        text: (env?.text ?? entry.reply?.text ?? "(sin respuesta)").trim(),
        ok: entry.ok,
      }
    })

    const summaryParts = [plan?.summary, ...perAgent.map((a) => `${a.account}: ${a.text.split("\n")[0]}`)].filter(Boolean)
    const synthesis: TeamRuntimeSynthesis = {
      request,
      summary: summaryParts.join("\n") || "Sin avances registrados.",
      perAgent,
      filesTouched: [...filesTouched],
      tests: [...tests],
      nextActions: [...nextActions],
      blockers,
      generatedAt: Date.now(),
    }
    this.setSynthesis(synthesis)
    // Record the consolidated result on the router so it shows in the timeline.
    this.orchestrator.router.send({
      from: COORDINATOR,
      to: "user",
      type: "entrega",
      text: synthesis.summary,
      data: {
        filesTouched: synthesis.filesTouched,
        tests: synthesis.tests,
        nextActions: synthesis.nextActions,
        blockers: synthesis.blockers,
      },
    })
    return synthesis
  }

  /**
   * Dispatch one turn with a timeout, bounded retries and exponential backoff.
   * On timeout the agent's active run is cancelled (so the runtime lock frees).
   * Retries REUSE the agent's session (we do not recreate it) to avoid spawning
   * duplicate sessions on every transient error — a dead session is recovered
   * via the manual "Reconectar" action. Returns the reply, or an error message.
   */
  private async dispatchWithPolicy(
    agentId: string,
    text: string,
    opts: { from?: string; type?: Message["type"]; data?: Record<string, unknown> },
  ): Promise<Message | undefined> {
    let attempt = 0
    while (true) {
      this.assertNotCancelled()
      await this.waitIfPaused()
      try {
        const reply = await this.withTimeout(this.orchestrator.coordinator.dispatch(agentId, text, opts), this.policy.turnTimeoutMs)
        if (reply && reply.type === "error" && attempt < this.policy.maxRetries) {
          attempt++
          await this.backoff(attempt)
          continue
        }
        return reply
      } catch (err) {
        const isTimeout = err instanceof TimeoutError
        await this.cancelAgentRun(agentId)
        if (attempt >= this.policy.maxRetries) {
          return this.orchestrator.router.send({
            from: agentId,
            to: opts.from ?? COORDINATOR,
            type: "error",
            text: isTimeout ? "Tiempo agotado en el turno del agente" : err instanceof Error ? err.message : String(err),
            data: { timeout: isTimeout },
          })
        }
        attempt++
        await this.backoff(attempt)
      }
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    if (!ms || ms <= 0) return promise
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new TimeoutError()), ms)
      promise.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (err) => {
          clearTimeout(timer)
          reject(err)
        },
      )
    })
  }

  private async backoff(attempt: number) {
    const delay = Math.min(this.policy.backoffBaseMs * 2 ** (attempt - 1), this.policy.maxBackoffMs)
    await new Promise((resolve) => setTimeout(resolve, delay))
    this.assertNotCancelled()
  }

  private async cancelAgentRun(accountId: string) {
    const runId = this.activeCliRuns.get(accountId)
    if (runId) {
      await this.deps.cancelClaudeAgent?.(runId).catch(() => undefined)
      this.activeCliRuns.delete(accountId)
    }
    const sessionId = this.activeSessionIds.get(accountId)
    if (sessionId) {
      await this.deps.serverSDK.client.session.abort({ sessionID: sessionId }).catch(() => undefined)
      this.activeSessionIds.delete(accountId)
    }
  }

  private assertCanRun() {
    if (this.runState() === "running" || this.runState() === "cancelling") {
      throw new Error("El equipo ya tiene una ejecucion activa")
    }
    if (this.runState() === "paused") throw new Error("El equipo esta pausado")
  }

  private assertNotCancelled() {
    if (this.cancelled) throw new Error("Ejecucion cancelada")
  }

  private async waitIfPaused() {
    while (this.runState() === "paused") {
      this.assertNotCancelled()
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  private planPrompt(text: string) {
    return [
      "Eres el coordinador operativo de un equipo CHAI multi-agente.",
      "Divide la siguiente solicitud en subtareas asignables por rol.",
      "",
      text,
      "",
      coordinatorPlanInstructions([...ROLE_IDS]),
    ].join("\n")
  }

  private taskInstructions(request: string, planned: PlannedTask) {
    return [
      `Solicitud original del usuario: ${request}`,
      "",
      `Tu subtarea (${planned.priority}): ${planned.title}`,
      planned.description ? `Detalle: ${planned.description}` : "",
      "",
      "Ejecuta tu subtarea desde tu rol. Reporta avances concretos.",
      "",
      teamProtocolInstructions(),
    ]
      .filter(Boolean)
      .join("\n")
  }

  private chainInstructions(previous: string, agent: TeamAgent) {
    return [
      "Mensaje del equipo:",
      "",
      previous,
      "",
      `Continua el trabajo desde tu rol (${roleLabel(agent.role)}).`,
      "",
      teamProtocolInstructions(),
    ].join("\n")
  }

  private delegationInstructions(from: TeamAgent, instructions: string, request: string) {
    return [
      `Solicitud original del usuario: ${request}`,
      `${from.account} (${roleLabel(from.role)}) te delega esta tarea:`,
      "",
      instructions,
      "",
      teamProtocolInstructions(),
    ].join("\n")
  }

  /** A plain-language sentence telling the agent what it may do (so it doesn't assume read-only). */
  private permissionsSentence(agent: TeamAgent): string {
    const labels: Record<string, string> = {
      read_project: "leer el proyecto",
      edit_project: "crear y editar archivos del proyecto",
      run_commands: "ejecutar comandos, scripts y tests",
      browser_testing: "probar en el navegador",
      screenshots: "tomar capturas de pantalla",
      computer_control: "control TOTAL del equipo (no estás en solo lectura)",
    }
    const has = this.effectivePermissions(agent.accountId).map((p) => labels[p] ?? p)
    return has.length
      ? `Tus permisos REALES en este proyecto: ${has.join(", ")}. Actúa en consecuencia (NO asumas solo lectura).`
      : "Tienes permisos de solo lectura en este proyecto."
  }

  /** One line describing the whole team, so agents know exactly who is (and isn't) here. */
  private teamCompositionSentence(): string {
    const names = this.team.agents.map((a) => a.account).join(", ")
    return (
      `El equipo lo forman SOLO estos ${this.team.agents.length} agentes: ${names}. ` +
      "No va a llegar nadie más por ahora, así que repártanse entre ustedes lo esencial; si creen que faltan manos, eso se decide después."
    )
  }

  private onboardingPrompt(agent: TeamAgent) {
    return [
      "CHAI esta formando un equipo multi-agente para este proyecto.",
      `Cuenta: ${agent.account}`,
      `Proveedor: ${agent.provider}`,
      `Rol actual: ${roleLabel(agent.role)}`,
      this.teamCompositionSentence(),
      this.permissionsSentence(agent),
      "",
      "Responde SOLO con JSON valido, sin markdown, con este schema:",
      "{",
      '  "summary": "resumen breve en espanol",',
      '  "capabilities": ["capacidad 1", "capacidad 2"],',
      '  "limits": ["limite o riesgo"],',
      '  "bestTasks": ["tarea que puedes asumir"],',
      '  "neededPermissions": ["read_project", "edit_project"],',
      '  "recommendedRole": "architect"',
      "}",
      "",
      `recommendedRole debe ser uno de: ${[...ROLE_IDS].filter((role) => role !== "auto").join(", ")}.`,
    ].join("\n")
  }

  private subscribe() {
    this.unsubscribe?.()
    this.unsubscribe = this.orchestrator.onMessage(() => {
      this.syncMessages()
    })
  }

  /** Release subscriptions so the runtime can be dropped and rebuilt cleanly. */
  dispose() {
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  private agentLabel(id: string) {
    if (id === "user") return "usuario"
    if (id === COORDINATOR) return "coordinador"
    const agent = this.team.agents.find((item) => item.accountId === id)
    if (!agent) return id
    return `${agent.account} (${roleLabel(agent.role)})`
  }

  private syncMessages() {
    const seen = new Set<string>()
    const messages = [...this.loadedMessages, ...this.orchestrator.messages()].filter((message) => {
      if (seen.has(message.id)) return false
      seen.add(message.id)
      return true
    })
    this.setMessages(messages)
    this.persistMessages(messages)
  }

  private initializeAgentStates() {
    const next: Record<string, TeamRuntimeAgentState> = {}
    for (const agent of this.team.agents) next[agent.accountId] = this.agentStateMap[agent.accountId] ?? "ready"
    this.agentStateMap = next
    this.setAgentStates({ ...next })
  }

  private setAgentState(accountId: string, state: TeamRuntimeAgentState) {
    this.agentStateMap = { ...this.agentStateMap, [accountId]: state }
    this.setAgentStates(this.agentStateMap)
  }

  private setAllAgentStates(state: TeamRuntimeAgentState) {
    const next: Record<string, TeamRuntimeAgentState> = {}
    for (const agent of this.team.agents) next[agent.accountId] = state
    this.agentStateMap = next
    this.setAgentStates({ ...next })
  }

  private createTask(title: string, assignedTo?: string) {
    const now = Date.now()
    const task: TeamRuntimeTask = {
      id: `task_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      title,
      status: "in_progress",
      assignedTo,
      createdAt: now,
      updatedAt: now,
    }
    this.taskList = [...this.taskList, task]
    this.setTasks(this.taskList)
    void this.persistTasks()
    return task
  }

  private finishTask(id: string, status: "done" | "failed") {
    const now = Date.now()
    this.taskList = this.taskList.map((task) => (task.id === id ? { ...task, status, updatedAt: now } : task))
    this.setTasks(this.taskList)
    void this.persistTasks()
  }

  /** Manual task control from the UI board. */
  setTaskStatus(id: string, status: TeamRuntimeTask["status"]) {
    const now = Date.now()
    this.taskList = this.taskList.map((task) => (task.id === id ? { ...task, status, updatedAt: now } : task))
    this.setTasks(this.taskList)
    void this.persistTasks()
  }

  reassignTask(id: string, accountId: string | undefined) {
    const now = Date.now()
    this.taskList = this.taskList.map((task) => (task.id === id ? { ...task, assignedTo: accountId, updatedAt: now } : task))
    this.setTasks(this.taskList)
    void this.persistTasks()
  }

  private async loadPersistedState() {
    if (!this.deps.readProjectFile) return
    await Promise.all([this.loadMessages(), this.loadTasks(), this.loadSessions(), this.loadTeamProfile()])
  }

  private async loadMessages() {
    if (!this.deps.readProjectFile) return
    // Prefer the incremental jsonl log; fall back to the legacy json array.
    try {
      const jsonl = await this.deps.readProjectFile(this.team.directory, MESSAGES_JSONL)
      if (jsonl) {
        this.loadedMessages = parseJsonl(jsonl)
        this.persistedMessageCount = this.loadedMessages.length
        this.syncMessages()
        return
      }
    } catch (err) {
      console.warn("[chai] could not load messages.jsonl", err)
    }
    await this.readJson(MESSAGES_LEGACY, (parsed) => {
      if (!Array.isArray(parsed)) return
      this.loadedMessages = parsed.filter((item): item is Message => !!item && typeof item === "object")
      this.persistedMessageCount = 0 // legacy json isn't the jsonl log; rewrite on next persist
      this.syncMessages()
    })
  }

  private async loadTasks() {
    await this.readJson(TASKS_FILE, (parsed) => {
      if (!Array.isArray(parsed)) return
      this.taskList = parsed.filter((item): item is TeamRuntimeTask => !!item && typeof item === "object")
      this.setTasks(this.taskList)
    })
  }

  private async loadSessions() {
    await this.readJson(SESSIONS_FILE, (parsed) => {
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return
      this.sessionRecords = parsed as Record<string, TeamRuntimeSessionRecord>
    })
  }

  private async loadTeamProfile() {
    await this.readJson(TEAM_PROFILE_FILE, (parsed) => {
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return
      this.teamProfileValue = parsed as TeamRuntimeTeamProfile
      this.setTeamProfile(this.teamProfileValue)
    })
  }

  private async readJson(path: string, apply: (parsed: unknown) => void) {
    if (!this.deps.readProjectFile) return
    try {
      const raw = await this.deps.readProjectFile(this.team.directory, path)
      if (!raw) return
      apply(JSON.parse(raw))
    } catch (err) {
      console.warn(`[chai] could not load ${path}`, err)
    }
  }

  private persistMessages(messages: Message[]) {
    if (!this.deps.writeProjectFile && !this.deps.appendProjectFile) return
    // Incremental append when the platform supports it and the log only grew.
    if (this.deps.appendProjectFile && messages.length >= this.persistedMessageCount) {
      const delta = messages.slice(this.persistedMessageCount)
      if (delta.length === 0) return
      const chunk = delta.map((m) => JSON.stringify(m)).join("\n") + "\n"
      const startCount = this.persistedMessageCount
      this.persistedMessageCount = messages.length
      this.persistChain = this.persistChain
        .catch(() => undefined)
        .then(() => this.deps.appendProjectFile?.(this.team.directory, MESSAGES_JSONL, chunk))
        .then(() => undefined)
        .catch((err) => {
          // Append failed: roll back the counter so the next write retries the delta.
          this.persistedMessageCount = startCount
          console.warn("[chai] could not append team messages", err)
        })
      return
    }
    // Fallback: rewrite the whole jsonl log.
    if (!this.deps.writeProjectFile) return
    const body = messages.map((m) => JSON.stringify(m)).join("\n") + (messages.length ? "\n" : "")
    this.persistedMessageCount = messages.length
    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(() => this.deps.writeProjectFile?.(this.team.directory, MESSAGES_JSONL, body))
      .then(() => undefined)
      .catch((err) => {
        console.warn("[chai] could not persist team messages", err)
      })
  }

  private persistTasks() {
    if (!this.deps.writeProjectFile) return
    return this.enqueuePersist(TASKS_FILE, this.taskList)
  }

  private persistSessions() {
    if (!this.deps.writeProjectFile) return
    return this.enqueuePersist(SESSIONS_FILE, this.sessionRecords)
  }

  private persistTeamProfile() {
    if (!this.teamProfileValue) return
    return this.enqueuePersist(TEAM_PROFILE_FILE, this.teamProfileValue)
  }

  private profileRole(profile: TeamRuntimeTeamProfile, agent: TeamAgent): Role | undefined {
    const p = profile.agents.find((item) => item.accountId === agent.accountId)
    const text = [p?.summary, ...(p?.capabilities ?? []), ...(p?.bestTasks ?? [])].filter(Boolean).join("\n")
    return p?.recommendedRole ?? inferRole(text, agent.provider)
  }

  /**
   * Assign DISTINCT roles to the agents so two never share one (the bug where
   * both became "Arquitecto"). Each agent keeps its preferred role if still free;
   * otherwise it gets the next free role by priority. Fixed roles (hybrid mode)
   * claim their slot first. Only repeats a role if there are more agents than
   * roles. Returns accountId → role.
   */
  private assignDistinctRoles(prefs: { accountId: string; role: Role | undefined; fixed: boolean }[]): Map<string, Role> {
    const order = ROLES.map((r) => r.id).filter((r) => r !== "auto")
    const taken = new Set<Role>()
    const result = new Map<string, Role>()
    for (const p of prefs) {
      if (p.fixed && p.role && p.role !== "auto") {
        taken.add(p.role)
        result.set(p.accountId, p.role)
      }
    }
    for (const p of prefs) {
      if (result.has(p.accountId)) continue
      let role = p.role && p.role !== "auto" && !taken.has(p.role) ? p.role : undefined
      if (!role) role = order.find((r) => !taken.has(r))
      if (!role) role = p.role && p.role !== "auto" ? p.role : "fullstack"
      taken.add(role)
      result.set(p.accountId, role)
    }
    // A multi-agent team must ALWAYS have a coordinator — it's who the user talks
    // to to steer the OTHER agents. If nobody landed on it, hand it to the first
    // agent that isn't pinned to a role (hybrid) — or just the first one. (A solo
    // agent needs no coordinator: there's nothing to coordinate.)
    if (prefs.length >= 2 && ![...result.values()].includes("coordinator")) {
      const fixed = new Set(prefs.filter((p) => p.fixed && p.role && p.role !== "auto").map((p) => p.accountId))
      const pick = prefs.find((p) => !fixed.has(p.accountId)) ?? prefs[0]
      if (pick) result.set(pick.accountId, "coordinator")
    }
    return result
  }

  /** Resolve a role from a short answer (a role id, its Spanish label, or loose text). */
  private parseRoleAnswer(text?: string): Role | undefined {
    if (!text) return undefined
    const t = text.trim().toLowerCase()
    for (const r of ROLES) if (r.id !== "auto" && t.includes(r.id)) return r.id
    for (const r of ROLES) if (r.id !== "auto" && t.includes(r.label.toLowerCase())) return r.id
    const inferred = inferRole(text, "")
    return inferred && inferred !== "auto" ? inferred : undefined
  }

  /**
   * A REAL multi-turn debate where the agents divide up the roles themselves.
   * Each one writes its own message (as long as it needs), arguing from its
   * ACTUAL strengths for the role it wants and against the one it doesn't, while
   * reacting to teammates. CHAI's instruction is hidden, so the feed shows only
   * genuine "Kimi → Codex" / "Codex → Kimi" chat. It runs several turns until
   * they settle on distinct roles (capped); assignDistinctRoles still guarantees
   * no two end up sharing a role.
   */
  private async discussRoles(profiles: TeamRuntimeAgentProfile[]) {
    if (this.team.roleMode !== "auto" && this.team.roleMode !== "hybrid") return
    const agents = this.team.agents
    if (agents.length < 2) return

    const profileOf = (accountId: string) => profiles.find((x) => x.accountId === accountId)
    const roleOf = (accountId: string): Role | undefined => {
      const p = profileOf(accountId)
      if (!p) return undefined
      return (
        p.recommendedRole ??
        inferRole([p.summary, ...(p.capabilities ?? []), ...(p.bestTasks ?? [])].filter(Boolean).join("\n"), p.provider)
      )
    }
    const proposed = new Map<string, Role | undefined>(agents.map((a) => [a.accountId, roleOf(a.accountId)]))
    const rolesList = ROLES.filter((r) => r.id !== "auto")
      .map((r) => r.label)
      .join(", ")
    const ids = ROLES.map((r) => r.id).filter((r) => r !== "auto")
    const distinctSettled = () => {
      const roles = agents.map((a) => proposed.get(a.accountId))
      return roles.every((r) => r && r !== "auto") && new Set(roles).size === roles.length
    }

    this.orchestrator.router.send({
      from: COORDINATOR,
      to: "user",
      type: "info",
      text:
        "Equipo, debatan entre ustedes y repártanse los roles (ninguno repetido). " +
        "Defiendan con argumentos el rol donde de verdad aporten más; tómense el tiempo que haga falta.",
    })
    this.syncMessages()

    // Multi-turn debate: agents take turns, each seeing the full running transcript,
    // until they land on distinct roles (or the turn cap is reached).
    const transcript: string[] = []
    const minTurns = agents.length * 2 // at least two full rounds, so it's a real back-and-forth
    const maxTurns = agents.length * 4
    // The user can interject mid-debate (interject()): bonusTurns extends the cap
    // and answerUserUntilTurn holds off settling so the team actually reacts.
    let bonusTurns = 0
    let answerUserUntilTurn = -1
    for (let turn = 0; turn < maxTurns + bonusTurns; turn++) {
      this.assertNotCancelled()
      await this.waitIfPaused()
      // Fold any user interjections into the transcript so the next speaker reacts
      // to them before the team settles on roles, and give the debate room to do so.
      if (this.userInterjections.length) {
        for (const msg of this.userInterjections.splice(0)) transcript.push(`Usuario (interviene): ${msg}`)
        bonusTurns = Math.min(bonusTurns + agents.length, maxTurns)
        answerUserUntilTurn = turn + agents.length
      }
      // In the round right after an interjection the agents are answering the USER,
      // so their reply is addressed to "user" (shown as "→ Tú") instead of the
      // round-robin teammate — they really are talking to you, not to each other.
      const answeringUser = turn < answerUserUntilTurn
      const speaker = agents[turn % agents.length]!
      const listener = agents[(turn + 1) % agents.length]!
      if (speaker.accountId === listener.accountId) continue
      const others = agents
        .filter((a) => a.accountId !== speaker.accountId)
        .map((a) => a.account)
        .join(", ")
      const opening = transcript.length === 0 && !answeringUser
      const prompt = [
        `Eres ${speaker.account}, en una conversación de equipo con ${others} para decidir quién toma cada rol.`,
        `Regla: NO puede haber dos personas con el mismo rol. Roles posibles: ${rolesList}.`,
        this.teamCompositionSentence(),
        this.permissionsSentence(speaker),
        `Nadie te dice qué se te da bien: evalúa con honestidad TUS PROPIAS capacidades reales (qué haces mejor y qué peor) y arguméntalo tú mismo, con tu propio conocimiento.`,
        transcript.length ? `Conversación hasta ahora:\n${transcript.join("\n")}` : "",
        answeringUser
          ? `El usuario acaba de intervenir (línea "Usuario (interviene):"). Le hablas A ÉL directamente, no a tus compañeros: atiende lo que pide, dile qué rol tomas tú y por qué; después seguirán debatiendo entre ustedes.`
          : opening
            ? `Abre tú dirigiéndote a ${listener.account}: di qué rol quieres tomar y cuál NO, y por qué, según lo que de verdad sabes hacer.`
            : `Continúa el debate de forma genuina: reacciona a lo que dijeron (sobre todo ${listener.account}), defiende tu postura con argumentos propios o cede si te convencen, y avanza hacia un acuerdo donde nadie repita rol. No repitas lo ya dicho: aporta algo nuevo.`,
        `Habla como en un chat real, con tu propio criterio y personalidad; extiéndete lo que necesites. Nada de JSON ni listas con viñetas.`,
        `Al FINAL, en una línea aparte, escribe exactamente "ROL: <id>" con el rol que TÚ tomas (uno de: ${ids.join(", ")}).`,
      ]
        .filter(Boolean)
        .join("\n")
      this.setAgentState(speaker.accountId, "working")
      const reply = await this.dispatchWithPolicy(speaker.accountId, prompt, {
        // When answering the user, address the reply to them ("→ Tú"); otherwise
        // it's part of the agent-to-agent debate, addressed to the next teammate.
        from: answeringUser ? "user" : listener.accountId,
        type: "pregunta",
        data: { discussion: true },
      })
      this.setAgentState(speaker.accountId, reply?.type === "error" ? "error" : "ready")
      const text = reply?.text?.trim()
      if (text) {
        transcript.push(`${speaker.account}: ${text}`)
        // The agent commits to its role on an explicit "ROL: <id>" line, so we
        // take that (reliable) instead of guessing the role from the prose.
        const marker = text.match(/ROL:\s*([a-z_]+)/i)
        const chosen = this.parseRoleAnswer(marker?.[1])
        if (chosen) proposed.set(speaker.accountId, chosen)
      }
      // Wrap up only after a real discussion (>= minTurns), once roles are distinct,
      // and never while the team still owes the user a reaction to an interjection.
      if (turn + 1 >= minTurns && turn >= answerUserUntilTurn && distinctSettled()) break
    }

    // Carry what each one settled on into the profiles; assignDistinctRoles enforces uniqueness.
    for (const p of profiles) {
      const r = proposed.get(p.accountId)
      if (r && r !== "auto") p.recommendedRole = r
    }
    this.syncMessages()
  }

  private applyProfileRoles(profile: TeamRuntimeTeamProfile) {
    if (this.team.roleMode !== "auto" && this.team.roleMode !== "hybrid") return
    const prefs = this.team.agents.map((agent) => ({
      accountId: agent.accountId,
      role: this.team.roleMode === "hybrid" && agent.role !== "auto" ? agent.role : this.profileRole(profile, agent),
      fixed: this.team.roleMode === "hybrid" && agent.role !== "auto",
    }))
    const assignment = this.assignDistinctRoles(prefs)
    let changed = false
    const agents = this.team.agents.map((agent) => {
      const role = assignment.get(agent.accountId)
      if (!role || role === agent.role) return agent
      changed = true
      return { ...agent, role }
    })
    if (!changed) return

    this.team = { ...this.team, agents }
    void this.persistTeam()
    this.deps.onTeamUpdated?.(this.team)
    this.rebuildOrchestrator()
  }

  private persistTeam() {
    return this.enqueuePersist(TEAM_FILE, this.team)
  }

  private recordSession(accountId: string, sessionId: string) {
    this.sessionRecords = {
      ...this.sessionRecords,
      [accountId]: { accountId, sessionId, updatedAt: Date.now() },
    }
    void this.persistSessions()
  }

  private enqueuePersist(path: string, value: unknown) {
    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(() => this.deps.writeProjectFile?.(this.team.directory, path, JSON.stringify(value, null, 2)))
      .then(() => undefined)
      .catch((err) => {
        console.warn(`[chai] could not persist ${path}`, err)
      })
  }

  private createOrchestrator() {
    return new Orchestrator(
      {
        projectName: this.team.projectName,
        directory: this.team.directory,
        agents: this.team.agents.map((agent, index) =>
          toOrchestratorAgent(agent, index, this.deps.sessionForAgent(agent)),
        ),
      },
      { transport: this.createTransport() },
    )
  }

  private createTransport(): Transport {
    const byAccountId = (accountId: string) => this.team.agents.find((agent) => agent.accountId === accountId)
    const sessionForAgent = (agent: TeamAgent) =>
      this.sessionRecords[agent.accountId]?.sessionId ?? this.deps.sessionForAgent(agent)
    const createSessionForAgent = async (agent: TeamAgent) => {
      const sessionId = await this.deps.createSessionForAgent(agent)
      this.recordSession(agent.accountId, sessionId)
      return sessionId
    }

    const cliTransport =
      this.deps.runClaudeAgent &&
      createClaudeTransport({
        directory: this.team.directory,
        runClaudeAgent: this.deps.runClaudeAgent,
        byAccountId,
        computerControl: this.team.computerControl,
        modelForAgent: (agent) => agent.model,
        sessionForAgent: (agent) => this.cliSessions[agent.accountId] ?? this.sessionRecords[agent.accountId]?.sessionId,
        onSession: (agent, sessionId) => {
          this.cliSessions[agent.accountId] = sessionId
          this.recordSession(agent.accountId, sessionId)
        },
        onRunStart: (agent, runId) => {
          this.activeCliRuns.set(agent.accountId, runId)
        },
        onRunEnd: (agent, runId) => {
          if (this.activeCliRuns.get(agent.accountId) === runId) this.activeCliRuns.delete(agent.accountId)
        },
      })

    const sessionTransport = createTeamTransport({
      serverSDK: this.deps.serverSDK,
      directory: this.team.directory,
      sessionForAgent,
      createSessionForAgent,
      byAccountId,
      modelForProvider: this.deps.modelForProvider,
      onSessionStart: (agent, sessionID) => {
        this.activeSessionIds.set(agent.accountId, sessionID)
        this.recordSession(agent.accountId, sessionID)
      },
      onSessionEnd: (agent, sessionID) => {
        if (this.activeSessionIds.get(agent.accountId) === sessionID) this.activeSessionIds.delete(agent.accountId)
      },
      waitForAssistantReply: (sessionID) =>
        waitForAssistantReply({
          serverSDK: this.deps.serverSDK,
          directory: this.team.directory,
          sessionID,
        }),
    })

    return {
      deliver: (agent, message, runtime) => {
        const teamAgent = byAccountId(agent.accountId)
        if (!teamAgent) throw new Error(`No se encontro el agente ${agent.account}`)
        if (isCliProvider(teamAgent.provider)) {
          if (!cliTransport) throw new Error("El runner de CLI requiere la app de escritorio")
          return cliTransport.deliver(agent, message, runtime)
        }
        const providerID = OPENCODE_PROVIDER[teamAgent.provider]
        if (!providerID) throw new Error(`Proveedor ${teamAgent.provider} no tiene adaptador conectado`)
        return sessionTransport.deliver(agent, message, runtime)
      },
    }
  }
}

/** Tolerant jsonl reader: skips blank/partial/corrupt lines instead of failing. */
function parseJsonl(raw: string): Message[] {
  const out: Message[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed)
      if (obj && typeof obj === "object" && typeof obj.id === "string") out.push(obj as Message)
    } catch {
      // partial last line or corruption — skip it, keep the rest
    }
  }
  return out
}
