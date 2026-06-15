// Structured contract for coordinator planning and inter-agent messages.
//
// Agents reply in free-form text, but CHAI needs a stable, machine-readable
// envelope to turn those replies into tasks, delegations, permission requests and
// final results. This module owns BOTH sides of that contract:
//   - the prompt instructions we send (so the model knows the schema), and
//   - the tolerant parser that reads the model's answer back.
// Keeping them in one file is what stops the prompt and the parser from drifting.
//
// The parser is intentionally forgiving: models wrap JSON in markdown fences, add
// prose around it, or omit optional fields. We extract the first balanced JSON
// object, validate field by field, and silently drop anything malformed instead
// of throwing — a bad reply degrades to "plain text, no actions", never a crash.

import type { Permission, Role } from "./types"

// Mirrors the Role/Permission unions in types.ts. Unions aren't enumerable at
// runtime, so these arrays are the validation source of truth — keep in sync.
export const TEAM_ROLES: Role[] = [
  "coordinator",
  "architect",
  "frontend",
  "backend",
  "fullstack",
  "executor",
  "tester",
  "reviewer",
  "docs",
  "auto",
]
export const TEAM_PERMISSIONS: Permission[] = [
  "read_project",
  "edit_project",
  "run_commands",
  "browser_testing",
  "screenshots",
  "computer_control",
]

const ROLE_SET = new Set<string>(TEAM_ROLES)
const PERMISSION_SET = new Set<string>(TEAM_PERMISSIONS)

export type Priority = "low" | "medium" | "high"
const PRIORITY_SET = new Set<string>(["low", "medium", "high"])

export type PlannedTask = {
  title: string
  description?: string
  assigneeRole?: Role
  assigneeId?: string
  priority: Priority
}

/** The coordinator's answer when CHAI asks it to break a goal into work. */
export type CoordinatorPlan = {
  summary: string
  tasks: PlannedTask[]
  /** Optional explicit "who should act next" hint (an account id). */
  nextAgent?: string
  done: boolean
}

export type TeamActionType =
  | "create_task"
  | "complete_task"
  | "request_review"
  | "request_permission"
  | "delegate"
  | "report_block"
  | "final_result"

export type TeamAction =
  | { type: "create_task"; title: string; description?: string; assigneeRole?: Role; assigneeId?: string; priority: Priority }
  | { type: "complete_task"; taskId?: string; title?: string; summary?: string }
  | { type: "request_review"; target?: string; summary: string }
  | { type: "request_permission"; permission: Permission; reason?: string }
  | { type: "delegate"; toRole?: Role; toAgent?: string; instructions: string }
  | { type: "report_block"; reason: string; needs?: string }
  | { type: "final_result"; summary: string; filesTouched?: string[]; tests?: string[]; nextActions?: string[] }

/** A parsed agent reply: the prose it spoke plus the structured actions it asked for. */
export type TeamEnvelope = {
  summary?: string
  text?: string
  actions: TeamAction[]
  done: boolean
}

// ---- low level value coercion ----------------------------------------------

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim())
  return out.length ? out : undefined
}

function asRole(value: unknown): Role | undefined {
  return typeof value === "string" && ROLE_SET.has(value) ? (value as Role) : undefined
}

function asPermission(value: unknown): Permission | undefined {
  return typeof value === "string" && PERMISSION_SET.has(value) ? (value as Permission) : undefined
}

function asPriority(value: unknown): Priority {
  return typeof value === "string" && PRIORITY_SET.has(value) ? (value as Priority) : "medium"
}

function asBool(value: unknown): boolean {
  return value === true
}

/**
 * Pull the first balanced JSON object out of free text. Handles ```json fences,
 * bare ``` fences and inline prose. Returns the raw object string or undefined.
 */
export function extractJsonBlock(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced?.[1] ?? text
  const start = candidate.indexOf("{")
  if (start === -1) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return candidate.slice(start, i + 1)
    }
  }
  return undefined
}

