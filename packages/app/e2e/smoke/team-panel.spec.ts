import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

// Smoke for the CHAI team panel (DialogTeam). Seeds a saved team in localStorage
// (the same cache the app reads via Teams.list()), boots the mocked opencode
// server, opens the panel from the home "Equipo" nav and asserts the real wiring
// renders: the team's agents on the Agentes tab and the run controls on the
// Comunicación tab. It does NOT drive real agents (that needs the desktop CLI
// runner); the create -> onboard -> team -> reopen runtime flow is covered by the
// fast integration smoke in src/state/team-runtime.integration.test.ts.

const directory = "C:/OpenCode/TeamPanelSmoke"
const projectID = "proj_team_panel_smoke"

const team = {
  projectName: "Team Panel Smoke",
  directory,
  stack: "ts",
  roleMode: "manual",
  visualTesting: false,
  computerControl: "off",
  agents: [
    { accountId: "claude-1", provider: "claude", account: "Claude 1", role: "coordinator", permissions: ["read_project"] },
    { accountId: "kimi-1", provider: "kimi", account: "Kimi 1", role: "frontend", permissions: ["edit_project"] },
  ],
}

test("opens the team panel from home and renders agents + controls", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "team-panel-smoke",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        { id: "anthropic", name: "Anthropic", models: { "claude-x": { id: "claude-x", name: "Claude X", limit: { context: 200_000 } } } },
        { id: "moonshotai", name: "Moonshot", models: { "kimi-x": { id: "kimi-x", name: "Kimi X", limit: { context: 200_000 } } } },
      ],
      connected: ["anthropic", "moonshotai"],
      default: { providerID: "anthropic", modelID: "claude-x" },
    },
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })

  // Seed the accounts + team caches the app reads on boot.
  await page.addInitScript(
    ([team]) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "chai.accounts.v1",
        JSON.stringify({
          accounts: [
            { id: "claude-1", provider: "claude", label: "Claude 1", status: "ready" },
            { id: "kimi-1", provider: "kimi", label: "Kimi 1", status: "ready" },
          ],
        }),
      )
      localStorage.setItem("chai.teams.v1", JSON.stringify({ [team.directory]: team }))
    },
    [team] as const,
  )

  await page.goto("/")

  // Open the team panel from the home "Equipo" nav entry.
  const equipoNav = page.getByRole("button", { name: "Equipo" })
  await expectAppVisible(equipoNav)
  await equipoNav.click()

  // Panel header + both agents on the Agentes tab.
  await expectAppVisible(page.getByText("Equipo del proyecto"))
  await expect(page.getByText("Claude 1")).toBeVisible()
  await expect(page.getByText("Kimi 1")).toBeVisible()

  // Switch to Comunicación and assert the run controls are wired.
  await page.getByRole("button", { name: "Comunicación" }).click()
  await expect(page.getByRole("button", { name: "Onboarding" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Enviar al equipo" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Enviar al agente" })).toBeVisible()
})
