import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { type ClaudeRunEvent, type Message } from "@chai/orchestrator"
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
import { getProjectTeamRuntime } from "@/state/team-runtime"
import { showToast } from "@/utils/toast"

type AgentState = { label: string; tone: "ok" | "pending" | "off" }
const runtimeStateLabel = {
  ready: "Listo",
  working: "Trabajando",
  waiting: "Esperando",
  error: "Error",
  timeout: "Tiempo agotado",
  offline: "Desconectado",
} as const


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

export function DialogTeam(props: { directory?: string; sessions?: () => SessionActivity[]; autoStart?: boolean }) {
  const dialog = useDialog()
  const providers = useProviders()
  const serverSDK = useServerSDK()
  const platform = usePlatform()
  const [tab, setTab] = createSignal<"agents" | "comms">(props.autoStart ? "comms" : "agents")
  const [selectedAgentId, setSelectedAgentId] = createSignal("")
  const [message, setMessage] = createSignal("")
  const [sending, setSending] = createSignal(false)
  // After the debate ends, the user chooses: "choose" shows agree/adjust; "work"
  // and "adjust" both open the team chat (the difference is just the entry point).
  const [commsMode, setCommsMode] = createSignal<"choose" | "adjust" | "work">("choose")
  // Who the chat message is addressed to — only that agent answers. Defaults to
  // the coordinator (resolved lazily, since `team()` isn't defined yet here).
  const [chatTarget, setChatTarget] = createSignal("")
  const [createdSessions, setCreatedSessions] = createSignal<Record<string, string>>({})
  // Live stream of the running claude agent (tool uses, retries, result).
  const [liveFeed, setLiveFeed] = createSignal<{ label: string; text: string; time: number }[]>([])
  // When opened from the generic "Equipo" entry (no directory), the user first
  // picks a project from the list; that choice lives here. The team we show is
  // the directory passed in, or the picked one.
  const [pickedDir, setPickedDir] = createSignal(props.directory ?? "")
  const effectiveDir = createMemo(() => props.directory ?? (pickedDir() || undefined))

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

  // When opened right after "Iniciar equipo": run onboarding once so the user can
  // watch the agents introduce themselves and CHAI hand out the roles, instead of
  // landing in a chat. Guarded so it never re-fires or spends tokens on reopen.
  onMount(() => {
    if (!props.autoStart) return
    queueMicrotask(() => {
      const rt = runtime()
      if (!rt) return
      if (rt.teamProfile() || rt.runState() !== "idle") return
      if ((team()?.agents.length ?? 0) === 0) return
      void runOnboarding()
    })
  })

  // Pull the latest team straight from .chai/team.json (the source of truth).
  createEffect(() => {
    const dir = effectiveDir()
    if (dir && platform.readProjectFile) void Teams.hydrate(dir, platform.readProjectFile)
  })

  const teams = createMemo(() => Teams.list())
  const team = createMemo<TeamConfig | undefined>(() => {
    const dir = effectiveDir()
    return dir ? Teams.get(dir) : undefined
  })
  // The coordinator is who the user talks to by default (there is always one in a
  // 2+ agent team); falls back to the first agent.
  const coordinatorId = createMemo(
    () => team()?.agents.find((a) => a.role === "coordinator")?.accountId ?? team()?.agents[0]?.accountId ?? "",
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
    const title = agentSessionTitle(agent)

    // Reuse an existing session with this agent's title before creating a new
    // one, so re-onboarding / reopening / a stale cache never spawns duplicate
    // agent sessions. This is the dedup backstop on top of the runtime's record.
    try {
      const listed = await serverSDK.client.session.list({
        directory: currentTeam.directory,
      } as Parameters<typeof serverSDK.client.session.list>[0])
      const items = (Array.isArray(listed) ? listed : (listed as { data?: unknown }).data) as
        | { id?: string; title?: string }[]
        | undefined
      const existing = items?.find((s) => s.title === title && !!s.id)
      if (existing?.id) {
        setCreatedSessions((current) => ({ ...current, [agent.accountId]: existing.id! }))
        return existing.id
      }
    } catch {
      // listing failed — fall through and create a fresh session
    }

    const result = await serverSDK.client.session.create({
      directory: currentTeam.directory,
      title,
    } as Parameters<typeof serverSDK.client.session.create>[0])
    const session = "data" in result ? result.data : result
    if (!session?.id) throw new Error(`No se pudo crear la sesión de ${agent.account}`)
    setCreatedSessions((current) => ({ ...current, [agent.accountId]: session.id }))
    return session.id
  }

  const runtime = createMemo(() => {
    const currentTeam = team()
    if (!currentTeam) return
    return getProjectTeamRuntime(currentTeam, {
      serverSDK,
      runClaudeAgent: platform.runClaudeAgent,
      cancelClaudeAgent: platform.cancelClaudeAgent,
      sessionForAgent: sessionIdForAgent,
      createSessionForAgent,
      modelForProvider,
      readProjectFile: platform.readProjectFile,
      writeProjectFile: platform.writeProjectFile,
      appendProjectFile: platform.appendProjectFile,
      onTeamUpdated: Teams.save,
    })
  })

  const comms = createMemo(() => runtime()?.messages() ?? [])
  // Hide CHAI's internal instruction prompts for the role discussion — only the
  // agents' own messages should show, so the conversation reads naturally.
  const visibleComms = createMemo(() =>
    comms().filter((m) => {
      const data = m.data as Record<string, unknown> | undefined
      // Hide CHAI's internal prompts: the role-debate questions and the post-delegation
      // wrap-up re-prompt. Their replies still show.
      return !(m.type === "pregunta" && (Boolean(data?.discussion) || Boolean(data?.internal)))
    }),
  )
  const runtimeStates = createMemo(() => runtime()?.agentStates() ?? {})
  const runState = createMemo(() => runtime()?.runState() ?? "idle")
  const teamProfile = createMemo(() => runtime()?.teamProfile())
  // Each freshly settled debate brings the user back to the agree/adjust choice.
  createEffect(() => {
    teamProfile()?.generatedAt
    setCommsMode("choose")
  })
  const synthesis = createMemo(() => runtime()?.synthesis())
  const permissionRequests = createMemo(() => runtime()?.permissionRequests() ?? [])

  function agentLabel(accountId?: string) {
    if (!accountId) return "Sin asignar"
    const agent = team()?.agents.find((a) => a.accountId === accountId)
    return agent ? `${agent.account} · ${roleLabel(agent.role)}` : accountId
  }

  // ---- Humanize the inter-agent conversation -------------------------------
  // The wire protocol is JSON, but people shouldn't read JSON. These turn each
  // router message into a plain chat line ("Kimi 1: Hola, puedo…").
  function speakerName(id: string) {
    if (id === "user") return "Tú"
    if (id === "coordinator") return "CHAI"
    return team()?.agents.find((a) => a.accountId === id)?.account ?? id
  }

  // Terminal colors per agent: Kimi morado, Codex celeste, Claude naranja.
  function speakerColor(id: string): string {
    if (id === "user") return "#9ca3af"
    if (id === "coordinator") return "#34d399" // CHAI = verde
    const provider = team()?.agents.find((a) => a.accountId === id)?.provider
    if (provider === "kimi") return "#a855f7"
    if (provider === "codex") return "#38bdf8"
    if (provider === "claude") return "#fb923c"
    return "#e5e7eb"
  }

  function friendlyFromJson(text: string): string | undefined {
    const block =
      text.match(/```json\s*([\s\S]*?)```/i)?.[1] ?? text.match(/```\s*([\s\S]*?)```/)?.[1] ?? text
    const tryParse = (s: string): Record<string, unknown> | undefined => {
      try {
        const v = JSON.parse(s)
        return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
      } catch {
        return undefined
      }
    }
    let obj = tryParse(block.trim())
    if (!obj) {
      const start = block.indexOf("{")
      const end = block.lastIndexOf("}")
      if (start >= 0 && end > start) obj = tryParse(block.slice(start, end + 1))
    }
    if (!obj) return undefined
    const data = obj
    const arr = (k: string) =>
      Array.isArray(data[k]) ? (data[k] as unknown[]).filter((x): x is string => typeof x === "string") : []
    const str = (k: string) => (typeof data[k] === "string" ? (data[k] as string).trim() : "")
    const lines: string[] = []
    if (str("text")) lines.push(str("text"))
    if (str("summary") && str("summary") !== str("text")) lines.push(str("summary"))
    if (arr("capabilities").length) lines.push("💪 Puedo: " + arr("capabilities").join(", "))
    if (arr("bestTasks").length) lines.push("✅ Mejor para: " + arr("bestTasks").join(", "))
    if (arr("limits").length) lines.push("⚠️ Límites: " + arr("limits").join(", "))
    if (str("recommendedRole")) lines.push("🎯 Rol que me queda: " + roleLabel(str("recommendedRole")))
    if (Array.isArray(data.actions)) {
      for (const raw of data.actions as unknown[]) {
        if (!raw || typeof raw !== "object") continue
        const a = raw as Record<string, unknown>
        const summary = typeof a.summary === "string" ? a.summary : ""
        const reason = typeof a.reason === "string" ? a.reason : ""
        if (a.type === "final_result" && summary) lines.push("✔️ " + summary)
        else if (a.type === "complete_task") lines.push("✔️ Tarea terminada" + (summary ? ": " + summary : ""))
        else if (a.type === "delegate" && typeof a.instructions === "string") lines.push("🤝 Delego: " + a.instructions)
        else if (a.type === "set_role" && typeof a.role === "string")
          lines.push("🔄 Rol: " + (typeof a.toAgent === "string" ? a.toAgent + " → " : "") + roleLabel(a.role))
        else if (a.type === "request_permission" && typeof a.permission === "string")
          lines.push("🔐 Pido permiso: " + a.permission + (reason ? " (" + reason + ")" : ""))
        else if (a.type === "report_block") lines.push("🚧 Bloqueado: " + reason)
      }
    }
    return lines.length ? lines.join("\n") : undefined
  }

  function stripJsonInstructions(text: string): string {
    let t = text
    for (const marker of ["Responde SOLO con JSON", "Cuando termines tu turno responde SOLO", "Divide la siguiente solicitud"]) {
      const i = t.indexOf(marker)
      if (i >= 0) t = t.slice(0, i)
    }
    // Hide the internal "ROL: <id>" commitment marker agents append during the role debate.
    t = t.replace(/(^|\n)\s*ROL:\s*[a-z_]+\s*(?=\n|$)/gi, "")
    return t.trim() || text.trim()
  }

  type ChatLine = { speaker: string; body: string; kind: "chai" | "agent" | "error" | "you" }
  function chatLine(item: Message): ChatLine {
    const speaker = speakerName(item.from)
    const kind: ChatLine["kind"] =
      item.type === "error" ? "error" : item.from === "user" ? "you" : item.from === "coordinator" ? "chai" : "agent"
    if (item.type === "error") {
      const raw = (item.text ?? "").trim()
      const authish = /unauthor|401|403|\blogin\b|sign in|inicia sesi|token|api key|not authenticated|credential|api error/i.test(raw)
      const hint = authish ? " (parece que la cuenta no está conectada: ve a Cuentas y completa el login)" : ""
      const detail = raw ? raw.slice(0, 240) : ""
      return {
        speaker,
        kind,
        body: detail ? `No pudo responder: ${detail}${hint}` : "No pudo responder (revisa su conexión o inicio de sesión).",
      }
    }
    // A clean human-facing version set by the runtime (e.g. the user's own text, or
    // an agent's delegation ask) — shown instead of the wrapped prompt we delivered.
    const display = (item.data as Record<string, unknown> | undefined)?.display
    if (typeof display === "string" && display.trim()) return { speaker, kind, body: display.trim() }
    if (item.data?.onboarding && (item.from === "coordinator" || item.from === "user")) {
      return { speaker: "CHAI", kind: "chai", body: "Preséntate: ¿cuáles son tus fortalezas, tus límites y qué rol te queda mejor?" }
    }
    // A question/prompt carries a JSON *schema example* (e.g. {"recommendedRole":"<id>"}).
    // Never parse it as if it were a real reply — show its human text, stripped of
    // the "Responde SOLO con JSON…" tail. Only replies (respuesta/entrega/…) get humanized.
    if (item.type === "pregunta") {
      return { speaker, kind, body: stripJsonInstructions(item.text) }
    }
    const friendly = friendlyFromJson(item.text)
    if (friendly) return { speaker, kind, body: friendly }
    return { speaker, kind, body: stripJsonInstructions(item.text) }
  }

  async function sendToAgent() {
    const currentTeam = team()
    if (!currentTeam || sending()) return
    const text = message().trim()
    if (!text) return

    const targetId = selectedAgentId() || currentTeam.agents[0]?.accountId
    const target = currentTeam.agents.find((agent) => agent.accountId === targetId)
    if (!target) return

    if (isCliProvider(target.provider) && !platform.runClaudeAgent) {
      showToast({ title: "El runner de CLI (Claude/Kimi) requiere la app de escritorio." })
      return
    }

    setSelectedAgentId(target.accountId)
    setSending(true)
    try {
      await runtime()?.sendToAgent(target.accountId, text)
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

  async function sendToTeam() {
    const currentTeam = team()
    if (!currentTeam || sending()) return
    const text = message().trim()
    if (!text) return
    if (currentTeam.agents.some((agent) => isCliProvider(agent.provider)) && !platform.runClaudeAgent) {
      showToast({ title: "Los agentes Claude/Kimi requieren la app de escritorio." })
      return
    }

    setSending(true)
    try {
      await runtime()?.sendToTeam(text)
      setMessage("")
    } catch (err) {
      showToast({
        title: "No se pudo enviar al equipo",
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setSending(false)
    }
  }

  // The chat box only appears once the debate has settled. The message goes to the
  // single agent picked in the recipient selector (the coordinator by default), so
  // only that agent answers — addressed back to the user ("→ Tú"). It shows in the
  // shared feed, so the rest of the team sees it too.
  async function sendComms() {
    const text = message().trim()
    if (!text || sending()) return
    const currentTeam = team()
    if (!currentTeam) return
    const targetId = chatTarget() || coordinatorId()
    const target = currentTeam.agents.find((agent) => agent.accountId === targetId)
    if (!target) return
    if (isCliProvider(target.provider) && !platform.runClaudeAgent) {
      showToast({ title: "El runner de CLI (Claude/Kimi) requiere la app de escritorio." })
      return
    }
    setSending(true)
    try {
      await runtime()?.sendToAgent(target.accountId, text)
      setMessage("")
    } catch (err) {
      showToast({
        title: "No se pudo enviar el mensaje",
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setSending(false)
    }
  }

  function pauseTeam() {
    runtime()?.pause()
  }

  function resumeTeam() {
    runtime()?.resume()
  }

  async function cancelTeam() {
    try {
      await runtime()?.cancelActiveRuns()
    } catch (err) {
      showToast({
        title: "No se pudo cancelar el equipo",
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async function runOnboarding() {
    try {
      await runtime()?.runOnboarding()
    } catch (err) {
      showToast({
        title: "No se pudo completar el onboarding",
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <Dialog title="Equipo del proyecto" size="large" class="w-full max-w-[600px] mx-auto">
      <div class="flex flex-col gap-4 p-6 pt-0 flex-1 min-h-0">
        <Show
          when={effectiveDir()}
          fallback={
            <Show
              when={teams().length > 0}
              fallback={
                <div class="flex flex-col items-center gap-3 rounded-md border border-border-weak-base px-4 py-10 text-center">
                  <div class="text-13-medium text-text-strong">Aún no hay un equipo configurado</div>
                  <div class="text-12-regular text-text-weak">
                    Crea un proyecto con "Nuevo proyecto" y elige tus agentes para formar un equipo.
                  </div>
                </div>
              }
            >
              {/* Project picker: one entry per project that has a team. */}
              <div class="flex flex-col gap-2">
                <span class="text-12-medium text-text-weak">Elige un proyecto para ver y gestionar su equipo</span>
                <For each={teams()}>
                  {(tc) => (
                    <div class="flex items-center gap-2 rounded-md border border-border-weak-base px-3 py-2.5 transition-colors hover:border-border-strong">
                      <button
                        type="button"
                        class="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
                        onClick={() => setPickedDir(tc.directory)}
                      >
                        <div class="flex min-w-0 flex-col">
                          <span class="text-13-medium text-text-strong truncate">{tc.projectName}</span>
                          <span class="text-11-regular text-text-weak truncate">{tc.directory}</span>
                        </div>
                        <span class="shrink-0 text-11-medium text-text-weak">
                          {tc.agents.length} {tc.agents.length === 1 ? "agente" : "agentes"}
                        </span>
                      </button>
                      <button
                        type="button"
                        class="shrink-0 rounded px-2 py-1 text-11-medium text-text-weak hover:text-icon-error-base"
                        title="Quitar este equipo de la lista"
                        onClick={() => Teams.remove(tc.directory)}
                      >
                        Quitar
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          }
        >
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
                <div class="flex items-center gap-2 min-w-0">
                  <Show when={!props.directory}>
                    <button
                      type="button"
                      class="shrink-0 rounded-md border border-border-weak-base px-2 py-1 text-11-medium text-text-weak hover:text-text-strong"
                      onClick={() => setPickedDir("")}
                      title="Volver a proyectos"
                    >
                      ← Proyectos
                    </button>
                  </Show>
                  <div class="flex flex-col min-w-0">
                    <span class="text-14-medium text-text-strong truncate">{t().projectName}</span>
                    <span class="text-11-regular text-text-weak truncate">{t().directory}</span>
                  </div>
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

              {/* scrollable tab body so long timelines/boards stay reachable */}
              <div class="flex flex-col gap-4 overflow-y-auto flex-1 min-h-0 pr-1 -mr-1">
              {/* AGENTS tab */}
              <Show when={tab() === "agents"}>
                <div class="flex flex-col gap-2">
                  <For each={t().agents}>
                    {(agent, i) => {
                      const runtimeState = runtimeStates()[agent.accountId]
                      const st =
                        runtimeState === "working"
                          ? { label: runtimeStateLabel.working, tone: "pending" as const }
                          : runtimeState === "waiting"
                            ? { label: runtimeStateLabel.waiting, tone: "pending" as const }
                            : runtimeState === "error"
                              ? { label: runtimeStateLabel.error, tone: "off" as const }
                              : agentState(agent)
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
                          <div class="flex items-center justify-between gap-2">
                            <div class="flex flex-wrap gap-1">
                              <For each={agent.permissions}>
                                {(p) => (
                                  <span class="text-10-regular px-1.5 py-0.5 rounded bg-surface-base-hover text-text-weak">
                                    {permLabel(p)}
                                  </span>
                                )}
                              </For>
                            </div>
                            <Show when={runtimeState === "error" || runtimeState === "timeout" || runtimeState === "offline"}>
                              <button
                                type="button"
                                class="shrink-0 text-10-medium px-2 py-0.5 rounded border border-border-weak-base text-text-weak hover:text-text-strong"
                                onClick={() => runtime()?.reconnectAgent(agent.accountId)}
                              >
                                Reconectar
                              </button>
                            </Show>
                          </div>
                        </div>
                      )
                    }}
                  </For>
                  <Button type="button" variant="ghost" size="large" onClick={openAccounts}>
                    Gestionar cuentas
                  </Button>

                  {/* Team controls live here; the Comunicación tab is just the chat. */}
                  <div class="flex flex-col gap-2 rounded-md border border-border-weak-base p-3">
                    <div class="flex items-center justify-between gap-2">
                      <span class="rounded bg-surface-base-hover px-1.5 py-0.5 text-10-medium text-text-weak">
                        {runState()}
                      </span>
                      <div class="flex items-center gap-1.5">
                        <Button
                          type="button"
                          variant="secondary"
                          size="small"
                          onClick={runOnboarding}
                          disabled={runState() !== "idle"}
                        >
                          Onboarding
                        </Button>
                        <Show
                          when={runState() === "paused"}
                          fallback={
                            <Button
                              type="button"
                              variant="ghost"
                              size="small"
                              onClick={pauseTeam}
                              disabled={runState() !== "running"}
                            >
                              Pausar
                            </Button>
                          }
                        >
                          <Button type="button" variant="secondary" size="small" onClick={resumeTeam}>
                            Reanudar
                          </Button>
                        </Show>
                        <Button
                          type="button"
                          variant="ghost"
                          size="small"
                          onClick={cancelTeam}
                          disabled={runState() !== "running" && runState() !== "paused"}
                        >
                          Cancelar
                        </Button>
                      </div>
                    </div>
                    <div class="flex flex-col gap-1.5">
                      <span class="text-11-medium text-text-weak">Agente directo</span>
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
                      placeholder="Mensaje para el equipo"
                    />
                    <div class="flex items-center justify-between gap-2">
                      <span class="text-11-regular text-text-weak">
                        Mira la conversación en la pestaña Comunicación.
                      </span>
                      <div class="flex items-center gap-1.5">
                        <Button
                          type="button"
                          variant="secondary"
                          size="small"
                          onClick={sendToAgent}
                          disabled={sending() || !message().trim()}
                        >
                          Enviar al agente
                        </Button>
                        <Button
                          type="button"
                          variant="primary"
                          size="small"
                          onClick={sendToTeam}
                          disabled={sending() || !message().trim()}
                        >
                          {sending() ? "Enviando..." : "Enviar al equipo"}
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              </Show>

              {/* COMMS tab */}
              <Show when={tab() === "comms"}>
                <div class="flex flex-col gap-3">
                  {/* The two IAs talking — a colored terminal (Kimi morado, Codex
                      celeste, Claude naranja, CHAI verde) */}
                  <div class="flex flex-col gap-1.5">
                    <div class="flex items-center justify-between">
                      <span class="text-11-medium text-text-weak">Conversación</span>
                      <Show when={runState() === "running"}>
                        <span class="text-10-medium text-text-weak">en curso…</span>
                      </Show>
                    </div>
                    <div
                      class="overflow-y-auto overscroll-contain rounded-md border border-border-weak-base p-3 font-mono text-12-regular h-[260px] min-h-[160px]"
                      style={{ background: "#0b0e14" }}
                    >
                      <Show
                        when={visibleComms().length > 0}
                        fallback={
                          <div class="py-6 text-center text-11-regular" style={{ color: "#6b7280" }}>
                            {runState() === "running"
                              ? "Los agentes están respondiendo…"
                              : "Pulsa Onboarding y míralos presentarse y repartirse los roles, o envía un mensaje al equipo."}
                          </div>
                        }
                      >
                        <For each={visibleComms()}>
                          {(item) => {
                            const line = chatLine(item)
                            return (
                              <div class="border-b border-[#1a2130] py-2.5 first:pt-0 last:border-b-0">
                                {/* A quién va dirigido el mensaje (estilo "respondiendo a"):
                                    se ve atenuado arriba quién habla y a quién. */}
                                <div class="mb-1 flex items-center gap-1.5 text-10-regular" style={{ color: "#5b6472" }}>
                                  <span style={{ color: speakerColor(item.from), "font-weight": 600 }}>
                                    {speakerName(item.from)}
                                  </span>
                                  <span style={{ color: "#3f4756" }}>→</span>
                                  <span style={{ color: speakerColor(item.to), "font-weight": 600 }}>
                                    {speakerName(item.to)}
                                  </span>
                                </div>
                                <div class="whitespace-pre-wrap leading-relaxed">
                                  <span style={{ color: line.kind === "error" ? "#f87171" : "#cbd5e1" }}>{line.body}</span>
                                </div>
                              </div>
                            )
                          }}
                        </For>
                        {/* Closing line: how the agents ended up agreeing on roles */}
                        <Show when={teamProfile()}>
                          {(profile) => (
                            <div class="mt-2 whitespace-pre-wrap border-t border-[#1f2733] pt-2 leading-relaxed">
                              <span style={{ color: "#34d399", "font-weight": 600 }}>CHAI</span>
                              <span style={{ color: "#6b7280" }}> ›&nbsp;</span>
                              <span style={{ color: "#cbd5e1" }}>
                                {"Listo, así quedaron los roles:\n" +
                                  profile()
                                    .agents.map((a) => `• ${a.account} → ${roleLabel(a.recommendedRole ?? (a.role as string))}`)
                                    .join("\n")}
                              </span>
                            </div>
                          )}
                        </Show>
                      </Show>
                    </div>
                  </div>

                  {/* Once the debate has settled (idle + a profile): agree and start
                      working, or talk to the team. Nothing shows while they're still
                      debating, so the user doesn't cut in. */}
                  <Show when={runState() === "idle" && Boolean(teamProfile())}>
                    <Show when={commsMode() === "choose"}>
                      <div class="flex flex-col gap-2 rounded-md border border-border-weak-base p-3">
                        <span class="text-12-regular text-text-strong">
                          ¿Estás de acuerdo con el reparto de roles?
                        </span>
                        <div class="flex flex-wrap items-center gap-1.5">
                          <Button
                            type="button"
                            variant="primary"
                            size="small"
                            onClick={() => {
                              setMessage("")
                              setChatTarget(coordinatorId())
                              setCommsMode("work")
                            }}
                          >
                            Sí, empezar a trabajar
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            size="small"
                            onClick={() => {
                              setMessage("")
                              setChatTarget(coordinatorId())
                              setCommsMode("adjust")
                            }}
                          >
                            No, hablar con el equipo
                          </Button>
                        </div>
                      </div>
                    </Show>

                    <Show when={commsMode() === "work" || commsMode() === "adjust"}>
                      <div class="flex flex-col gap-1.5">
                        <div class="flex items-center justify-between gap-2">
                          <div class="flex items-center gap-1.5">
                            <span class="text-11-medium text-text-weak">Para:</span>
                            <select
                              class="rounded border border-border-weak-base bg-transparent px-1.5 py-1 text-11-regular text-text-strong outline-none"
                              value={chatTarget() || coordinatorId()}
                              onChange={(event) => setChatTarget(event.currentTarget.value)}
                            >
                              <For each={team()?.agents ?? []}>
                                {(agent) => (
                                  <option value={agent.accountId}>
                                    {agent.account} · {roleLabel(agent.role)}
                                    {agent.accountId === coordinatorId() ? " (coordinador)" : ""}
                                  </option>
                                )}
                              </For>
                            </select>
                          </div>
                          <button
                            type="button"
                            class="text-10-medium text-text-weak hover:text-text-strong"
                            onClick={() => {
                              setMessage("")
                              setCommsMode("choose")
                            }}
                          >
                            ← Volver
                          </button>
                        </div>
                        <textarea
                          class="min-h-16 resize-y rounded-md border border-border-weak-base bg-transparent px-3 py-2 text-12-regular text-text-strong outline-none focus:border-border-strong"
                          value={message()}
                          onInput={(event) => setMessage(event.currentTarget.value)}
                          onKeyDown={(event) => {
                            // Enter sends (chat-style); Shift+Enter inserts a newline.
                            if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                              event.preventDefault()
                              if (message().trim()) void sendComms()
                            }
                          }}
                          placeholder="Escribe tu mensaje (solo responde el agente elegido)…"
                        />
                        <div class="flex items-center justify-between gap-2">
                          <span class="text-10-regular text-text-weak">
                            Solo responde el agente elegido; el resto lo ve en el chat. Enter envía.
                          </span>
                          <Button
                            type="button"
                            variant="primary"
                            size="small"
                            onClick={sendComms}
                            disabled={sending() || !message().trim()}
                          >
                            {sending() ? "Enviando…" : "Enviar"}
                          </Button>
                        </div>
                      </div>
                    </Show>
                  </Show>

                  {/* Pending permission approvals raised by agents */}
                  <Show when={permissionRequests().length > 0}>
                    <div class="flex flex-col gap-1.5">
                      <span class="text-11-medium text-text-weak">Permisos solicitados</span>
                      <div class="flex flex-col gap-1 rounded-md border border-border-weak-base p-2">
                        <For each={permissionRequests()}>
                          {(request) => (
                            <div class="flex items-center justify-between gap-2 rounded border border-border-weak-base px-2 py-1.5">
                              <div class="flex min-w-0 flex-col">
                                <span class="truncate text-12-regular text-text-strong">
                                  {agentLabel(request.accountId)} pide {permLabel(request.permission)}
                                </span>
                                <Show when={request.reason}>
                                  <span class="text-10-regular text-text-weak truncate">{request.reason}</span>
                                </Show>
                              </div>
                              <div class="flex shrink-0 items-center gap-1.5">
                                <button
                                  type="button"
                                  class="text-10-medium px-2 py-0.5 rounded border border-border-weak-base text-icon-success-base"
                                  onClick={() => runtime()?.resolvePermissionRequest(request.id, true)}
                                >
                                  Aprobar
                                </button>
                                <button
                                  type="button"
                                  class="text-10-medium px-2 py-0.5 rounded border border-border-weak-base text-text-weak"
                                  onClick={() => runtime()?.resolvePermissionRequest(request.id, false)}
                                >
                                  Rechazar
                                </button>
                              </div>
                            </div>
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>

                  {/* Consolidated result of the last team round */}
                  <Show when={synthesis()}>
                    {(s) => (
                      <div class="flex flex-col gap-1.5">
                        <span class="text-11-medium text-text-weak">Sintesis del equipo</span>
                        <div class="flex flex-col gap-1.5 rounded-md border border-border-weak-base p-3">
                          <div class="text-12-regular text-text-strong whitespace-pre-wrap">{s().summary}</div>
                          <Show when={s().filesTouched.length}>
                            <div class="text-10-regular text-text-weak">Archivos: {s().filesTouched.join(", ")}</div>
                          </Show>
                          <Show when={s().tests.length}>
                            <div class="text-10-regular text-text-weak">Pruebas: {s().tests.join(", ")}</div>
                          </Show>
                          <Show when={s().blockers.length}>
                            <div class="text-10-regular text-icon-error-base">Bloqueos: {s().blockers.join("; ")}</div>
                          </Show>
                          <Show when={s().nextActions.length}>
                            <div class="text-10-regular text-text-weak">Siguiente: {s().nextActions.join(", ")}</div>
                          </Show>
                        </div>
                      </div>
                    )}
                  </Show>

                </div>
              </Show>
              </div>
            </>
          )}
        </Show>
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
