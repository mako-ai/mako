import { readFile } from "node:fs/promises";
import { describe, test, type Cookie } from "@e2e-dev/web";
import { credentials, expect, secrets } from "e2e";

// Serial steps share the freshly registered user's browser, never an admin seed.
describe("Mako new user", { serial: true }, () => {
  test("01 create account and verify email", async ({
    app,
    screen,
    browser,
  }) => {
    await app.open("/register");
    const user = credentials.user("signup");
    await screen.getByPlaceholder("youremail@email.com").fill(user.username);
    await screen
      .getByPlaceholder("Enter a unique password")
      .fill(user.password);
    await screen.getByRole("button", "Continue", { exact: true }).tap();
    await expect(browser).toHaveURL(/\/verify-email/);
    await screen
      .getByLabel("Verification Code")
      .fill(secrets.get("verificationCode"));
    await screen.getByRole("button", "Verify Email").tap();
    await expect(screen.getByLabel("Workspace name")).toBeVisible();
  });

  test("02 create workspace", async ({ screen }) => {
    await screen.getByLabel("Workspace name").fill(`Mako E2E ${Date.now()}`);
    await screen.getByRole("button", "Create Workspace").tap();
    await expect(
      screen.getByText("What's your role?", { exact: true }),
    ).toBeVisible();
  });

  test("03 answer qualification quiz", async ({ screen, browser }) => {
    for (const answer of [
      "Developer / Engineer",
      "Hobby / Personal project",
      "PostgreSQL",
    ]) {
      await screen.getByText(answer, { exact: true }).tap();
      await screen.getByRole("button", "Next", { exact: true }).tap();
    }
    await screen.getByText("I don't have one yet", { exact: true }).tap();
    const [saved] = await Promise.all([
      browser.waitForResponse("**/api/auth/onboarding"),
      screen.getByRole("button", "Continue", { exact: true }).tap(),
    ]);
    // The UI intentionally tolerates a failed save; verify the real response too.
    expect(saved.status).toBe(200);
    expect((await saved.json()) as unknown).toMatchObject({ success: true });
    await expect(
      screen.getByText("Choose your path", { exact: true }),
    ).toBeVisible();
  });

  test("04 connect demo database", async ({ screen, browser }) => {
    // Onboarding requires a database before Settings > GitHub is available.
    const [created] = await Promise.all([
      browser.waitForResponse("**/databases/demo"),
      screen.getByRole("button", "Start Exploring", { exact: true }).tap(),
    ]);
    expect(created.status).toBe(201);
    const connection = (await created.json()) as { data: { id: string } };
    await expect(
      screen.getByText("Chinook Music Store", { exact: true }).first(),
    ).toBeVisible({ timeout: 60_000 });
    await browser.reload();
    await expect(
      screen.getByText("Chinook Music Store", { exact: true }).first(),
    ).toBeVisible();
    // Saving demo configuration alone does not prove the database is reachable.
    const probe = await browser.evaluate(async id => {
      const workspace = localStorage.getItem("activeWorkspaceId");
      const response = await fetch(
        `/api/workspaces/${workspace}/databases/${id}/test`,
        { method: "POST" },
      );
      if (!response.ok)
        throw new Error(`Database probe failed: ${response.status}`);
      return response.json();
    }, connection.data.id);
    expect(probe as unknown).toMatchObject({ success: true });
  });

  test("05 connect GitHub account", async ({ app, browser, screen }) => {
    const statePath = process.env.MAKO_E2E_GITHUB_STATE;
    const repo = process.env.MAKO_E2E_GITHUB_REPO;
    if (!statePath || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      throw new Error(
        "Full journey requires MAKO_E2E_GITHUB_STATE (dedicated GitHub test account, Mako App already authorized) and MAKO_E2E_GITHUB_REPO=owner/test-repo. See tests/e2e/README.md.",
      );
    }
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      cookies: Cookie[];
    };
    const githubCookies = state.cookies.filter(
      cookie =>
        cookie.domain === "github.com" || cookie.domain === ".github.com",
    );
    expect(githubCookies.length).toBeGreaterThan(0);
    await browser.setCookies(githubCookies);
    const [configuration] = await Promise.all([
      browser.waitForResponse("**/apps/github-status"),
      app.open("/settings/github"),
    ]);
    expect(configuration.status).toBe(200);
    const github = (await configuration.json()) as {
      appConfigured: boolean;
      appSlug: string | null;
    };
    if (!github.appConfigured || !github.appSlug) {
      throw new Error(
        "Mako API is missing GitHub App configuration (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_SLUG). The saved browser session cannot replace these server credentials.",
      );
    }
    const [sync] = await Promise.all([
      browser.waitForResponse("**/apps/github-sync-url"),
      screen.getByRole("button", "Connect GitHub repository").tap(),
    ]);
    if (sync.status !== 200) {
      const result = (await sync.json()) as { error?: string };
      throw new Error(
        `Mako GitHub OAuth setup failed (${sync.status}): ${result.error ?? "unknown error"}`,
      );
    }
    // The real OAuth sync runs in Mako's popup using the dedicated GitHub session.
    await expect
      .poll(
        async () =>
          browser.evaluate(async () => {
            const id = localStorage.getItem("activeWorkspaceId");
            const response = await fetch(
              `/api/workspaces/${id}/apps/github-status`,
            );
            if (!response.ok)
              throw new Error(`GitHub status failed: ${response.status}`);
            return response.json();
          }),
        { timeout: 60_000 },
      )
      .toMatchObject({
        installations: expect.arrayContaining([
          expect.objectContaining({ accountLogin: repo.split("/")[0] }),
        ]),
      });
    await browser.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(screen.getByLabel("GitHub account")).toBeVisible();
  });

  test("06 link GitHub repository", async ({ screen, browser }) => {
    const repo = process.env.MAKO_E2E_GITHUB_REPO!;
    await screen.getByLabel("GitHub account").tap();
    await screen
      .getByRole("option")
      .getByText(repo.split("/")[0], { exact: true })
      .tap();
    await screen.getByRole("combobox", "Repository").fill(repo);
    await screen.getByRole("option", repo, { exact: true }).tap();
    await screen.getByRole("button", "Connect", { exact: true }).tap();
    await expect(
      screen.getByRole("dialog", "Add GitHub repository"),
    ).not.toBeVisible({ timeout: 60_000 });
    await browser.reload();
    await expect(screen.getByText(repo, { exact: true })).toBeVisible();
    await screen
      .getByRole("tab", "GitHub", { exact: true })
      .getByRole("button")
      .tap();
  });

  test("07 send chat and receive assistant response", async ({
    app,
    screen,
  }) => {
    await app.open("/");
    await screen
      .getByPlaceholder("Ask Chat...")
      .fill(
        "What is 19 plus 23? Reply with the number only. Do not use tools or modify any files.",
      );
    await screen.getByRole("button", "Send message", { exact: true }).tap();
    // The expected reply is deliberately absent from the user message.
    await expect(screen.getByText("42", { exact: true })).toBeVisible({
      timeout: 120_000,
    });
    await expect(
      screen.getByRole("button", "Stop generating"),
    ).not.toBeVisible();
  });

  test("08 execute SQL and inspect results", async ({ screen, browser }) => {
    await screen.getByRole("button", "Open Console", { exact: true }).tap();
    await screen
      .getByPlaceholder("Select connection")
      .fill("Chinook Music Store");
    await screen.getByRole("option", /Chinook Music Store/).tap();
    await expect(
      screen.getByRole("button", "Run (⌘/Ctrl+Enter)", { exact: true }),
    ).toBeVisible();
    const editor = browser.locator(".monaco-editor .view-lines").first();
    await editor.tap();
    await browser.keyboard.press("ControlOrMeta+A");
    await browser.keyboard.type("SELECT 19 + 23 AS mako_e2e_answer");
    await screen
      .getByRole("button", "Run (⌘/Ctrl+Enter)", { exact: true })
      .tap();
    await expect(
      screen.getByRole("columnheader", /mako_e2e_answer/),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      screen.getByRole("gridcell", "42", { exact: true }),
    ).toBeVisible();
  });
});
