import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { describe, test, type Cookie } from "@e2e-dev/web";
import { credentials, expect, secrets, unique } from "e2e";
import { prepareGitHubInstallation } from "./github-fixture";

const installationFixture = process.env.MAKO_E2E_GITHUB_AUTH === "installation";

// Serial steps share the freshly registered user's browser, never an admin seed.
describe("Mako new user", { serial: true }, () => {
  test("01 create account and verify email", async ({
    app,
    screen,
    browser,
    agent,
  }) => {
    await app.open("/register");
    const user = credentials.user("signup");
    // Serial retries restart at registration against the same local database.
    // Each attempt therefore needs a new account, also shared with OTP/fixture helpers.
    const email = installationFixture
      ? `mako-e2e+${randomUUID()}@example.test`
      : user.username;
    process.env.MAKO_E2E_EMAIL = email;
    await agent.act(
      "Submit the registration form with {email} and {password}. This goal succeeds when the email verification code form appears. Stop there; email verification is a separate next step.",
      { params: { email: unique(email), password: user.password } },
    );
    await expect(browser).toHaveURL(/\/verify-email/);
    await agent.act(
      "Verify the email using verification code {code}. Stop when the workspace creation form appears.",
      {
        params: { code: secrets.get("verificationCode") },
      },
    );
    await expect(screen.getByLabel("Workspace name")).toBeVisible();
  });

  test("02 create workspace", async ({ screen, agent }) => {
    await agent.act(
      "Create a workspace named {name}. This goal succeeds as soon as the What's your role? question appears. Stop there without answering any onboarding questions.",
      {
        params: { name: unique(`Mako E2E ${randomUUID()}`) },
      },
    );
    await expect(
      screen.getByText("What's your role?", { exact: true }),
    ).toBeVisible();
  });

  test("03 answer qualification quiz", async ({ screen, browser, agent }) => {
    const [saved] = await Promise.all([
      browser.waitForResponse("**/api/auth/onboarding", { timeout: 240_000 }),
      agent.act(
        "Complete the qualification quiz with role {role}, company size {companySize}, primary database {database}, and data warehouse {warehouse}. Stop on Choose your path without selecting a path.",
        {
          params: {
            role: "Developer / Engineer",
            companySize: "Hobby / Personal project",
            database: "PostgreSQL",
            warehouse: "I don't have one yet",
          },
        },
      ),
    ]);
    // The UI intentionally tolerates a failed save; verify the real response too.
    expect(saved.status).toBe(200);
    expect((await saved.json()) as unknown).toMatchObject({ success: true });
    await expect(
      screen.getByText("Choose your path", { exact: true }),
    ).toBeVisible();
  });

  test("04 connect demo database", async ({ screen, browser, agent }) => {
    // Onboarding requires a database before Settings > GitHub is available.
    const [created] = await Promise.all([
      browser.waitForResponse("**/databases/demo", { timeout: 240_000 }),
      agent.act(
        "Start Exploring with the demo database. Stop as soon as the workspace shows the Chinook Music Store connection; do not open GitHub settings or send a chat.",
      ),
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

  test(
    installationFixture
      ? "05 prepare real GitHub App installation (CI fixture; excludes OAuth)"
      : "05 connect GitHub account through OAuth",
    async ({ app, browser, screen, agent }) => {
      const statePath = process.env.MAKO_E2E_GITHUB_STATE;
      const repo = process.env.MAKO_E2E_GITHUB_REPO;
      if (
        (!installationFixture && !statePath) ||
        !repo ||
        !/^[\w.-]+\/[\w.-]+$/.test(repo)
      ) {
        throw new Error(
          "Full journey requires MAKO_E2E_GITHUB_STATE (dedicated GitHub test account, Mako App already authorized) and MAKO_E2E_GITHUB_REPO=owner/test-repo. See tests/e2e/README.md.",
        );
      }
      if (installationFixture) {
        const workspaceId = await browser.evaluate(() =>
          localStorage.getItem("activeWorkspaceId"),
        );
        if (!workspaceId)
          throw new Error("Fresh workspace missing from browser.");
        await prepareGitHubInstallation(workspaceId, repo);
        // No personal login in CI. Only the third-party OAuth navigation is
        // blocked; Mako's sync URL, installation status and repository APIs stay real.
        await browser.route("https://github.com/login/**", route =>
          route.abort(),
        );
      } else {
        const state = JSON.parse(await readFile(statePath!, "utf8")) as {
          cookies: Cookie[];
        };
        const githubCookies = state.cookies.filter(
          cookie =>
            cookie.domain === "github.com" || cookie.domain === ".github.com",
        );
        expect(githubCookies.length).toBeGreaterThan(0);
        await browser.setCookies(githubCookies);
      }
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
        browser.waitForResponse("**/apps/github-sync-url", {
          timeout: 240_000,
        }),
        agent.act(
          "Open Connect GitHub repository. Stop once the Add GitHub repository dialog is open; do not link a repository yet.",
        ),
      ]);
      if (sync.status !== 200) {
        const result = (await sync.json()) as { error?: string };
        throw new Error(
          `Mako GitHub OAuth setup failed (${sync.status}): ${result.error ?? "unknown error"}`,
        );
      }
      // OAuth mode discovers the installation via the real popup. CI checks
      // the same authenticated status API against its explicit local fixture.
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
    },
  );

  test("06 link GitHub repository", async ({ screen, browser, agent }) => {
    const repo = process.env.MAKO_E2E_GITHUB_REPO!;
    await agent.act(
      "Connect the existing GitHub repository {repo} under account {owner} to this workspace. Do not create or modify any repository.",
      {
        params: { repo, owner: repo.split("/")[0] },
      },
    );
    await expect(
      screen.getByRole("dialog", "Add GitHub repository"),
    ).not.toBeVisible({ timeout: 60_000 });
    await browser.reload();
    await expect(screen.getByText(repo, { exact: true })).toBeVisible();
  });

  test("07 send chat and receive assistant response", async ({
    app,
    screen,
    agent,
  }) => {
    await app.open("/");
    await agent.act(
      "Send {message} in a new Mako chat and wait for the assistant's answer. Close the GitHub settings tab if it hides the chat.",
      {
        params: {
          message:
            "What is 19 plus 23? Reply with the number only. Do not use tools or modify any files.",
        },
      },
    );
    // The expected reply is deliberately absent from the user message.
    await expect(screen.getByText("42", { exact: true })).toBeVisible({
      timeout: 120_000,
    });
    await expect(
      screen.getByRole("button", "Stop generating"),
    ).not.toBeVisible();
  });

  test("08 execute SQL and inspect results", async ({
    screen,
    browser,
    agent,
  }) => {
    await agent.act(
      "Open a SQL Console and select the Chinook Music Store connection.",
    );
    await expect(
      screen.getByRole("button", "Run (⌘/Ctrl+Enter)", { exact: true }),
    ).toBeVisible();
    const editor = browser.locator(".monaco-editor .view-lines").first();
    await editor.tap();
    await browser.keyboard.press("ControlOrMeta+A");
    await browser.keyboard.type("SELECT 19 + 23 AS mako_e2e_answer");
    await agent.act(
      "Run the SQL already present in the console editor and display its result table. Do not edit the SQL.",
    );
    await expect(
      screen.getByRole("columnheader", /mako_e2e_answer/),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      screen.getByRole("gridcell", "42", { exact: true }),
    ).toBeVisible();
  });
});
