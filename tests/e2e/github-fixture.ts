import { ObjectId } from "mongodb";
import { createAppJwt } from "../../api/src/integrations/github/app-auth";
import { localTestDatabase } from "./local-database";

/**
 * CI does not automate GitHub's personal login. Bind a real App installation
 * ONLY inside the disposable DB, to the user/workspace created by this run.
 * Repo discovery/linking still use Mako's real GitHub App API calls.
 */
export async function prepareGitHubInstallation(
  workspaceId: string,
  repo: string,
) {
  const client = localTestDatabase(); // Validate before contacting GitHub.
  if (process.env.MAKO_E2E_GITHUB_AUTH !== "installation") {
    throw new Error(
      "GitHub installation fixtures require explicit installation mode.",
    );
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new Error("Invalid test repository.");
  const email = process.env.MAKO_E2E_EMAIL;
  if (!email) throw new Error("The fresh E2E identity is required.");
  const response = await fetch(
    `https://api.github.com/repos/${repo}/installation`,
    {
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${createAppJwt()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!response.ok)
    throw new Error(
      `Test repository installation lookup failed (${response.status}).`,
    );
  const installation = (await response.json()) as {
    id: number;
    app_id: number;
    suspended_at: string | null;
    account: { login: string; type: "Organization" | "User" };
    repository_selection: "all" | "selected";
  };
  if (
    !Number.isSafeInteger(installation.id) ||
    installation.app_id !== Number(process.env.GITHUB_APP_ID) ||
    installation.suspended_at ||
    installation.account.login.toLowerCase() !==
      repo.split("/")[0].toLowerCase()
  )
    throw new Error("Unexpected or suspended GitHub App test installation.");

  try {
    await client.connect();
    const db = client.db();
    const user = await db
      .collection<{
        _id: string;
        email: string;
        emailVerified: boolean;
      }>("users")
      .findOne({
        email: email.toLowerCase(),
        emailVerified: true,
      });
    const workspace =
      user &&
      (await db.collection("workspaces").findOne({
        _id: new ObjectId(workspaceId),
        createdBy: user._id,
        name: /^Mako E2E /,
      }));
    if (!user || !workspace)
      throw new Error(
        "Fixture requires this run's verified user and owned E2E workspace.",
      );
    await db.collection("github_installations").updateOne(
      { workspaceId: workspace._id, installationId: installation.id },
      {
        $setOnInsert: {
          workspaceId: workspace._id,
          installationId: installation.id,
          accountLogin: installation.account.login,
          accountType: installation.account.type,
          repositorySelection: installation.repository_selection,
          createdBy: user._id,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  } finally {
    await client.close();
  }
}
