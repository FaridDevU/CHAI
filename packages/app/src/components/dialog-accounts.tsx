import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { Icon } from "@opencode-ai/ui/icon"
import { For, Show, createMemo, createSignal } from "solid-js"
import { Accounts, OPENCODE_PROVIDER, PROVIDERS, providerLabel, type AccountStatus } from "@/state/agents"
import { useProviders } from "@/hooks/use-providers"
import { showToast } from "@/utils/toast"

function statusLabel(status: AccountStatus) {
  if (status === "ready") return "Listo"
  if (status === "pending") return "Pendiente de conexión"
  return "No configurado"
}

export function DialogAccounts() {
  const dialog = useDialog()
  const providers = useProviders()
  const [adding, setAdding] = createSignal(false)
  const [provider, setProvider] = createSignal<string>(PROVIDERS[0].id)
  const [label, setLabel] = createSignal("")

  const connectedIds = createMemo(() => new Set(providers.connected().map((p) => p.id)))
  const providerKnown = (id: string) => {
    if (!id) return false
    for (const [pid] of providers.all()) if (pid === id) return true
    return false
  }

  function connect(account: { id: string; provider: string }) {
    const opencodeId = OPENCODE_PROVIDER[account.provider]
    if (!providerKnown(opencodeId)) {
      showToast(`Conexión de ${providerLabel(account.provider)} todavía no disponible.`)
      return
    }
    Accounts.setStatus(account.id, "pending")
    void import("@/components/dialog-connect-provider").then((x) => {
      dialog.show(() => <x.DialogConnectProvider provider={opencodeId} />)
    })
  }

  function isConnected(account: { provider: string }) {
    const opencodeId = OPENCODE_PROVIDER[account.provider]
    return !!opencodeId && connectedIds().has(opencodeId)
  }

  function add() {
    const count = Accounts.list().filter((a) => a.provider === provider()).length
    const name = label().trim() || `${providerLabel(provider())} ${count + 1}`
    Accounts.add(provider(), name)
    setLabel("")
    setAdding(false)
  }

  return (
    <Dialog title="Cuentas / Agentes" class="w-full max-w-[520px] mx-auto">
      <div class="flex flex-col gap-5 p-6 pt-0">
        <p class="text-12-regular text-text-weak">
          Conecta las cuentas de IA que usarás en tus proyectos. Puedes añadir varias cuentas del mismo proveedor (p.
          ej. Claude 1, Claude 2).
        </p>

        <div class="flex flex-col gap-1.5">
          <Show
            when={Accounts.list().length > 0}
            fallback={
              <div class="rounded-md border border-border-weak-base px-4 py-6 text-center text-12-regular text-text-weak">
                Aún no tienes cuentas. Añade al menos una para empezar.
              </div>
            }
          >
            <For each={Accounts.list()}>
              {(acc) => (
                <div class="flex items-center justify-between gap-2 rounded-md border border-border-weak-base px-3 py-2">
                  <div class="flex flex-col min-w-0">
                    <span class="text-13-medium text-text-strong truncate">{acc.label}</span>
                    <span class="text-11-regular text-text-weak">
                      {providerLabel(acc.provider)} · {isConnected(acc) ? "Conectado" : statusLabel(acc.status)}
                    </span>
                  </div>
                  <div class="flex items-center gap-1 shrink-0">
                    <Show when={!isConnected(acc)}>
                      <Button type="button" variant="secondary" size="small" onClick={() => connect(acc)}>
                        Conectar
                      </Button>
                    </Show>
                    <Button type="button" variant="ghost" size="small" onClick={() => Accounts.remove(acc.id)}>
                      <Icon name="trash" />
                    </Button>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </div>

        <Show
          when={adding()}
          fallback={
            <Button type="button" variant="secondary" size="large" onClick={() => setAdding(true)}>
              <Icon name="plus" /> Añadir cuenta
            </Button>
          }
        >
          <div class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
            <div class="flex flex-col gap-1.5">
              <span class="text-12-medium text-text-weak">Proveedor</span>
              <div class="flex flex-wrap gap-1.5">
                <For each={PROVIDERS}>
                  {(p) => (
                    <button
                      type="button"
                      classList={{
                        "px-3 py-1.5 rounded-md text-12-medium border transition-colors": true,
                        "border-icon-strong-base text-text-strong": provider() === p.id,
                        "border-border-weak-base text-text-weak hover:border-border-strong": provider() !== p.id,
                      }}
                      onClick={() => setProvider(p.id)}
                    >
                      {p.label}
                    </button>
                  )}
                </For>
              </div>
            </div>
            <TextField
              autofocus
              type="text"
              label="Nombre de la cuenta"
              placeholder={`${providerLabel(provider())} ${Accounts.list().filter((a) => a.provider === provider()).length + 1}`}
              value={label()}
              onChange={setLabel}
            />
            <div class="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="large" onClick={() => setAdding(false)}>
                Cancelar
              </Button>
              <Button type="button" variant="primary" size="large" onClick={add}>
                Añadir
              </Button>
            </div>
          </div>
        </Show>

        <div class="flex justify-end">
          <Button type="button" variant="primary" size="large" onClick={() => dialog.close()}>
            Aceptar
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
