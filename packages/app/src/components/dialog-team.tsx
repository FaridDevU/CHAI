import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Orchestrator, type ClaudeRunEvent, type Message } from "@chai/orchestrator"
import {
  Accounts,
  OPENCODE_PROVIDER,
  PERMISSIONS,
  Teams,
  agentSessionTitle,
  isCliProvider,
  providerLabel,
  roleLabel,
  type TeamAgent,
  type TeamConfig,
} from "@/state/agents"
import { useProviders } from "@/hooks/use-providers"
import { useServerSDK } from "@/context/server-sdk"
import { usePlatform } from "@/context/platform"
import { DialogAccounts } from "@/components/dialog-accounts"
import { createClaudeTransport, createTeamTransport, toOrchestratorAgent } from "@/components/team-orchestrator"
import { showToast } from "@/utils/toast"

type AgentState = { label: string; tone: "ok" | "pending" | "off" }

// A project session that backs one of the team's agents (created at "Iniciar equipo").
export type SessionActivity = { id: string; title: string; updated: number }

function permLabel(id: string) {
  return PERMISSIONS.find((p) => p.id === id)?.label ?? id
}

// A readable one-liner for a streamed claude run event (skips init/unknown).
function claudeEventText(event: ClaudeRunEvent): string | undefined {
  switch (event.type) {
    case "text":
      return event.text.trim() ? `💬 ${event.text.trim()}` : undefined
    case "tool":
      return `🔧 ${event.name}`
    case "retry":
      return `⏳ reintentando (${event.attempt}): ${event.error}`
    case "result":
      return event.isError ? "❌ terminó con error" : `✅ listo${event.costUsd != null ? ` · $${event.costUsd.toFixed(4)}` : ""}`
    default:
      return undefined
  }
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return "ahora mismo"
  const min = Math.floor(diff / 60_000)
  if (min < 60) return `hace ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `hace ${h} h`
  const d = Math.floor(h / 24)
  return `hace ${d} d`
}

// Message types the inter-agent router will carry (for the legend / structure).
const MESSAGE_TYPES = [
  "info",
  "pregunta",
  "respuesta",
  "feedback",
  "error",
  "entrega",
  "revisión",
]

export function DialogTeam(props: { directory?: string; sessions?: () => SessionActivity[] }) {
  const dialog = useDialog()
  const providers = useProviders()
  const serverSDK = useServerSDK()
  const platform = usePlatform()
  const [tab, setTab] = createSignal<"agents" | "comms">("agents")
  const [selectedAgentId, setSelectedAgentId] = createSignal("")
  const [message, setMessage] = createSignal("")
  const [sending, setSending] = createSignal(false)
  const [createdSessions, setCreatedSessions] = createSignal<Record<string, string>>({})
  const [comms, setComms] = createSignal<Message[]>([])
  // Resume continuity for the real claude CLI: accountId -> last session id.
  const [claudeSessions, setClaudeSessions] = createSignal<Record<string, string>>({})
  // Live stream of the running claude agent (tool uses, retries, result).
  const [liveFeed, setLiveFeed] = createSignal<{ label: string; text: string; time: number }[]>([])

  onMount(() => {
    const unsubscribe = platform.onClaudeAgentEvent?.(({ runId, event }) => {
      const text = claudeEventText(event)
      if (!text) return
      // runId is `${accountId}-${base36ts}`; accountId may contain hyphens.
      const accountId = runId.slice(0, runId.lastIndexOf("-"))
      const agent = team()?.agents.find((a) => a.accountId === accountId)
      setLiveFeed((current) => [...current.slice(-100), { label: agent?.account ?? "agente", text, time: Date.now() }])
    })
    if (unsubscribe) onCleanup(unsubscribe)
  })

  // Pull the latest team straight from .chai/team.json (the source of truth).
  createEffect(() => {
    if (props.directory && platform.readProjectFile) void Teams.hydrate(props.directory, platform.readProjectFile)
  })

  const teams = createMemo(() => Teams.list())
  const team = createMemo<TeamConfig | undefined>(() =>
    props.directory ? Teams.get(props.directory) : teams()[0],
  )
  const connectedIds = createMemo(() => new Set(providers.connected().map((p) => p.id)))

  const activity = createMemo(() => [...(props.sessions?.() ?? [])].sort((a, b) => b.updated - a.updated))
  const sessionForAgent = (agent: TeamAgent) =>
    activity().find((s) => s.title === agentSessionTitle(agent))
  const sessionIdForAgent = (agent: TeamAgent) => createdSessions()[agent.accountId] ?? sessionForAgent(agent)?.id

  function agentState(agent: TeamAgent): AgentState {
    // Claude/Kimi connect via their own CLI login, so their readiness is the
    // account status the user confirms (not an opencode connected provider).
    if (isCliProvider(agent.provider)) {
      const acc = Accounts.byId(agent.accountId)
      if (acc?.status === "ready") return { label: "Listo", tone: "ok" }
      if (acc?.status === "pending") return { label: "Pendiente de conexión", tone: "pending" }
      return { label: "No configurado", tone: "off" }
    }
    const opencodeId = OPENCODE_PROVIDER[agent.provider]
    if (opencodeId && connectedIds().has(opencodeId)) return { label: "Listo", tone: "ok" }
    const acc = Accounts.byId(agent.accountId)
    if (acc?.status === "pending") return { label: "Pendiente de conexión", tone: "pending" }
    return { label: "No configurado", tone: "off" }
  }

  function openAccounts() {
    dialog.show(() => <DialogAccounts />)
  }

  function runtimeLabel(agent: TeamAgent) {
    if (!agent.runtime) return "runtime pendiente"
    if (agent.runtime.isolated) return `${agent.runtime.isolation} · ${agent.runtime.profilePath}`
    return `bloqueado · ${agent.runtime.reason}`
  }

  function modelForProvider(providerID: string) {
    const defaults = providers.default() as Record<string, string | undefined>
    const defaultModel = defaults[providerID]
    if (defaultModel) return { providerID, modelID: defaultModel }
    const modelID = Object.keys(providers.all().get(providerID)?.models ?? {})[0]
    return modelID ? { providerID, modelID } : undefined
  }

  async function createSessionForAgent(agent: TeamAgent): Promise<string> {
    const currentTeam = team()
    if (!currentTeam) throw new Error("No hay equipo activo")
    const result = await serverSDK.client.session.create({
      directory: currentTeam.directory,
      title: agentSessionTitle(agent),
    } as Parameters<typeof serverSDK.client.session.create>[0])
    const session = "data" in result ? result.data : result
    if (!session?.id) throw new Error(`No se pudo crear la sesión de ${agent.account}`)
    setCreatedSessions((current) => ({ ...current, [agent.accountId]: session.id }))
    return session.id
  }

  async function sendToAgent() {
    const currentTeam = team()
    if (!currentTeam || sending()) return
    const text = message().trim()
    if (!text) return

    const targetId = selectedAgentId() || currentTeam.agents[0]?.accountId
    const target = currentTeam.agents.find((agent) => agent.accountId === targetId)
    if (!target) return

    // Claude/Kimi agents run as their real CLI (desktop only); others use the
    // opencode-session transport.
    const useClaude = isCliProvider(target.provider)
    if (useClaude && !platform.runClaudeAgent) {
      showToast({ title: "El runner de CLI (Claude/Kimi) requiere la app de escritorio." })
      return
    }

    setSelectedAgentId(target.accountId)
    setSending(true)
    try {
      const byAccountId = (accountId: string) => currentTeam.agents.find((agent) => agent.accountId === accountId)
      const transport =
        useClaude && platform.runClaudeAgent
          ? createClaudeTransport({
              directory: currentTeam.directory,
              runClaudeAgent: platform.runClaudeAgent,
              byAccountId,
              sessionForAgent: (agent) => claudeSessions()[agent.accountId],
              onSession: (agent, sessionId) =>
                setClaudeSessions((current) => ({ ...current, [agent.accountId]: sessionId })),
            })
          : createTeamTransport({
              serverSDK,
              directory: currentTeam.directory,
              sessionForAgent: sessionIdForAgent,
              createSessionForAgent,
              byAccountId,
              modelForProvider,
            })
      const orchestrator = new Orchestrator(
        {
          projectName: currentTeam.projectName,
          directory: currentTeam.directory,
          agents: currentTeam.agents.map((agent, index) => toOrchestratorAgent(agent, index, sessionIdForAgent(agent))),
        },
        { transport },
      )
      await orchestrator.coordinator.dispatch(target.accountId, text, { from: "user", type: "pregunta" })
      setComms((current) => [...current, ...orchestrator.messages()])
      setMessage("")
    } catch (err) {
      showToast({
        title: "No se pudo enviar al agente",
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog title="Equipo del proyecto" class="w-full max-w-[600px] mx-auto">
      <div class="flex flex-col gap-4 p-6 pt-0">
        <Show
          when={team()}
          fallback={
            <div class="flex flex-col items-center gap-3 rounded-md border border-border-weak-base px-4 py-10 text-center">
              <div class="text-13-medium text-text-strong">Aún no hay un equipo configurado</div>
              <div class="text-12-regular text-text-weak">
                Crea un proyecto con "Nuevo proyecto" y elige tus agentes para formar un equipo.
              </div>
            </div>
          }
        >
          {(t) => (
            <>
              <div class="flex items-center justify-between">
                <div class="flex flex-col min-w-0">
                  <span class="text-14-medium text-text-strong truncate">{t().projectName}</span>
                  <span class="text-11-regular text-text-weak truncate">{t().directory}</span>
                </div>
                <span class="text-11-medium text-text-weak shrink-0">
                  {t().agents.length} {t().agents.length === 1 ? "agente" : "agentes"} ·{" "}
                  {t().roleMode === "manual" ? "roles manuales" : t().roleMode === "auto" ? "roles automáticos" : "roles híbridos"}
                </span>
              </div>

              {/* tabs */}
              <div class="flex gap-1.5 border-b border-border-weak-base">
                <button
                  type="button"
                  classList={{
                    "px-3 py-2 text-12-medium border-b-2 -mb-px transition-colors": true,
                    "border-icon-strong-base text-text-strong": tab() === "agents",
                    "border-transparent text-text-weak hover:text-text-strong": tab() !== "agents",
                  }}
                  onClick={() => setTab("agents")}
                >
                  Agentes
                </button>
                <button
                  type="button"
                  classList={{
                    "px-3 py-2 text-12-medium border-b-2 -mb-px transition-colors": true,
                    "border-icon-strong-base text-text-strong": tab() === "comms",
                    "border-transparent text-text-weak hover:text-text-strong": tab() !== "comms",
                  }}
                  onClick={() => setTab("comms")}
                >
                  Comunicación
                </button>
              </div>

              {/* AGENTS tab */}
              <Show when={tab() === "agents"}>
                <div class="flex flex-col gap-2">
                  <For each={t().agents}>
                    {(agent, i) => {
                      const st = agentState(agent)
                      return (
                        <div class="flex flex-col gap-2 rounded-md border border-border-weak-base p-3">
                          <div class="flex items-center justify-between">
                            <div class="flex items-center gap-2 min-w-0">
                              <span class="text-13-medium text-text-strong truncate">{agent.account}</span>
                              <Show when={i() === 0}>
                                <span class="text-10-medium px-1.5 py-0.5 rounded bg-surface-base-hover text-text-weak">
                                  coordinador
                                </span>
                              </Show>
                            </div>
                            <span
                              classList={{
                                "text-11-medium px-2 py-0.5 rounded-full": true,
                                "text-icon-success-base bg-surface-success-base/20": st.tone === "ok",
                                "text-text-strong bg-surface-base-hover": st.tone === "pending",
                                "text-text-weak bg-surface-base-hover": st.tone === "off",
                              }}
                            >
                              {st.label}
                            </span>
                          </div>
                          <div class="flex items-center gap-2 text-11-regular text-text-weak">
                            <span>{providerLabel(agent.provider)}</span>
                            <span>·</span>
                            <span>{roleLabel(agent.role)}</span>
                            <span>-</span>
                            <span class="truncate">{runtimeLabel(agent)}</span>
                            <Show when={sessionForAgent(agent)}>
                              {(s) => (
                                <>
                                  <span>·</span>
                                  <span class="text-icon-success-base">sesión activa · {relativeTime(s().updated)}</span>
                                </>
                              )}
                            </Show>
                          </div>
                          <div class="flex flex-wrap gap-1">
                            <For each={agent.permissions}>
                              {(p) => (
                                <span class="text-10-regular px-1.5 py-0.5 rounded bg-surface-base-hover text-text-weak">
                                  {permLabel(p)}
                                </span>
                              )}
                            </For>
                          </div>
                        </div>
                      )
                    }}
                  </For>
                  <Button type="button" variant="ghost" size="large" onClick={openAccounts}>
                    Gestionar cuentas
                  </Button>
                </div>
              </Show>

              {/* COMMS tab */}
              <Show when={tab() === "comms"}>
                <div class="flex flex-col gap-3">
                  <div class="flex flex-col gap-2 rounded-md border border-border-weak-base p-3">
                    <div class="flex flex-col gap-1.5">
                      <span class="text-11-medium text-text-weak">Enviar a agente</span>
                      <select
                        class="rounded-md border border-border-weak-base bg-transparent px-2 py-1.5 text-12-regular text-text-strong"
                        value={selectedAgentId() || t().agents[0]?.accountId}
                        onChange={(event) => setSelectedAgentId(event.currentTarget.value)}
                      >
                        <For each={t().agents}>
                          {(agent) => (
                            <option value={agent.accountId}>
                              {agent.account} - {roleLabel(agent.role)}
                            </option>
                          )}
                        </For>
                      </select>
                    </div>
                    <textarea
                      class="min-h-20 resize-y rounded-md border border-border-weak-base bg-transparent px-3 py-2 text-12-regular text-text-strong outline-none focus:border-border-strong"
                      value={message()}
                      onInput={(event) => setMessage(event.currentTarget.value)}
                      placeholder="Mensaje para probar el router del equipo"
                    />
                    <div class="flex items-center justify-between gap-2">
                      <span class="text-11-regular text-text-weak">
                        Usa la cuenta seleccionada, su runtime y su sesión del proyecto.
                      </span>
                      <Button
                        type="button"
                        variant="primary"
                        size="small"
                        onClick={sendToAgent}
                        disabled={sending() || !message().trim()}
                      >
                        {sending() ? "Enviando..." : "Enviar"}
                      </Button>
                    </div>
                  </div>

                  <Show when={comms().length > 0}>
                    <div class="flex flex-col gap-1.5">
                      <span class="text-11-medium text-text-weak">Router CHAI</span>
                      <div class="flex max-h-48 flex-col gap-1 overflow-auto rounded-md border border-border-weak-base p-2">
                        <For each={comms()}>
                          {(item) => (
                            <div class="rounded border border-border-weak-base px-2 py-1.5">
                              <div class="text-10-medium text-text-weak">
                                {item.from} {"->"} {item.to} - {item.type}
                              </div>
                              <div class="text-12-regular text-text-strong whitespace-pre-wrap">{item.text}</div>
                            </div>
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>

                  <Show when={liveFeed().length > 0}>
                    <div class="flex flex-col gap-1.5">
                      <span class="text-11-medium text-text-weak">Eventos en vivo</span>
                      <div class="flex max-h-48 flex-col gap-1 overflow-auto rounded-md border border-border-weak-base p-2">
                        <For each={liveFeed()}>
                          {(item) => (
                            <div class="flex items-baseline gap-2">
                              <span class="text-10-medium text-text-weak shrink-0">{item.label}</span>
                              <span class="text-12-regular text-text-strong whitespace-pre-wrap">{item.text}</span>
                            </div>
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>

                  {/* Real activity feed: the project's agent sessions, most recent first. */}
                  <div class="flex flex-col gap-1.5">
                    <span class="text-11-medium text-text-weak">Actividad de los agentes</span>
                    <Show
                      when={activity().length > 0}
                      fallback={
                        <div class="rounded-md border border-border-weak-base px-4 py-8 text-center">
                          <div class="text-13-medium text-text-strong">Todavia no hay actividad</div>
                          <div class="text-12-regular text-text-weak mt-1">
                            Inicia el equipo para abrir una sesión por agente. Aquí aparecerá su actividad.
                          </div>
                        </div>
                      }
                    >
                      <div class="flex flex-col gap-1">
                        <For each={activity()}>
                          {(s) => (
                            <div class="flex items-center justify-between rounded-md border border-border-weak-base px-3 py-2">
                              <span class="text-12-regular text-text-strong truncate">{s.title}</span>
                              <span class="text-11-regular text-text-weak shrink-0">{relativeTime(s.updated)}</span>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>

                  <div class="flex flex-col gap-1.5">
                    <span class="text-11-medium text-text-weak">Tipos de mensaje del router</span>
                    <div class="flex flex-wrap gap-1.5">
                      <For each={MESSAGE_TYPES}>
                        {(m) => (
                          <span class="text-10-medium px-2 py-0.5 rounded-full border border-border-weak-base text-text-weak">
                            {m}
                          </span>
                        )}
                      </For>
                    </div>
                  </div>
                </div>
              </Show>
            </>
          )}
        </Show>

        <div class="flex justify-end">
          <Button type="button" variant="primary" size="large" onClick={() => dialog.close()}>
            Cerrar
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
