import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Show, createSignal, onMount } from "solid-js"
import { SDKProvider, useSDK } from "@/context/sdk"
import { Terminal } from "@/components/terminal"
import { Accounts } from "@/state/agents"
import type { LocalPTY } from "@/context/terminal"

// In-app `claude login` for a Claude account: runs the real CLI in an embedded
// terminal (sidecar PTY) with this account's isolated CLAUDE_CONFIG_DIR — the
// same dir the Claude runner uses — so the login lands where the agent reads it.
export function DialogClaudeLogin(props: { accountId: string; label: string; configDir: string; profileDir: string }) {
  return (
    <Dialog title={`Conectar Claude · ${props.label}`} class="w-full max-w-[720px] mx-auto">
      {/* Scope a directory SDK to the runtime dir so the terminal can connect. */}
      <SDKProvider directory={props.profileDir}>
        <ClaudeLoginInner {...props} />
      </SDKProvider>
    </Dialog>
  )
}

function ClaudeLoginInner(props: { accountId: string; label: string; configDir: string; profileDir: string }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const [pty, setPty] = createSignal<LocalPTY>()
  const [error, setError] = createSignal<string>()

  onMount(() => {
    // node-pty spawns the command directly (no PATHEXT), so on Windows we must
    // go through cmd.exe for `claude` to resolve to claude.cmd. The command is
    // fixed (no user input), so the shell string is safe.
    const isWindows = navigator.userAgent.includes("Windows")
    const command = isWindows ? "cmd.exe" : "claude"
    const args = isWindows ? ["/d", "/s", "/c", "claude login"] : ["login"]
    sdk.client.pty
      .create({
        command,
        args,
        cwd: props.profileDir,
        env: { CLAUDE_CONFIG_DIR: props.configDir },
        title: `claude login · ${props.label}`,
      } as Parameters<typeof sdk.client.pty.create>[0])
      .then((res: { data?: { id?: string } }) => {
        const id = res.data?.id
        if (!id) throw new Error("No se pudo crear la terminal de login")
        setPty({ id, title: `claude login · ${props.label}`, titleNumber: 0 })
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  })

  function markReady() {
    Accounts.setStatus(props.accountId, "ready")
    dialog.close()
  }

  return (
    <div class="flex flex-col gap-4 p-6 pt-0">
      <p class="text-12-regular text-text-weak">
        Inicia sesión con tu cuenta de Claude en la terminal de abajo (se abrirá tu navegador). Cuando el CLI confirme el
        inicio de sesión, pulsa <span class="text-text-strong">Marcar como conectada</span>.
      </p>

      <Show when={error()}>
        <div class="rounded-md border border-border-weak-base px-3 py-2 text-12-regular text-icon-error-base">{error()}</div>
      </Show>

      <Show
        when={pty()}
        fallback={
          <div class="flex items-center gap-2 px-1 py-6 text-12-regular text-text-weak">
            <Spinner /> Abriendo terminal…
          </div>
        }
      >
        <Terminal pty={pty()!} autoFocus class="h-80 overflow-hidden rounded-md border border-border-weak-base" />
      </Show>

      <div class="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
          Cancelar
        </Button>
        <Button type="button" variant="primary" size="large" disabled={!pty()} onClick={markReady}>
          Marcar como conectada
        </Button>
      </div>
    </div>
  )
}
