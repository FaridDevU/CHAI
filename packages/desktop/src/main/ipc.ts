import { execFile, spawn } from "node:child_process"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative } from "node:path"
import { app, BrowserWindow, Notification, clipboard, dialog, ipcMain, shell } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"

import type { FatalRendererError, IsolatedSubscriptionLoginInput, ServerReadyData, TitlebarTheme } from "../preload/types"
import { runDesktopMenuAction } from "./desktop-menu-actions"
import { runClaudeAgent, cancelClaudeAgent } from "./claude-runner"
import type { ClaudeAgentSpec } from "@chai/orchestrator"
import { assertAttachmentBudget, createPickedFileAuthorizations } from "./attachment-picker"
import { getStore } from "./store"
import { getPinchZoomEnabled, setPinchZoomEnabled, setTitlebar, updateTitlebar } from "./windows"
import type { UpdaterController } from "./updater-controller"
import { createUpdaterSubscriptions } from "./updater-subscriptions"

const pickerFilters = (ext?: string[]) => {
  if (!ext || ext.length === 0) return undefined
  return [{ name: "Files", extensions: ext }]
}

const pickedFiles = createPickedFileAuthorizations()

function psQuote(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}

function subscriptionCommand(provider: IsolatedSubscriptionLoginInput["provider"]) {
  if (provider === "claude") return "claude login"
  if (provider === "codex") return "codex login"
  throw new Error(`Unsupported subscription provider: ${provider}`)
}

function chaiRuntimeRoot() {
  return join(app.getPath("userData"), "chai-runtimes")
}

function cleanRuntimeSegment(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "account"
}

async function openIsolatedSubscriptionLogin(input: IsolatedSubscriptionLoginInput) {
  if (input.provider !== "claude" && input.provider !== "codex") throw new Error("Unsupported provider")
  if (!input.accountId) throw new Error("Missing account id")

  const profilePath =
    input.profilePath ?? join(chaiRuntimeRoot(), `${cleanRuntimeSegment(input.provider)}-${cleanRuntimeSegment(input.accountId)}`)
  const homePath = input.homePath ?? join(profilePath, "home")
  const configPath = input.configPath ?? join(profilePath, "config")
  const tempPath = input.tempPath ?? join(profilePath, "tmp")
  const env = {
    ...(input.env ?? {}),
    CHAI_ACCOUNT_ID: input.accountId,
    CHAI_PROVIDER: input.provider,
    CHAI_RUNTIME_HOME: profilePath,
    HOME: homePath,
    USERPROFILE: homePath,
    APPDATA: join(homePath, "AppData", "Roaming"),
    LOCALAPPDATA: join(homePath, "AppData", "Local"),
    TMP: tempPath,
    TEMP: tempPath,
    ...(input.provider === "claude" ? { CLAUDE_CONFIG_DIR: join(configPath, "claude") } : {}),
    ...(input.provider === "codex" ? { CODEX_HOME: join(configPath, "codex") } : {}),
  }

  await Promise.all([
    mkdir(profilePath, { recursive: true }),
    mkdir(homePath, { recursive: true }),
    mkdir(configPath, { recursive: true }),
    mkdir(tempPath, { recursive: true }),
    mkdir(env.APPDATA, { recursive: true }),
    mkdir(env.LOCALAPPDATA, { recursive: true }),
  ])

  const assignments = Object.entries(env)
    .map(([key, value]) => `$env:${key} = ${psQuote(value)}`)
    .join("; ")
  const label = input.label || input.accountId
  const command = [
    assignments,
    `Set-Location ${psQuote(profilePath)}`,
    `Write-Host ${psQuote(`CHAI isolated ${input.provider} login: ${label}`)} -ForegroundColor Cyan`,
    `Write-Host ${psQuote(`HOME: ${homePath}`)} -ForegroundColor DarkGray`,
    subscriptionCommand(input.provider),
  ].join("; ")

  const child = spawn("powershell.exe", ["-NoExit", "-ExecutionPolicy", "Bypass", "-Command", command], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  })
  child.unref()
}

type Deps = {
  killSidecar: () => Promise<void> | void
  relaunch: () => void
  awaitInitialization: () => Promise<ServerReadyData>
  consumeInitialDeepLinks: () => Promise<string[]> | string[]
  getDefaultServerUrl: () => Promise<string | null> | string | null
  setDefaultServerUrl: (url: string | null) => Promise<void> | void
  getDisplayBackend: () => Promise<string | null>
  setDisplayBackend: (backend: string | null) => Promise<void> | void
  parseMarkdown: (markdown: string) => Promise<string> | string
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  resolveAppPath: (appName: string) => Promise<string | null>
  updater: UpdaterController
  showUpdater: () => Promise<void> | void
  setBackgroundColor: (color: string) => void
  exportDebugLogs: () => Promise<string>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void> | void
}

