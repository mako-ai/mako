import React from "react";
import { ArrowUpRight, Globe } from "lucide-react";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "../ui/trace";

export interface MessageSource {
  url: string;
  title?: string;
}

export const MessageSources = React.memo(function MessageSources({
  sources,
}: {
  sources: MessageSource[];
}) {
  const seen = new Set<string>();
  const links = sources.flatMap(source => {
    try {
      const url = new URL(source.url);
      if (!["http:", "https:"].includes(url.protocol) || seen.has(url.href)) {
        return [];
      }
      seen.add(url.href);
      return [{ url: url.href, title: source.title?.trim() || url.hostname }];
    } catch {
      return [];
    }
  });

  if (links.length === 0) return null;

  return (
    <Trace className="my-1">
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine className="min-h-7">
            <TraceIcon>
              <Globe />
            </TraceIcon>
            <TraceTitle>
              Used {links.length} {links.length === 1 ? "source" : "sources"}
            </TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace className="gap-2">
            {links.map(source => (
              <a
                key={source.url}
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                title={source.title}
              >
                <TraceLine>
                  <TraceIcon>
                    <Globe />
                  </TraceIcon>
                  <TraceTitle>
                    {source.title}
                    <span className="sr-only"> (opens in a new tab)</span>
                  </TraceTitle>
                  <TraceIcon>
                    <ArrowUpRight />
                  </TraceIcon>
                </TraceLine>
              </a>
            ))}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
});
