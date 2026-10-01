/**
 * The header's "published · <sha>" chip, with the context a bare sha lacks:
 * when it went live, which commit it is (author, subject), whether main has
 * app changes that are not live yet, and why the last deploy failed.
 *
 * The date comes from the app row and is there immediately; the rest comes
 * from GET /publish-state, fetched when the app opens, when the published
 * sha moves, and each time the tooltip opens (a cheap read from git).
 */
import { useEffect } from "react";
import { Box, Chip, Tooltip, Typography } from "@mui/material";
import { formatDistanceToNowStrict } from "date-fns";
import { useAppsStore } from "../store/appsStore";
import { formatRelativeTimeCompact, toDate } from "../utils/relative-time";

function absolute(value: string | number | null | undefined): string {
  const date = toDate(value);
  return date
    ? date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "";
}

function relative(value: string | number | null | undefined): string {
  const date = toDate(value);
  return date ? formatDistanceToNowStrict(date, { addSuffix: true }) : "";
}

export default function AppPublishedChip({
  workspaceId,
  appId,
  publishedSha,
  publishedAt,
  liveUrl,
  building,
  onPublish,
}: {
  workspaceId?: string;
  appId: string;
  publishedSha?: string;
  publishedAt?: string;
  liveUrl?: string;
  building?: boolean;
  onPublish: () => void;
}) {
  const fetchPublishState = useAppsStore(s => s.fetchPublishState);
  const cached = useAppsStore(s => s.publishStateByApp[appId]);
  // A state fetched for an earlier deployment says nothing about this one.
  const state =
    cached && cached.publishedSha === publishedSha ? cached : undefined;

  useEffect(() => {
    if (workspaceId && publishedSha) {
      void fetchPublishState(workspaceId, appId);
    }
  }, [workspaceId, appId, publishedSha, fetchPublishState]);

  if (!publishedSha) {
    return (
      <Tooltip title="Nobody can see this app yet. Click to publish it from main.">
        <Chip
          label="not published"
          size="small"
          color="warning"
          variant="outlined"
          // Not published → this IS the call to action, publish.
          onClick={building ? undefined : onPublish}
        />
      </Tooltip>
    );
  }

  const short = publishedSha.slice(0, 7);
  const deployError = state?.lastDeployError ?? null;
  const commit = state?.publishedCommit ?? null;
  // Freshness only when the server could read the published commit; an
  // unknown state must not read as either "up to date" or "stale".
  const pending =
    state && commit
      ? state.upToDate
        ? 0
        : (state.pendingCommits ?? null)
      : undefined;
  const branch = state?.branch ?? "main";
  const freshness =
    pending === undefined
      ? null
      : pending === 0
        ? `✓ Up to date with ${branch}`
        : pending === null
          ? `⚠ ${branch} has changes that are not live`
          : `⚠ ${pending} newer commit${pending === 1 ? "" : "s"} on ${branch} ${pending === 1 ? "is" : "are"} not live`;
  const age = publishedAt
    ? formatRelativeTimeCompact(publishedAt, { absoluteAfterDays: 30 })
    : null;

  const title = (
    <Box sx={{ py: 0.25, maxWidth: 360 }}>
      <Typography variant="caption" component="div" sx={{ fontWeight: 600 }}>
        {publishedAt
          ? `Published ${relative(publishedAt)} · ${absolute(publishedAt)}`
          : "Published"}
      </Typography>
      {commit ? (
        <>
          <Typography variant="caption" component="div">
            <Box component="span" sx={{ fontFamily: "monospace" }}>
              {short}
            </Box>{" "}
            {commit.subject}
          </Typography>
          <Typography variant="caption" component="div" sx={{ opacity: 0.8 }}>
            by {commit.author} · committed {absolute(commit.timestamp)}
          </Typography>
        </>
      ) : (
        <Typography variant="caption" component="div" sx={{ opacity: 0.8 }}>
          Commit{" "}
          <Box component="span" sx={{ fontFamily: "monospace" }}>
            {short}
          </Box>
          {state ? "" : " · loading details…"}
        </Typography>
      )}
      {freshness && (
        <Typography variant="caption" component="div" sx={{ mt: 0.5 }}>
          {freshness}
        </Typography>
      )}
      {deployError && (
        <Typography variant="caption" component="div">
          ⚠ Last deploy failed ({deployError.stage}):{" "}
          {deployError.message.split("\n")[0].slice(0, 160)}
        </Typography>
      )}
      {liveUrl && (
        <Typography
          variant="caption"
          component="div"
          sx={{ mt: 0.5, opacity: 0.8 }}
        >
          Click to open the live app.
        </Typography>
      )}
    </Box>
  );

  const stale = (pending !== undefined && pending !== 0) || !!deployError;

  return (
    <Tooltip
      title={title}
      onOpen={() => {
        if (workspaceId) void fetchPublishState(workspaceId, appId);
      }}
    >
      <Chip
        label={age ? `published · ${short} · ${age}` : `published · ${short}`}
        size="small"
        color={stale ? "warning" : "default"}
        variant="outlined"
        // Published → the chip opens the live app.
        onClick={
          liveUrl ? () => window.open(liveUrl, "_blank", "noopener") : undefined
        }
      />
    </Tooltip>
  );
}
