import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { Icon } from "@opencode-ai/ui/icon"
import { For, Show, createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { getFilename } from "@opencode-ai/core/util/path"
import { accountProviderId, createAccountRuntime, parseCliModels, type AccountRuntime, type Role } from "@chai/orchestrator"
import { useGlobal } from "@/context/global"
import { usePlatform } from "@/context/platform"
import { ServerConnection } from "@/context/server"
import { useProviders } from "@/hooks/use-providers"
import { useDirectoryPicker } from "@/components/directory-picker"
import { showToast } from "@/utils/toast"
import {
  Accounts,
  OPENCODE_PROVIDER,
  PERMISSIONS,
  ROLES,
  Teams,
  isCliProvider,
  providerLabel,
  roleLabel,
  type RoleMode,
  type TeamConfig,
} from "@/state/agents"
import { DialogAccounts } from "@/components/dialog-accounts"
import { DialogTeam } from "@/components/dialog-team"
import { dropProjectTeamRuntime } from "@/state/team-runtime"

const STACKS = ["Web (frontend)", "API / Backend", "Full-stack", "Python", "Móvil", "Otro"]
const COUNTS = ["1", "2", "3", "4", "Personalizado"]
const ROLE_MODES: { id: RoleMode; label: string; hint: string }[] = [
  { id: "manual", label: "Manual", hint: "Tú eliges el rol de cada agente." },
  { id: "auto", label: "Automático", hint: "CHAI evalúa a los agentes y asigna roles." },
  { id: "hybrid", label: "Híbrido", hint: "Tú fijas algunos roles y CHAI decide el resto." },
]
const STEPS = ["Detalles", "Equipo", "Modelos", "Roles", "Resumen"]
const DEFAULT_PERMS = ["read_project", "edit_project"]
// Listing models differs per CLI (verified against the real binaries):
//  - kimi exposes `provider list --json`; the alias you pass to -m is the KEY of
//    the JSON `models` map (e.g. "kimi-code/kimi-for-coding").
//  - codex and claude have NO list command — the model is just a -m/--model alias,
//    so there's nothing to "detect". We surface their known subscription aliases
//    and let the user type a custom one.
const MODEL_COMMANDS: Record<string, string[][]> = {
  kimi: [["provider", "list", "--json"]],
}
// A selectable model. `disabled` ones are shown greyed-out (e.g. Fable, which
// the account isn't entitled to) so the UI mirrors the real CLI picker.
type ModelOption = { value: string; label?: string; disabled?: boolean }

// Known models per provider, matching what each CLI's own picker shows.
// Claude/Codex have no list command, so these mirror the current pickers:
//  - claude: 3 Opus, 2 Sonnet, Haiku; Fable flagged disabled.
//  - codex: the visible slugs from `~/.codex/models_cache.json` (the hidden
//    `codex-auto-review` entry is omitted).
// kimi DOES list models (`provider list --json`), so its entry is only a
// fallback for when detection can't run.
const KNOWN_MODELS: Record<string, ModelOption[]> = {
  codex: [
    { value: "gpt-5.5", label: "GPT-5.5" },
    { value: "gpt-5.4", label: "GPT-5.4" },
    { value: "gpt-5.4-mini", label: "GPT-5.4-Mini" },
  ],
  claude: [
    { value: "claude-opus-4-8", label: "Opus 4.8" },
    { value: "claude-opus-4-7", label: "Opus 4.7" },
    { value: "claude-opus-4-6", label: "Opus 4.6" },
    { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
    { value: "claude-sonnet-4-5", label: "Sonnet 4.5" },
    { value: "claude-haiku-4-5", label: "Haiku 4.5" },
    { value: "claude-fable-5", label: "Fable 5", disabled: true },
  ],
  kimi: [{ value: "kimi-code/kimi-for-coding", label: "K2.7 Code" }],
}

// kimi prints a JSON config whose `models` keys ARE the -m aliases (and carry a
// displayName); other CLIs fall back to the tolerant text parser.
function parseModelsForProvider(provider: string, raw: string): ModelOption[] {
  if (provider === "kimi") {
    try {
      const json = JSON.parse(raw) as { models?: Record<string, { displayName?: string }> }
      if (json?.models && typeof json.models === "object") {
        return Object.entries(json.models).map(([value, info]) => ({ value, label: info?.displayName }))
      }
    } catch {
      // fall through to the generic parser
    }
  }
  return parseCliModels(raw).map((value) => ({ value }))
}

function firstEnabled(models: ModelOption[]): string | undefined {
  return models.find((m) => !m.disabled)?.value
}

// Overlay account-read options onto the curated base (Claude): a fetched entry
// updates the matching base model's label/disabled, or is appended if new.
function mergeModelOptions(base: ModelOption[], fetched: ModelOption[]): ModelOption[] {
  const out = base.map((m) => ({ ...m }))
  for (const f of fetched) {
    const existing = out.find((m) => m.value === f.value)
    if (existing) {
      if (f.label) existing.label = f.label
      if (f.disabled !== undefined) existing.disabled = f.disabled
    } else {
      out.push({ ...f })
    }
  }
  return out
}

export function ProjectAgentSetup(props: { server: ServerConnection.Any }) {
  const dialog = useDialog()
  const global = useGlobal()
  const platform = usePlatform()
  const pickDirectory = useDirectoryPicker()
  const providers = useProviders()
  const [starting, setStarting] = createSignal(false)

  const [s, set] = createStore({
    step: 0,
    name: "",
    directory: "",
    stack: STACKS[0],
    count: "2",
    selected: [] as string[],
    roleMode: "manual" as RoleMode,
    roles: {} as Record<string, Role>,
    perms: {} as Record<string, string[]>,
    models: {} as Record<string, string>,
    detectedModels: {} as Record<string, ModelOption[]>,
    modelOutput: {} as Record<string, string>,
    detectingModels: {} as Record<string, boolean>,
    visualTesting: true,
    computerControl: "approval_required" as TeamConfig["computerControl"],
  })

  const accounts = createMemo(() => Accounts.list())
  const selectedAccounts = createMemo(() => accounts().filter((a) => s.selected.includes(a.id)))
  // How many agents the user picked ("Personalizado" = no limit).
  const maxAgents = createMemo(() => (s.count === "Personalizado" ? Infinity : Number(s.count) || Infinity))

  // Changing the count trims the current selection so it never exceeds the limit.
  function setCount(c: string) {
    set("count", c)
    const max = c === "Personalizado" ? Infinity : Number(c) || Infinity
    if (s.selected.length > max) set("selected", (xs) => xs.slice(0, max))
  }

  // Whether an account is actually connected (so the agent will run). Mirrors
  // dialog-accounts: Claude/Kimi rely on the confirmed CLI-login status, other
  // providers on their per-account provider being exposed by the server.
  const connectedIds = createMemo(() => new Set(providers.connected().map((p) => p.id)))
  function accountReady(acc: { id: string; provider: string }) {
    if (isCliProvider(acc.provider)) return Accounts.byId(acc.id)?.status === "ready"
    const base = OPENCODE_PROVIDER[acc.provider]
    return !!base && connectedIds().has(accountProviderId(base, acc.id))
  }

  function openFolder() {
    pickDirectory({
      server: props.server,
      title: "Elegir carpeta del proyecto",
      multiple: false,
      onSelect: (result) => {
        const dir = Array.isArray(result) ? result[0] : result
        if (!dir) return
        set("directory", dir)
        if (!s.name.trim()) set("name", getFilename(dir))
      },
    })
  }

  function toggleAgent(id: string) {
    if (s.selected.includes(id)) {
      set("selected", (xs) => xs.filter((x) => x !== id))
      return
    }
    if (s.selected.length >= maxAgents()) {
      showToast({
        title: `Elegiste ${s.count} ${s.count === "1" ? "agente" : "agentes"}`,
        description: "Sube el número de arriba o deselecciona uno para añadir otro.",
      })
      return
    }
    set("selected", (xs) => [...xs, id])
    if (!s.perms[id]) set("perms", id, [...DEFAULT_PERMS])
    if (!s.roles[id]) set("roles", id, ROLES[0].id)
  }

  function togglePerm(id: string, perm: string) {
    const current = s.perms[id] ?? []
    set("perms", id, current.includes(perm) ? current.filter((p) => p !== perm) : [...current, perm])
  }

  function openAccounts() {
    dialog.show(() => <DialogAccounts />)
  }

  async function runtimeForAccount(acc: { id: string; provider: string }): Promise<AccountRuntime> {
    const runtimeRoot = (await window.api?.getChaiRuntimeRoot?.().catch(() => undefined)) ?? `${s.directory}/.chai/runtimes`
    return createAccountRuntime({ accountId: acc.id, provider: acc.provider }, { root: runtimeRoot })
  }

  async function detectModels(acc: { id: string; provider: string; label: string }) {
    if (!platform.runAccountDiagnostic) {
      showToast({ title: "La deteccion de modelos requiere CHAI Desktop." })
      return
    }
    set("detectingModels", acc.id, true)
    set("modelOutput", acc.id, "")
    const known = KNOWN_MODELS[acc.provider] ?? []
    try {
      const commands = MODEL_COMMANDS[acc.provider] ?? []
      // CLIs without a real list command (codex, claude) instead keep a local
      // model cache on disk. Read it from the isolated runtime: Codex's cache is
      // the authoritative full list; Claude's only holds extra/disabled entries,
      // so it's merged onto the curated base. Falls back to curated if absent.
      if (commands.length === 0) {
        let options = known
        try {
          const runtime = await runtimeForAccount(acc)
          const fetched = (await platform.readAccountModels?.({ provider: acc.provider, runtime })) ?? []
          if (fetched.length > 0) {
            options = acc.provider === "codex" ? fetched : mergeModelOptions(known, fetched)
          }
        } catch {
          // best-effort: keep the curated list if the cache can't be read
        }
        set("detectedModels", acc.id, options)
        const fallback = firstEnabled(options)
        if (fallback && !s.models[acc.id]) set("models", acc.id, fallback)
        return
      }
      const runtime = await runtimeForAccount(acc)
      const outputs: string[] = []
      for (const args of commands) {
        const result = await platform.runAccountDiagnostic({
          provider: acc.provider,
          runtime,
          kind: "models",
          args,
          cwd: runtime.profilePath,
          timeoutMs: 12_000,
        })
        const raw = [result.stdout, result.stderr].filter(Boolean).join("\n")
        outputs.push([`$ ${acc.provider} ${args.join(" ")}`, raw].filter(Boolean).join("\n"))
        const models = parseModelsForProvider(acc.provider, raw)
        if (models.length > 0) {
          set("detectedModels", acc.id, models)
          const first = firstEnabled(models)
          if (first && !s.models[acc.id]) set("models", acc.id, first)
          return
        }
      }
      // Detection ran but found nothing: fall back to known aliases + keep output.
      set("detectedModels", acc.id, known)
      const fallback = firstEnabled(known)
      if (fallback && !s.models[acc.id]) set("models", acc.id, fallback)
      set("modelOutput", acc.id, outputs.join("\n\n").slice(-4000))
      showToast({
        title: `No se detectaron modelos para ${acc.label}`,
        description: "CHAI mostro los modelos conocidos y guardo la salida del CLI.",
      })
    } catch (err) {
      set("detectedModels", acc.id, known)
      const fallback = firstEnabled(known)
      if (fallback && !s.models[acc.id]) set("models", acc.id, fallback)
      set("modelOutput", acc.id, err instanceof Error ? err.message : String(err))
      showToast({
        title: `No se pudo detectar modelos para ${acc.label}`,
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      set("detectingModels", acc.id, false)
    }
  }

  const canNext = createMemo(() => {
    if (s.step === 0) return s.name.trim().length > 0 && s.directory.length > 0
    if (s.step === 1) return s.selected.length > 0
    if (s.step === 3) {
      if (s.roleMode === "auto") return true
      return selectedAccounts().every((a) => !!s.roles[a.id])
    }
    return true
  })

  async function start() {
    if (starting()) return
    setStarting(true)
    const runtimeRoot = (await window.api?.getChaiRuntimeRoot?.().catch(() => undefined)) ?? `${s.directory}/.chai/runtimes`
    const cfg: TeamConfig = {
      projectName: s.name.trim(),
      directory: s.directory,
      stack: s.stack,
      roleMode: s.roleMode,
      visualTesting: s.visualTesting,
      computerControl: s.computerControl,
      agents: selectedAccounts().map((a) => ({
        accountId: a.id,
        provider: a.provider,
        account: a.label,
        role: s.roleMode === "auto" ? "auto" : s.roles[a.id] ?? ROLES[0].id,
        permissions: s.perms[a.id] ?? [...DEFAULT_PERMS],
        model: s.models[a.id] || undefined,
        runtime: createAccountRuntime(
          { accountId: a.id, provider: a.provider },
          { root: runtimeRoot },
        ),
      })),
    }
    if (!Teams.save(cfg)) {
      showToast({
        title: "No se pudo guardar la configuración del equipo",
        description: "El almacenamiento local falló; revisa la consola para más detalles.",
      })
    }

    const ctx = global.createServerCtx(props.server)

    // Persist the team config as a real file in the project so the orchestrator
    // (and the user) can see it. Falls back silently on web where there's no fs.
    try {
      await platform.writeProjectFile?.(s.directory, ".chai/team.json", JSON.stringify(cfg, null, 2))
    } catch (err) {
      showToast({
        title: "No se pudo escribir .chai/team.json",
        description: err instanceof Error ? err.message : String(err),
      })
    }

    // Starting a (re)configured team begins a CLEAN conversation: wipe any prior
    // .chai state left in this folder by an earlier team so old errors/roles
    // aren't repainted when the same folder is reused. Then drop the cached
    // in-memory runtime so the next one reloads from these now-empty files.
    try {
      await Promise.all([
        platform.writeProjectFile?.(s.directory, ".chai/messages.jsonl", ""),
        platform.writeProjectFile?.(s.directory, ".chai/team-profile.json", ""),
        platform.writeProjectFile?.(s.directory, ".chai/tasks.json", "[]"),
        platform.writeProjectFile?.(s.directory, ".chai/sessions.json", "{}"),
      ])
    } catch {
      // best-effort: a stale file that can't be cleared isn't fatal to starting.
    }
    dropProjectTeamRuntime(s.directory)

    // NOTE: we deliberately do NOT pre-create one opencode session per agent.
    // CLI agents (Claude/Kimi/Codex) run headless via their own runner, so those
    // sessions were never used and just cluttered the sidebar; non-CLI agents get
    // a session created on demand by the team runtime when they first run.

    // Session housekeeping for the project (best-effort; never blocks starting):
    // leave the folder with ONLY this project's own working session, so a project
    // started on a reused folder doesn't keep showing leftover chats (old per-agent
    // sessions, or stale provider test chats like the "new session" from when Codex
    // ran through the API). The kept session (named after the project) is where work
    // is saved so the user can resume later; it's created if it doesn't exist yet.
    const projectTitle = s.name.trim() || getFilename(s.directory)
    try {
      const listed = await ctx.sdk.client.session.list({ directory: s.directory } as Parameters<
        typeof ctx.sdk.client.session.list
      >[0])
      const items = (Array.isArray(listed) ? listed : (listed as { data?: unknown }).data) as
        | { id?: string; title?: string; parentID?: string }[]
        | undefined
      let keptProjectSession = false
      for (const sess of items ?? []) {
        if (!sess?.id || sess.parentID) continue
        if ((sess.title ?? "") === projectTitle && !keptProjectSession) {
          keptProjectSession = true
          continue
        }
        await ctx.sdk.client.session.delete({ sessionID: sess.id }).catch(() => undefined)
      }
      if (!keptProjectSession) {
        await ctx.sdk.client.session
          .create({ directory: s.directory, title: projectTitle } as Parameters<
            typeof ctx.sdk.client.session.create
          >[0])
          .catch(() => undefined)
      }
    } catch {
      // best-effort housekeeping
    }

    ctx.projects.open(s.directory)
    ctx.projects.touch(s.directory)
    setStarting(false)
    dialog.close()
    // Open the team panel and let the agents introduce themselves (onboarding),
    // so the user watches who takes each role instead of landing in a chat.
    dialog.show(() => <DialogTeam directory={s.directory} autoStart />)
  }

  return (
    <Dialog title="Nuevo proyecto" size="large" class="w-full max-w-[560px] mx-auto">
      <div class="flex flex-col gap-5 p-6 pt-0 flex-1 min-h-0">
        {/* step indicator */}
        <div class="flex items-center gap-2">
          <For each={STEPS}>
            {(label, i) => (
              <div class="flex items-center gap-2">
                <div
                  classList={{
                    "flex items-center gap-1.5 text-12-medium": true,
                    "text-text-strong": i() === s.step,
                    "text-text-weak": i() !== s.step,
                  }}
                >
                  <span
                    classList={{
                      "flex items-center justify-center size-5 rounded-full text-11-medium": true,
                      "bg-icon-strong-base text-white": i() <= s.step,
                      "border border-border-weak-base": i() > s.step,
                    }}
                  >
                    {i() + 1}
                  </span>
                  {label}
                </div>
                <Show when={i() < STEPS.length - 1}>
                  <div class="w-4 h-px bg-border-weak-base" />
                </Show>
              </div>
            )}
          </For>
        </div>

        {/* step content (scrolls when it overflows; indicator + footer stay put) */}
        <div class="flex flex-col gap-5 overflow-y-auto flex-1 min-h-0 pr-1 -mr-1">
        {/* STEP 0 — details */}
        <Show when={s.step === 0}>
          <div class="flex flex-col gap-4">
            <TextField
              autofocus
              type="text"
              label="Nombre del proyecto"
              placeholder="Mi proyecto"
              value={s.name}
              onChange={(v) => set("name", v)}
            />
            <div class="flex flex-col gap-1.5">
              <span class="text-12-medium text-text-weak">Carpeta del proyecto</span>
              <button
                type="button"
                class="flex items-center justify-between rounded-md border border-border-weak-base px-3 py-2 text-13-regular hover:border-border-strong"
                onClick={openFolder}
              >
                <span classList={{ "text-text-strong truncate": !!s.directory, "text-text-weak": !s.directory }}>
                  {s.directory || "Elegir carpeta…"}
                </span>
                <Icon name="folder" />
              </button>
            </div>
            <div class="flex flex-col gap-1.5">
              <span class="text-12-medium text-text-weak">Stack / tipo de proyecto</span>
              <div class="flex flex-wrap gap-1.5">
                <For each={STACKS}>
                  {(st) => (
                    <button
                      type="button"
                      classList={{
                        "px-3 py-1.5 rounded-md text-12-medium border transition-colors": true,
                        "border-icon-strong-base text-text-strong": s.stack === st,
                        "border-border-weak-base text-text-weak hover:border-border-strong": s.stack !== st,
                      }}
                      onClick={() => set("stack", st)}
                    >
                      {st}
                    </button>
                  )}
                </For>
              </div>
            </div>
          </div>
        </Show>

        {/* STEP 1 — team */}
        <Show when={s.step === 1}>
          <div class="flex flex-col gap-4">
            <div class="flex flex-col gap-1.5">
              <span class="text-12-medium text-text-weak">¿Cuántos agentes quieres usar?</span>
              <div class="flex flex-wrap gap-1.5">
                <For each={COUNTS}>
                  {(c) => (
                    <button
                      type="button"
                      classList={{
                        "px-3 py-1.5 rounded-md text-12-medium border transition-colors": true,
                        "border-icon-strong-base text-text-strong": s.count === c,
                        "border-border-weak-base text-text-weak hover:border-border-strong": s.count !== c,
                      }}
                      onClick={() => setCount(c)}
                    >
                      {c === "Personalizado" ? c : `${c} ${c === "1" ? "agente" : "agentes"}`}
                    </button>
                  )}
                </For>
              </div>
            </div>

            <Show
              when={accounts().length > 0}
              fallback={
                <div class="flex flex-col items-center gap-3 rounded-md border border-border-weak-base px-4 py-8 text-center">
                  <div class="text-13-medium text-text-strong">No tienes agentes conectados</div>
                  <div class="text-12-regular text-text-weak">Conecta al menos 2 agentes para formar un equipo.</div>
                  <Button type="button" variant="primary" size="large" onClick={openAccounts}>
                    <Icon name="plus" /> Conectar cuentas
                  </Button>
                </div>
              }
            >
              <div class="flex flex-col gap-1.5">
                <div class="flex items-center justify-between">
                  <span class="text-12-medium text-text-weak">
                    Agentes disponibles · {s.selected.length}/{s.count === "Personalizado" ? "∞" : s.count}
                  </span>
                  <button type="button" class="text-11-medium text-text-link hover:underline" onClick={openAccounts}>
                    Gestionar cuentas
                  </button>
                </div>
                <For each={accounts()}>
                  {(acc) => (
                    <button
                      type="button"
                      classList={{
                        "flex items-center justify-between rounded-md border px-3 py-2 transition-colors": true,
                        "border-icon-strong-base": s.selected.includes(acc.id),
                        "border-border-weak-base hover:border-border-strong": !s.selected.includes(acc.id),
                      }}
                      onClick={() => toggleAgent(acc.id)}
                    >
                      <div class="flex flex-col text-left min-w-0">
                        <span class="text-13-medium text-text-strong truncate">{acc.label}</span>
                        <span class="text-11-regular text-text-weak">
                          {providerLabel(acc.provider)} · {accountReady(acc) ? "Conectado" : "Sin conectar"}
                        </span>
                      </div>
                      <div class="flex items-center gap-2 shrink-0">
                        <span
                          classList={{
                            "size-1.5 rounded-full": true,
                            "bg-icon-strong-base": accountReady(acc),
                            "bg-border-strong": !accountReady(acc),
                          }}
                          title={accountReady(acc) ? "Conectado" : "Sin conectar"}
                        />
                        <Show when={s.selected.includes(acc.id)} fallback={<div class="size-4" />}>
                          <Icon name="check" class="text-icon-strong-base" />
                        </Show>
                      </div>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>

        {/* STEP 3 — roles & permissions */}
        <Show when={s.step === 3}>
          <div class="flex flex-col gap-4">
            <div class="flex flex-col gap-1.5">
              <span class="text-12-medium text-text-weak">Modo de roles</span>
              <div class="flex flex-wrap gap-1.5">
                <For each={ROLE_MODES}>
                  {(m) => (
                    <button
                      type="button"
                      classList={{
                        "px-3 py-1.5 rounded-md text-12-medium border transition-colors": true,
                        "border-icon-strong-base text-text-strong": s.roleMode === m.id,
                        "border-border-weak-base text-text-weak hover:border-border-strong": s.roleMode !== m.id,
                      }}
                      onClick={() => set("roleMode", m.id)}
                    >
                      {m.label}
                    </button>
                  )}
                </For>
              </div>
              <span class="text-11-regular text-text-weak">
                {ROLE_MODES.find((m) => m.id === s.roleMode)?.hint}
              </span>
            </div>

            <Show
              when={s.roleMode !== "auto"}
              fallback={
                <div class="rounded-md border border-border-weak-base px-4 py-6 text-center text-12-regular text-text-weak">
                  CHAI hará un onboarding de los agentes y asignará los roles automáticamente al iniciar el equipo.
                </div>
              }
            >
              <For each={selectedAccounts()}>
                {(acc) => (
                  <div class="flex flex-col gap-2 rounded-md border border-border-weak-base p-3">
                    <span class="text-13-medium text-text-strong">{acc.label}</span>
                    <div class="flex flex-col gap-1.5">
                      <span class="text-11-medium text-text-weak">Rol</span>
                      <select
                        class="rounded-md border border-border-weak-base bg-transparent px-2 py-1.5 text-12-regular text-text-strong"
                        value={s.roles[acc.id] ?? ROLES[0].id}
                        onChange={(e) => set("roles", acc.id, e.currentTarget.value as Role)}
                      >
                        <For each={ROLES}>{(r) => <option value={r.id}>{r.label}</option>}</For>
                      </select>
                    </div>
                    <div class="flex flex-col gap-1.5">
                      <span class="text-11-medium text-text-weak">Permisos</span>
                      <div class="flex flex-wrap gap-1.5">
                        <For each={PERMISSIONS}>
                          {(p) => (
                            <button
                              type="button"
                              classList={{
                                "px-2 py-1 rounded text-11-medium border transition-colors": true,
                                "border-icon-strong-base text-text-strong": (s.perms[acc.id] ?? []).includes(p.id),
                                "border-border-weak-base text-text-weak hover:border-border-strong": !(
                                  s.perms[acc.id] ?? []
                                ).includes(p.id),
                              }}
                              onClick={() => togglePerm(acc.id, p.id)}
                            >
                              {p.label}
                            </button>
                          )}
                        </For>
                      </div>
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </Show>

        {/* STEP 2 — models */}
        <Show when={s.step === 2}>
          <div class="flex flex-col gap-4">
            <div class="flex flex-col gap-1">
              <span class="text-12-medium text-text-strong">Modelos por agente</span>
              <span class="text-11-regular text-text-weak">
                CHAI consulta el CLI en el runtime aislado y crea botones con los modelos que detecte.
              </span>
            </div>
            <For each={selectedAccounts()}>
              {(acc) => {
                const models = () => s.detectedModels[acc.id] ?? []
                const selected = () => s.models[acc.id]
                return (
                  <div class="flex flex-col gap-2 rounded-md border border-border-weak-base p-3">
                    <div class="flex items-center justify-between gap-2">
                      <div class="flex min-w-0 flex-col">
                        <span class="truncate text-13-medium text-text-strong">{acc.label}</span>
                        <span class="text-11-regular text-text-weak">{providerLabel(acc.provider)}</span>
                      </div>
                      <Button
                        type="button"
                        variant="secondary"
                        size="small"
                        onClick={() => detectModels(acc)}
                        disabled={!!s.detectingModels[acc.id]}
                      >
                        {s.detectingModels[acc.id] ? "Detectando..." : "Detectar modelos"}
                      </Button>
                    </div>
                    <Show
                      when={models().length > 0}
                      fallback={
                        <div class="rounded border border-border-weak-base px-3 py-2 text-11-regular text-text-weak">
                          Pulsa "Detectar modelos" para ver los modelos disponibles, o escribe uno abajo.
                        </div>
                      }
                    >
                      <div class="flex flex-wrap gap-1.5">
                        <For each={models()}>
                          {(model) => (
                            <button
                              type="button"
                              disabled={model.disabled}
                              title={model.disabled ? `${model.value} no está disponible en esta cuenta` : model.value}
                              classList={{
                                "px-2.5 py-1 rounded-md text-11-medium border transition-colors": true,
                                "border-icon-strong-base text-text-strong": !model.disabled && selected() === model.value,
                                "border-border-weak-base text-text-weak hover:border-border-strong":
                                  !model.disabled && selected() !== model.value,
                                "border-border-weak-base text-text-disabled line-through cursor-not-allowed opacity-60":
                                  !!model.disabled,
                              }}
                              onClick={() => !model.disabled && set("models", acc.id, model.value)}
                            >
                              {model.label ?? model.value}
                              {model.disabled ? " (no disponible)" : ""}
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                    <div class="flex flex-col gap-1">
                      <span class="text-10-regular text-text-weak">O escribe un modelo manualmente</span>
                      <input
                        type="text"
                        spellcheck={false}
                        placeholder={KNOWN_MODELS[acc.provider]?.[0]?.value ?? "nombre-del-modelo"}
                        value={selected() ?? ""}
                        onInput={(e) => set("models", acc.id, e.currentTarget.value)}
                        class="rounded-md border border-border-weak-base bg-transparent px-2 py-1.5 text-12-regular text-text-strong placeholder:text-text-weak"
                      />
                    </div>
                    <Show when={selected()}>
                      {(model) => <span class="text-11-regular text-text-weak">Modelo elegido: {model()}</span>}
                    </Show>
                    <Show when={s.modelOutput[acc.id]}>
                      {(output) => (
                        <details class="rounded border border-border-weak-base px-3 py-2">
                          <summary class="cursor-pointer text-11-medium text-text-weak">Salida de diagnostico</summary>
                          <pre class="mt-2 max-h-32 overflow-auto whitespace-pre-wrap text-10-regular text-text-weak">
                            {output()}
                          </pre>
                        </details>
                      )}
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>

        <Show when={s.step === 4}>
          <div class="flex flex-col gap-4">
            <div class="flex flex-col gap-1 rounded-md border border-border-weak-base p-3 text-12-regular">
              <div class="flex justify-between">
                <span class="text-text-weak">Proyecto</span>
                <span class="text-text-strong">{s.name}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-text-weak">Carpeta</span>
                <span class="text-text-strong truncate max-w-[60%]">{s.directory}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-text-weak">Stack</span>
                <span class="text-text-strong">{s.stack}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-text-weak">Modo de roles</span>
                <span class="text-text-strong">{ROLE_MODES.find((m) => m.id === s.roleMode)?.label}</span>
              </div>
            </div>
            <div class="flex flex-col gap-1.5">
              <span class="text-12-medium text-text-weak">Equipo ({selectedAccounts().length})</span>
              <For each={selectedAccounts()}>
                {(acc) => (
                  <div class="flex items-center justify-between gap-3 rounded-md border border-border-weak-base px-3 py-2 text-12-regular">
                    <span class="text-text-strong">{acc.label}</span>
                    <span class="text-text-weak text-right">
                      {s.roleMode === "auto" ? "rol automático" : roleLabel(s.roles[acc.id] ?? ROLES[0].id)}
                      {s.models[acc.id] ? ` · ${s.models[acc.id]}` : ""}
                    </span>
                  </div>
                )}
              </For>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-12-regular text-text-strong">Testing visual</span>
              <button
                type="button"
                classList={{
                  "px-3 py-1 rounded-md text-12-medium border": true,
                  "border-icon-strong-base text-text-strong": s.visualTesting,
                  "border-border-weak-base text-text-weak": !s.visualTesting,
                }}
                onClick={() => set("visualTesting", !s.visualTesting)}
              >
                {s.visualTesting ? "Activado" : "Desactivado"}
              </button>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-12-regular text-text-strong">Control del PC</span>
              <button
                type="button"
                classList={{
                  "px-3 py-1 rounded-md text-12-medium border": true,
                  "border-icon-strong-base text-text-strong": s.computerControl !== "off",
                  "border-border-weak-base text-text-weak": s.computerControl === "off",
                }}
                onClick={() =>
                  set(
                    "computerControl",
                    s.computerControl === "off"
                      ? "approval_required"
                      : s.computerControl === "approval_required"
                        ? "allowed"
                        : "off",
                  )
                }
              >
                {s.computerControl === "off"
                  ? "Desactivado"
                  : s.computerControl === "approval_required"
                    ? "Pide aprobación"
                    : "Permitido"}
              </button>
            </div>
          </div>
        </Show>

        </div>

        {/* footer nav */}
        <div class="flex justify-between gap-2 pt-1">
          <Button
            type="button"
            variant="ghost"
            size="large"
            onClick={() => (s.step === 0 ? dialog.close() : set("step", s.step - 1))}
          >
            {s.step === 0 ? "Cancelar" : "Atrás"}
          </Button>
          <Show
            when={s.step < STEPS.length - 1}
            fallback={
              <Button
                type="button"
                variant="primary"
                size="large"
                onClick={start}
                disabled={selectedAccounts().length === 0 || starting()}
              >
                {starting() ? "Iniciando…" : "Iniciar equipo"}
              </Button>
            }
          >
            <Button type="button" variant="primary" size="large" onClick={() => set("step", s.step + 1)} disabled={!canNext()}>
              Siguiente
            </Button>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
