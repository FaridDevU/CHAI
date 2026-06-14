import { Coordinator } from "./coordinator"
import { MessageRouter } from "./router"
import type { MessageHandler } from "./router"
import type { Message, OrchestratorAgent, Transport } from "./types"

export interface TeamInput {
  projectName: string
  directory: string
  agents: OrchestratorAgent[]
}

/**
 * Top-level entry point: builds a Coordinator from a team config and exposes the
 * message stream. The app wires a Transport (SDK session prompting) to make it
 * actually drive the agents; without one it still routes and records messages so
 * the Comunicación panel and tests work.
 */
export class Orchestrator {
  readonly coordinator: Coordinator
  readonly router: MessageRouter
  readonly directory: string
  readonly projectName: string

  constructor(team: TeamInput, opts?: { transport?: Transport }) {
    this.router = new MessageRouter()
    this.coordinator = new Coordinator({ router: this.router, transport: opts?.transport })
    this.directory = team.directory
    this.projectName = team.projectName
    for (const agent of team.agents) this.coordinator.register(agent)
  }

  agents(): OrchestratorAgent[] {
    return this.coordinator.list()
  }

  messages(): Message[] {
    return this.router.history()
  }

  onMessage(handler: MessageHandler): () => void {
    return this.router.subscribe(handler)
  }
}
