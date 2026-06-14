import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { For, Show, createMemo, createSignal } from "solid-js"
import {
  Accounts,
  OPENCODE_PROVIDER,
  PERMISSIONS,
  Teams,
  providerLabel,
  type TeamAgent,
  type TeamConfig,
} from "@/state/agents"
import { useProviders } from "@/hooks/use-providers"
import { DialogAccounts } from "@/components/dialog-accounts"

type AgentState = { label: string; tone: "ok" | "pending" | "off" }

function permLabel(id: string) {
  return PERMISSIONS.find((p) => p.id === id)?.label ?? id
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

export function DialogTeam(props: { directory?: string }) {
  const dialog = useDialog()
  const providers = useProviders()
  const [tab, setTab] = createSignal<"agents" | "comms">("agents")

  const teams = createMemo(() => Teams.list())
  const team = createMemo<TeamConfig | undefined>(() =>
    props.directory ? Teams.get(props.directory) : teams()[0],
  )
  const connectedIds = createMemo(() => new Set(providers.connected().map((p) => p.id)))

  function agentState(agent: TeamAgent): AgentState {
    const opencodeId = OPENCODE_PROVIDER[agent.provider]
    if (opencodeId && connectedIds().has(opencodeId)) return { label: "Listo", tone: "ok" }
    const acc = Accounts.byId(agent.accountId)
    if (acc?.status === "pending") return { label: "Pendiente de conexión", tone: "pending" }
    return { label: "No configurado", tone: "off" }
  }

  function openAccounts() {
    dialog.show(() => <DialogAccounts />)
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
                            <span>{agent.role === "auto" ? "rol automático" : agent.role}</span>
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
                  <div class="rounded-md border border-border-weak-base px-4 py-8 text-center">
                    <div class="text-13-medium text-text-strong">Comunicación entre agentes</div>
                    <div class="text-12-regular text-text-weak mt-1">
                      Aquí verás cómo la IA coordinadora se comunica con los demás agentes (quién → quién, vía CHAI) y
                      sus respuestas, cuando el equipo trabaje.
                    </div>
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
