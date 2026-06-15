import { Orchestrator, type MessageInput, type OrchestratorAgent, type Transport } from "@chai/orchestrator"
import { Identifier } from "@/utils/id"
import { OPENCODE_PROVIDER, roleLabel, type TeamAgent, type TeamConfig } from "@/state/agents"
import type { ServerSDK } from "@/context/server-sdk"

export function toOrchestratorAgent(agent: TeamAgent, index: number, sessionId?: string): OrchestratorAgent {
  return {
    id: agent.accountId,
    accountId: agent.accountId,
    provider: agent.provider,
    account: agent.account,
    role: agent.role,
    permissions: agent.permissions as OrchestratorAgent["permissions"],
    runtime: agent.runtime,
    sessionId,
    status: "ready",
  }
}

async function activateAccount(serverSDK: ServerSDK, providerID: string, accountKey: string) {
  const base = serverSDK.url.replace(/\/+$/, "")
  const headers: Record<string, string> = {}
  const server = serverSDK.scope
  void server

  const response = await fetch(
    `${base}/provider/${encodeURIComponent(providerID)}/account/${encodeURIComponent(accountKey)}/activate`,
    { method: "POST", headers },
  )
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(text || `No se pudo activar la cuenta ${accountKey}`)
  }
}

export function createTeamTransport(input: {
  serverSDK: ServerSDK
  directory: string
  sessionForAgent: (agent: TeamAgent) => string | undefined
  createSessionForAgent: (agent: TeamAgent) => Promise<string>
  byAccountId: (accountId: string) => TeamAgent | undefined
  modelForProvider: (providerID: string) => { providerID: string; modelID: string } | undefined
}): Transport {
  return {
    async deliver(agent, message, runtime): Promise<MessageInput> {
      const teamAgent = input.byAccountId(agent.accountId)
      if (!teamAgent) throw new Error(`No se encontró el agente ${agent.account}`)

      const providerID = OPENCODE_PROVIDER[teamAgent.provider]
      if (!providerID) throw new Error(`Proveedor ${teamAgent.provider} no tiene adaptador conectado`)

      await activateAccount(input.serverSDK, providerID, teamAgent.accountId)

      const model = input.modelForProvider(providerID)
      if (!model) throw new Error(`No hay modelo disponible para ${providerID}`)

      const sessionID = input.sessionForAgent(teamAgent) ?? (await input.createSessionForAgent(teamAgent))
      const role = teamAgent.role === "auto" ? "Agente" : roleLabel(teamAgent.role)
      const text = [
        `[CHAI -> ${teamAgent.account}]`,
        `Rol: ${role}`,
        `Cuenta: ${teamAgent.accountId}`,
        `Runtime: ${runtime.profilePath}`,
        "",
        message.text,
      ].join("\n")

      await input.serverSDK.client.session.promptAsync({
        sessionID,
        agent: "general",
        model,
        messageID: Identifier.ascending("message"),
        parts: [{ type: "text", text }],
      })

      return {
        from: agent.id,
        to: message.from,
        type: "respuesta",
        text: `Enviado a ${teamAgent.account}`,
        data: { sessionID, runtime: runtime.profilePath },
      }
    },
  }
}

export function createTeamOrchestrator(input: ConstructorParameters<typeof Orchestrator>[0], transport: Transport) {
  return new Orchestrator(input, { transport })
}
