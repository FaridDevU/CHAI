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

// The account-activate route isn't in the generated SDK yet, so this is a hand
// -rolled request. It still reuses the SDK's auth headers and the directory
// workspace-routing query so it hits the right instance with the right
// credentials (the server trusts the loopback sidecar; auth gates remote use).
async function activateAccount(serverSDK: ServerSDK, directory: string, providerID: string, accountKey: string) {
  const base = serverSDK.url.replace(/\/+$/, "")
  const url =
    `${base}/provider/${encodeURIComponent(providerID)}/account/${encodeURIComponent(accountKey)}/activate` +
    `?directory=${encodeURIComponent(directory)}`

  const response = await fetch(url, {
    method: "POST",
    headers: { ...serverSDK.authHeaders, "x-opencode-directory": encodeURIComponent(directory) },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(text || `No se pudo activar la cuenta ${accountKey} (HTTP ${response.status})`)
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

      await activateAccount(input.serverSDK, input.directory, providerID, teamAgent.accountId)

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