function parseObject(text: string): Record<string, unknown> | undefined {
  const block = extractJsonBlock(text)
  if (!block) return undefined
  try {
    const parsed = JSON.parse(block)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

// ---- plan -------------------------------------------------------------------

function parsePlannedTask(value: unknown): PlannedTask | undefined {
  if (!value || typeof value !== "object") return undefined
  const obj = value as Record<string, unknown>
  const title = asString(obj.title)
  if (!title) return undefined
  return {
    title,
    description: asString(obj.description),
    assigneeRole: asRole(obj.assigneeRole) ?? asRole(obj.role),
    assigneeId: asString(obj.assigneeId),
    priority: asPriority(obj.priority),
  }
}

/** Parse the coordinator's planning reply. Returns undefined when there's no usable JSON. */
export function parseCoordinatorPlan(text: string): CoordinatorPlan | undefined {
  const obj = parseObject(text)
  if (!obj) return undefined
  const tasksRaw = Array.isArray(obj.tasks) ? obj.tasks : []
  const tasks = tasksRaw.map(parsePlannedTask).filter((t): t is PlannedTask => !!t)
  return {
    summary: asString(obj.summary) ?? "",
    tasks,
    nextAgent: asString(obj.nextAgent),
    done: asBool(obj.done),
  }
}

// ---- actions / envelope -----------------------------------------------------

function parseAction(value: unknown): TeamAction | undefined {
  if (!value || typeof value !== "object") return undefined
  const obj = value as Record<string, unknown>
  const type = asString(obj.type)
  switch (type) {
    case "create_task": {
      const title = asString(obj.title)
      if (!title) return undefined
      return {
        type: "create_task",
        title,
        description: asString(obj.description),
        assigneeRole: asRole(obj.assigneeRole) ?? asRole(obj.role),
        assigneeId: asString(obj.assigneeId),
        priority: asPriority(obj.priority),
      }
    }
    case "complete_task":
      return { type: "complete_task", taskId: asString(obj.taskId), title: asString(obj.title), summary: asString(obj.summary) }
    case "request_review": {
      const summary = asString(obj.summary)
      if (!summary) return undefined
      return { type: "request_review", target: asString(obj.target), summary }
    }
    case "request_permission": {
      const permission = asPermission(obj.permission)
      if (!permission) return undefined
      return { type: "request_permission", permission, reason: asString(obj.reason) }
    }
    case "delegate": {
      const instructions = asString(obj.instructions)
      if (!instructions) return undefined
      return { type: "delegate", toRole: asRole(obj.toRole), toAgent: asString(obj.toAgent), instructions }
    }
    case "report_block": {
      const reason = asString(obj.reason)
      if (!reason) return undefined
      return { type: "report_block", reason, needs: asString(obj.needs) }
    }
    case "final_result": {
      const summary = asString(obj.summary)
      if (!summary) return undefined
      return {
        type: "final_result",
        summary,
        filesTouched: asStringArray(obj.filesTouched),
        tests: asStringArray(obj.tests),
        nextActions: asStringArray(obj.nextActions),
      }
    }
    default:
      return undefined
  }
}

/**
 * Parse an agent reply into prose + structured actions. Always returns an
 * envelope: when there's no JSON, `text` is the raw reply and `actions` is empty.
 */
export function parseTeamEnvelope(text: string): TeamEnvelope {
  const trimmed = text.trim()
  const obj = parseObject(trimmed)
  if (!obj) return { text: trimmed, actions: [], done: false }
  const actionsRaw = Array.isArray(obj.actions) ? obj.actions : []
  const actions = actionsRaw.map(parseAction).filter((a): a is TeamAction => !!a)
  return {
    summary: asString(obj.summary),
    text: asString(obj.text) ?? asString(obj.summary) ?? trimmed,
    actions,
    done: asBool(obj.done),
  }
}

// ---- prompt instructions (kept next to the parser on purpose) ---------------

/** Instructions appended to the coordinator prompt so its plan JSON parses. */
export function coordinatorPlanInstructions(roles: Role[] = TEAM_ROLES): string {
  const roleList = roles.filter((r) => r !== "auto").join(", ")
  return [
    "Responde SOLO con JSON valido (sin markdown) con este schema:",
    "{",
    '  "summary": "estado breve del plan",',
    '  "tasks": [',
    '    { "title": "subtarea concreta", "assigneeRole": "frontend", "priority": "high", "description": "detalle opcional" }',
    "  ],",
    '  "nextAgent": "id-de-cuenta opcional",',
    '  "done": false',
    "}",
    `assigneeRole debe ser uno de: ${roleList}.`,
    "priority debe ser: low, medium o high.",
    "Divide el objetivo en subtareas pequenas y asignables. No inventes agentes.",
  ].join("\n")
}

/** Instructions appended to a worker-agent prompt so its envelope JSON parses. */
export function teamProtocolInstructions(): string {
  return [
    "Cuando termines tu turno responde SOLO con JSON valido (sin markdown):",
    "{",
    '  "text": "resumen de lo que hiciste",',
    '  "actions": [',
    '    { "type": "complete_task", "summary": "que se completo" },',
    '    { "type": "delegate", "toRole": "tester", "instructions": "que debe hacer" },',
    '    { "type": "request_permission", "permission": "run_commands", "reason": "por que" },',
    '    { "type": "report_block", "reason": "que te bloquea", "needs": "que necesitas" },',
    '    { "type": "final_result", "summary": "resultado", "filesTouched": [], "tests": [], "nextActions": [] }',
    "  ],",
    '  "done": false',
    "}",
    "Usa solo las acciones que apliquen. Si no hay acciones, devuelve actions: [].",
  ].join("\n")
}
