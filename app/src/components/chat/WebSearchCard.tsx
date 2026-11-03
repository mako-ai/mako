import React from "react";
import { Search } from "lucide-react";
import {
  Trace,
  TraceIcon,
  TraceLine,
  TraceTitle,
  TraceDescription,
} from "../ui/trace";
import { MessageSources, type MessageSource } from "./MessageSources";

export interface WebSearchResultItem {
  title?: string;
  url?: string;
  snippet?: string;
}

interface WebSearchCardProps {
  state: string;
  input?: unknown;
  output?: unknown;
}

export const WebSearchCard = React.memo(function WebSearchCard({
  state,
  input,
  output,
}: WebSearchCardProps) {
  const query =
    typeof (input as { query?: unknown } | undefined)?.query === "string"
      ? (input as { query: string }).query
      : "";
  const out = output as { results?: WebSearchResultItem[] } | undefined;
  const done = state === "output-available";
  const sources: MessageSource[] =
    done && Array.isArray(out?.results)
      ? out.results.flatMap(result =>
          typeof result?.url === "string"
            ? [
                {
                  url: result.url,
                  title:
                    typeof result.title === "string" ? result.title : undefined,
                },
              ]
            : [],
        )
      : [];

  return (
    <Trace className="my-1 gap-0">
      <TraceLine status={done ? undefined : "running"} className="min-h-7">
        <TraceIcon>
          <Search />
        </TraceIcon>
        <TraceTitle>
          {done ? "Searched the web" : "Searching the web"}
        </TraceTitle>
        {query && (
          <TraceDescription className="min-w-0 shrink truncate text-xs">
            {query}
          </TraceDescription>
        )}
      </TraceLine>
      <MessageSources sources={sources} />
    </Trace>
  );
});