export function registerIpcHandlers(deps: Deps) {
  const updaterSubscriptions = createUpdaterSubscriptions()
  app.once("will-quit", updaterSubscriptions.clear)

  ipcMain.handle("kill-sidecar", () => deps.killSidecar())
  ipcMain.handle("await-initialization", () => deps.awaitInitialization())
  ipcMain.handle("consume-initial-deep-links", () => deps.consumeInitialDeepLinks())
  ipcMain.handle("get-default-server-url", () => deps.getDefaultServerUrl())
  ipcMain.handle("set-default-server-url", (_event: IpcMainInvokeEvent, url: string | null) =>
    deps.setDefaultServerUrl(url),
  )
  ipcMain.handle("get-chai-runtime-root", () => chaiRuntimeRoot())
  ipcMain.handle("get-display-backend", () => deps.getDisplayBackend())
  ipcMain.handle("set-display-backend", (_event: IpcMainInvokeEvent, backend: string | null) =>
    deps.setDisplayBackend(backend),
  )
  ipcMain.handle("parse-markdown", (_event: IpcMainInvokeEvent, markdown: string) => deps.parseMarkdown(markdown))
  ipcMain.handle("check-app-exists", (_event: IpcMainInvokeEvent, appName: string) => deps.checkAppExists(appName))
  ipcMain.handle("resolve-app-path", (_event: IpcMainInvokeEvent, appName: string) => deps.resolveAppPath(appName))
  ipcMain.handle("updater-subscribe", (event) => {
    const id = event.sender.id
    updaterSubscriptions.set(
      id,
      deps.updater.subscribe((state) => {
        if (event.sender.isDestroyed()) return updaterSubscriptions.delete(id)
        event.sender.send("updater-state", state)
      }),
    )
    event.sender.once("destroyed", () => updaterSubscriptions.delete(id))
  })
  ipcMain.handle("updater-unsubscribe", (event) => updaterSubscriptions.delete(event.sender.id))
  ipcMain.handle("updater-check", () => deps.updater.check())
  ipcMain.handle("updater-install", () => deps.updater.install())
  ipcMain.handle("set-background-color", (_event: IpcMainInvokeEvent, color: string) => deps.setBackgroundColor(color))
  ipcMain.handle("export-debug-logs", () => deps.exportDebugLogs())
  ipcMain.handle("record-fatal-renderer-error", (_event: IpcMainInvokeEvent, error: FatalRendererError) =>
    deps.recordFatalRendererError(error),
  )
  ipcMain.handle("store-get", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    try {
      const store = getStore(name)
      const value = store.get(key)
      if (value === undefined || value === null) return null
      return typeof value === "string" ? value : JSON.stringify(value)
    } catch {
      return null
    }
  })
  ipcMain.handle("store-set", (_event: IpcMainInvokeEvent, name: string, key: string, value: string) => {
    getStore(name).set(key, value)
  })
  ipcMain.handle("store-delete", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    getStore(name).delete(key)
  })
  ipcMain.handle("store-clear", (_event: IpcMainInvokeEvent, name: string) => {
    getStore(name).clear()
  })
  ipcMain.handle("store-keys", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store)
  })
  ipcMain.handle("store-length", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store).length
  })

  ipcMain.handle(
    "open-directory-picker",
    async (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", ...(opts?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
        title: opts?.title ?? "Choose a folder",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  ipcMain.handle(
    "open-file-picker",
    async (
      event: IpcMainInvokeEvent,
      opts?: { multiple?: boolean; title?: string; defaultPath?: string; extensions?: string[] },
    ) => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
        title: opts?.title ?? "Choose a file",
        defaultPath: opts?.defaultPath,
        filters: pickerFilters(opts?.extensions),
      })
      if (result.canceled) return null
      const files = await Promise.all(
        result.filePaths.map(async (filePath) => ({
          path: filePath,
          name: basename(filePath),
          size: (await stat(filePath)).size,
        })),
      )
      assertAttachmentBudget(files)
      const token = pickedFiles.add(event.sender.id, result.filePaths)
      return { token, files }
    },
  )

  ipcMain.handle("read-picked-file", async (event: IpcMainInvokeEvent, token: string, filePath: string) => {
    return pickedFiles.read(event.sender.id, token, filePath)
  })

  ipcMain.handle("release-picked-files", (event: IpcMainInvokeEvent, token: string) => {
    pickedFiles.release(event.sender.id, token)
  })

  ipcMain.handle(
    "save-file-picker",
    async (_event: IpcMainInvokeEvent, opts?: { title?: string; defaultPath?: string }) => {
      const result = await dialog.showSaveDialog({
        title: opts?.title ?? "Save file",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return result.filePath ?? null
    },
  )

  // Write a file inside a project directory (CHAI: .chai/team.json and friends).
  // relativePath is constrained to stay within directory to avoid path traversal.
  ipcMain.handle(
    "write-project-file",
    async (_event: IpcMainInvokeEvent, directory: string, relativePath: string, content: string) => {
      if (!directory || isAbsolute(relativePath)) throw new Error("Invalid project file path")
      const target = join(directory, relativePath)
      const rel = relative(directory, target)
      if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Refusing to write outside project directory")
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, "utf8")
      return target
    },
  )

  // Read a file from inside a project directory (e.g. .chai/team.json). Returns
  // null when the file does not exist; same traversal guard as the writer.
  ipcMain.handle(
    "read-project-file",
    async (_event: IpcMainInvokeEvent, directory: string, relativePath: string): Promise<string | null> => {
      if (!directory || isAbsolute(relativePath)) throw new Error("Invalid project file path")
      const target = join(directory, relativePath)
      const rel = relative(directory, target)
      if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Refusing to read outside project directory")
      try {
        return await readFile(target, "utf8")
      } catch (err) {
        if (err && typeof err === "object" && (err as NodeJS.ErrnoException).code === "ENOENT") return null
        throw err
      }
    },
  )

  ipcMain.handle(
    "open-isolated-subscription-login",
    (_event: IpcMainInvokeEvent, input: IsolatedSubscriptionLoginInput) => openIsolatedSubscriptionLogin(input),
  )

  // Run the real `claude` CLI for one agent task; stream its events back to the
  // renderer on "claude-agent-event" and resolve with the final result.
  ipcMain.handle("run-claude-agent", (event: IpcMainInvokeEvent, runId: string, spec: ClaudeAgentSpec) =>
    runClaudeAgent(runId, spec, (agentEvent) =>
      event.sender.send("claude-agent-event", { runId, event: agentEvent }),
    ),
  )
  ipcMain.handle("cancel-claude-agent", (_event: IpcMainInvokeEvent, runId: string) => cancelClaudeAgent(runId))

  ipcMain.on("open-link", (_event: IpcMainEvent, url: string) => {
    void shell.openExternal(url)
  })

  ipcMain.handle("open-path", async (_event: IpcMainInvokeEvent, path: string, app?: string) => {
    if (!app) return shell.openPath(path)
    await new Promise<void>((resolve, reject) => {
      const [cmd, args] =
        process.platform === "darwin" ? (["open", ["-a", app, path]] as const) : ([app, [path]] as const)
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
    })
  })

  ipcMain.handle("read-clipboard-image", () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const buffer = image.toPNG().buffer
    const size = image.getSize()
    return { buffer, width: size.width, height: size.height }
  })

  ipcMain.on("show-notification", (_event: IpcMainEvent, title: string, body?: string) => {
    new Notification({ title, body }).show()
  })

  ipcMain.handle("get-window-count", () => BrowserWindow.getAllWindows().length)

  ipcMain.handle("get-window-focused", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  })

  ipcMain.handle("set-window-focus", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.focus()
  })

  ipcMain.handle("show-window", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.show()
  })

  ipcMain.on("relaunch", () => {
    deps.relaunch()
  })

  ipcMain.handle("get-zoom-factor", (event: IpcMainInvokeEvent) => event.sender.getZoomFactor())
  ipcMain.handle("set-zoom-factor", (event: IpcMainInvokeEvent, factor: number) => {
    event.sender.setZoomFactor(factor)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    updateTitlebar(win)
  })
  ipcMain.handle("get-pinch-zoom-enabled", () => getPinchZoomEnabled())
  ipcMain.handle("set-pinch-zoom-enabled", (_event: IpcMainInvokeEvent, enabled: boolean) => {
    setPinchZoomEnabled(enabled)
  })
  ipcMain.handle("set-titlebar", (event: IpcMainInvokeEvent, theme: TitlebarTheme) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setTitlebar(win, theme)
  })
  ipcMain.handle("run-desktop-menu-action", (event: IpcMainInvokeEvent, action: DesktopMenuAction) => {
    runDesktopMenuAction(BrowserWindow.fromWebContents(event.sender), action, {
      checkForUpdates: () => void deps.showUpdater(),
      relaunch: deps.relaunch,
    })
  })
}

export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send("menu-command", id)
}

export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send("deep-link", urls)
}
