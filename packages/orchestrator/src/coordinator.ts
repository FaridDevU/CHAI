import { MessageRouter } from "./router"
import {
  COORDINATOR,
  USER,
  type Message,
  type MessageType,
  type OrchestratorAgent,
  type Task,
  type TaskStatus,
  type Transport,
} from "./types"

let taskCounter = 0
function nextTaskId() {
  taskCounter += 1
  return `task_${Date.now().toString(36)}_${taskCounter.toString(36)}`
}

/**
 * The Coordinator owns the team's agents and tasks and relays messages between
 * the user, itself and the agents through the router. When a Transport is set it
 * actually delivers messages to agents (via their sessions) and relays replies;
 * without one it still routes/records everything so the UI works offline.
 */
export class Coordinator {
  readonly router: MessageRouter
  private agents = new Map<string, OrchestratorAgent>()
  private tasks = new Map<string, Task>()
  private transport?: Transport

  constructor(opts?: { router?: MessageRouter; transport?: Transport }) {
    this.router = opts?.router ?? new MessageRouter()
    this.transport = opts?.transport
  }

  setTransport(transport: Transport | undefined) {
    this.transport = transport
  }

  register(agent: OrchestratorAgent) {
    this.agents.set(agent.id, agent)
  }

  unregister(id: string) {
    this.agents.delete(id)
  }

  list(): OrchestratorAgent[] {
    return [...this.agents.values()]
  }

  get(id: string): OrchestratorAgent | undefined {
    return this.agents.get(id)
  }

  setStatus(id: string, status: OrchestratorAgent["status"]) {
    const agent = this.agents.get(id)
    if (agent) agent.status = status
  }

  /** The Coordinador-role agent, or the first registered agent as a fallback. */
  coordinator(): OrchestratorAgent | undefined {
    return this.list().find((a) => a.role === "Coordinador") ?? this.list()[0]
  }

  createTask(input: { title: string; description?: string; assignedTo?: string }): Task {
    const now = Date.now()
    const task: Task = {
      id: nextTaskId(),
      title: input.title,
      description: input.description,
      assignedTo: input.assignedTo,
      status: input.assignedTo ? "assigned" : "pending",
      createdAt: now,
      updatedAt: now,
    }
    this.tasks.set(task.id, task)
    return task
  }

  updateTask(id: string, status: TaskStatus): Task | undefined {
    const task = this.tasks.get(id)
    if (!task) return undefined
    task.status = status
    task.updatedAt = Date.now()
    return task
  }

  listTasks(): Task[] {
    return [...this.tasks.values()]
  }

  /**
   * Send a message to a specific agent and, if a transport is wired, relay the
   * agent's reply back through the router. Returns the reply message when there
   * is one, otherwise the outgoing message.
   */
  async dispatch(
    agentId: string,
    text: string,
    opts?: { from?: string; type?: MessageType; data?: Record<string, unknown> },
  ): Promise<Message | undefined> {
    const agent = this.agents.get(agentId)
    if (!agent) return undefined

    const outgoing = this.router.send({
      from: opts?.from ?? COORDINATOR,
      to: agentId,
      type: opts?.type ?? "pregunta",
      text,
      data: opts?.data,
    })

    if (!this.transport) return outgoing

    this.setStatus(agentId, "working")
    try {
      const reply = await this.transport.deliver(agent, outgoing)
      this.setStatus(agentId, "ready")
      if (!reply) return outgoing
      return this.router.send(reply)
    } catch (err) {
      this.setStatus(agentId, "error")
      return this.router.send({
        from: agentId,
        to: opts?.from ?? COORDINATOR,
        type: "error",
        text: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** Record a user message addressed to the coordinator (the main chat entry). */
  fromUser(text: string): Message {
    return this.router.send({ from: USER, to: COORDINATOR, type: "info", text })
  }
}
