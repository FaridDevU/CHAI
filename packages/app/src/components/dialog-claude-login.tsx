import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Show, createSignal, onMount } from "solid-js"
import { SDKProvider, useSDK } from "@/context/sdk"
import { Terminal } from "@/components/terminal"
import { Accounts } from "@/state/agents"
import type { LocalPTY } from "@/context/terminal"

type CliProvider = "claude" | "kimi" | "codex"

type LoginProps = {
  accountId: string
  label: string
  configDir: string
  profileDir: string
  /** Which CLI to log in. Defaults to "claude" for back-compat. */
  provider?: CliProvider
}

// Per-CLI login command + the env var that points it at this account's isolated
// config dir (the same dir the agent runner reads). `kimi login` uses an RFC 8628
// device-code flow; `claude login` opens the browser. Both are non-TUI prompts
// that run fine inside the embedded terminal.
const CLI = {
  claude: { name: "Claude", command: "claude login", envKey: "CLAUDE_CONFIG_DIR" },
  kimi: { name: "Kimi", command: "kimi login", envKey: "KIMI_CODE_HOME" },
  codex: { name: "Codex", command: "codex login", envKey: "CODEX_HOME" },
} as const

// In-app CLI login for a Claude/Kimi account: runs the real CLI in an embedded
// terminal (sidecar PTY) with this account's isolated config dir — so the login
// lands where the agent reads it.
export function DialogClaudeLogin(props: LoginProps) {
  const cli = CLI[props.provider ?? "claude"]
  return (
    <Dialog title={`Conectar ${cli.name} · ${props.label}`} class="w-full max-w-[720px] mx-auto">
      {/* Route through the server's default instance (empty directory ->
          process.cwd on the server), which is already running, instead of the
          isolated runtime dir (an empty folder with no instance). The PTY still
          runs the CLI in the runtime dir via its own cwd + config-dir env. */}
      <SDKProvider directory="">
        <ClaudeLoginInner {...props} />
      </SDKProvider>
    </Dialog>
  )
}

function ClaudeLoginInner(props: LoginProps) {
  const sdk = useSDK()
  const dialog = useDialog()
  const cli = CLI[props.provider ?? "claude"]
  const [pty, setPty] = createSignal<LocalPTY>()
  const [error, setError] = createSignal<string>()

  onMount(() => {
    // node-pty spawns the command directly (no PATHEXT), so on Windows we must
    // go through cmd.exe for `claude`/`kimi` to resolve to their .cmd shim. The
    // command is fixed (no user input), so the shell string is safe.
    const isWindows = navigator.userAgent.includes("Windows")
    const [bin] = cli.command.split(" ")
    const command = isWindows ? "cmd.exe" : bin
    const args = isWindows ? ["/d", "/s", "/c", cli.command] : cli.command.split(" ").slice(1)
    sdk.client.pty
      .create({
        command,
        args,
        cwd: props.profileDir,
        env: { [cli.envKey]: props.configDir },
        title: `${cli.command} · ${props.label}`,
      } as Parameters<typeof sdk.client.pty.create>[0])
      .then((res: { data?: { id?: string } }) => {
        const id = res.data?.id
        if (!id) throw new Error("No se pudo crear la terminal de login")
        setPty({ id, title: `${cli.command} · ${props.label}`, titleNumber: 0 })
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
        Inicia sesión con tu cuenta de {cli.name} en la terminal de abajo (se abrirá tu navegador / código de
        dispositivo). Cuando el CLI confirme el inicio de sesión, pulsa{" "}
        <span class="text-text-strong">Marcar como conectada</span>.
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
        <Terminal
          pty={pty()!}
          autoFocus
          class="h-80 overflow-hidden rounded-md border border-border-weak-base"
          onConnectError={(err) =>
            setError(`No se pudo conectar la terminal: ${err instanceof Error ? err.message : String(err)}`)
          }
        />
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
