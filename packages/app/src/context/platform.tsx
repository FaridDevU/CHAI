import { createSimpleContext } from "@opencode-ai/ui/context"
import type { AsyncStorage, SyncStorage } from "@solid-primitives/storage"
import type { Accessor } from "solid-js"
import type { DesktopMenuAction } from "../desktop-menu"
import { ServerConnection } from "./server"
import type { WslServersPlatform } from "../wsl/types"
import type { UpdaterPlatform } from "../updater"
import type {
  AccountDiagnosticResult,
  AccountDiagnosticSpec,
  AccountModelOption,
  AccountModelsSpec,
  ClaudeAgentSpec,
  ClaudeRunEvent,
  ClaudeRunResult,
} from "@chai/orchestrator"

type PickerPaths = string | string[] | null
type OpenDirectoryPickerOptions = { title?: string; multiple?: boolean }
type OpenAttachmentPickerOptions = {
  title?: string
  multiple?: boolean
  accept?: string[]
  extensions?: string[]
  defaultPath?: string
}
type SaveFilePickerOptions = { title?: string; defaultPath?: string }
type PlatformName = "web" | "desktop"
type DesktopOS = "macos" | "windows" | "linux"

export type FatalRendererErrorLog = {
  error: string
  url: string
  version?: string
  platform: PlatformName
  os?: DesktopOS
}

type PlatformBase = {
  /** App version */
  version?: string

  /** Open a URL in the default browser */
  openLink(url: string): void

  /** Open a local path in a local app (desktop only) */
  openPath?(path: string, app?: string): Promise<void>

  /** Restart the app  */
  restart(): Promise<void>

  /** Navigate back in history */
  back(): void

  /** Navigate forward in history */
  forward(): void

  /** Send a system notification (optional deep link) */
  notify(title: string, description?: string, href?: string): Promise<void>

  /** Open a native attachment picker and read selected files sequentially (desktop only) */
  openAttachmentPickerDialog?(
    opts: OpenAttachmentPickerOptions,
    onFile: (file: File) => Promise<unknown>,
  ): Promise<void>

  /** Open a native save file picker dialog (desktop only) */
  saveFilePickerDialog?(opts?: SaveFilePickerOptions): Promise<string | null>

  /** Write a file inside a project directory, e.g. .chai/team.json (desktop only).
   *  relativePath must stay within directory. Returns the absolute path written. */
  writeProjectFile?(directory: string, relativePath: string, content: string): Promise<string>

  /** Read a file from inside a project directory, e.g. .chai/team.json (desktop
   *  only). relativePath must stay within directory. Resolves null if missing. */
  readProjectFile?(directory: string, relativePath: string): Promise<string | null>

  /** Append a chunk to a file inside a project directory (desktop only), creating
   *  it if missing. Used for incremental .chai/messages.jsonl writes. When absent,
   *  callers fall back to rewriting the whole file via writeProjectFile. */
  appendProjectFile?(directory: string, relativePath: string, content: string): Promise<string>

  /** Create an isolated account runtime dir (desktop only), so a login PTY can
   *  cwd into it. Constrained to the CHAI runtime root. */
  ensureRuntimeDir?(dir: string): Promise<string>

  /** Run the real `claude` CLI for one agent task (desktop only). Streams events
   *  via onClaudeAgentEvent and resolves with the final result. */
  runClaudeAgent?(runId: string, spec: ClaudeAgentSpec): Promise<ClaudeRunResult>
  /** Run a short diagnostic command in an account's isolated runtime (desktop only). */
  runAccountDiagnostic?(spec: AccountDiagnosticSpec): Promise<AccountDiagnosticResult>
  /** Read a provider's local model cache from its isolated runtime (desktop only).
   *  Resolves [] when the cache is missing/unreadable. */
  readAccountModels?(spec: AccountModelsSpec): Promise<AccountModelOption[]>
  /** Cancel a running claude agent by run id (desktop only). */
  cancelClaudeAgent?(runId: string): Promise<void>
  /** Subscribe to streamed claude agent events; returns an unsubscribe fn. */
  onClaudeAgentEvent?(callback: (payload: { runId: string; event: ClaudeRunEvent }) => void): () => void

  /** Storage mechanism, defaults to localStorage */
  storage?: (name?: string) => SyncStorage | AsyncStorage

  /** Application-global desktop updater */
  updater?: UpdaterPlatform

  /** Fetch override */
  fetch?: typeof fetch

  /** Get the configured default server URL (platform-specific) */
  getDefaultServer?(): Promise<ServerConnection.Key | null>

  /** Set the default server URL to use on app startup (platform-specific) */
  setDefaultServer?(url: ServerConnection.Key | null): Promise<void> | void

  /** Manage WSL sidecar servers (Electron on Windows only) */
  wslServers?: WslServersPlatform

  /** Get the preferred display backend (desktop only) */
  getDisplayBackend?(): Promise<DisplayBackend | null> | DisplayBackend | null

  /** Set the preferred display backend (desktop only) */
  setDisplayBackend?(backend: DisplayBackend): Promise<void>

  /** Parse markdown to HTML using native parser (desktop only, returns unprocessed code blocks) */
  parseMarkdown?(markdown: string): Promise<string>

  /** Webview zoom level (desktop only) */
  webviewZoom?: Accessor<number>

  /** Get whether native pinch/Ctrl-scroll zoom gestures are enabled (desktop only) */
  getPinchZoomEnabled?(): Promise<boolean> | boolean

  /** Allow native pinch/Ctrl-scroll zoom gestures (desktop only) */
  setPinchZoomEnabled?(enabled: boolean): Promise<void> | void

  /** Run a desktop-only menu action from the app chrome */
  runDesktopMenuAction?(action: DesktopMenuAction): Promise<void> | void

  /** Check if an editor app exists (desktop only) */
  checkAppExists?(appName: string): Promise<boolean>

  /** Read image from clipboard (desktop only) */
  readClipboardImage?(): Promise<File | null>

  /** Export collected diagnostic logs (desktop only) */
  exportDebugLogs?(): Promise<string>

  /** Record a fatal renderer error in platform logs (desktop only) */
  recordFatalRendererError?(error: FatalRendererErrorLog): Promise<void>
}

export type Platform = PlatformBase &
  (
    | { platform: "web"; os?: never }
    | {
        platform: "desktop"
        os?: DesktopOS
        openDirectoryPickerDialog(opts?: OpenDirectoryPickerOptions): Promise<PickerPaths>
      }
  )

export type DisplayBackend = "auto" | "wayland"

export const { use: usePlatform, provider: PlatformProvider } = createSimpleContext({
  name: "Platform",
  init: (props: { value: Platform }) => {
    return props.value
  },
})
