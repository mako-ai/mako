import { tavily } from "@tavily/core";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchProvider {
  search(
    query: string,
    maxResults: number,
    signal?: AbortSignal,
  ): Promise<WebSearchResult[]>;
}

class TavilyWebSearchProvider implements WebSearchProvider {
  constructor(private readonly apiKey: string) {}

  async search(
    query: string,
    maxResults: number,
    signal?: AbortSignal,
  ): Promise<WebSearchResult[]> {
    if (signal?.aborted) {
      throw new Error("Web search aborted");
    }

    const client = tavily({ apiKey: this.apiKey });
    const response = await client.search(query, {
      maxResults,
      includeAnswer: false,
      includeRawContent: false,
    });

    if (signal?.aborted) {
      throw new Error("Web search aborted");
    }

    return response.results.map(result => ({
      title: result.title,
      url: result.url,
      snippet: result.content,
    }));
  }
}

export function getWebSearchProvider(): WebSearchProvider | null {
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  if (!apiKey) return null;
  return new TavilyWebSearchProvider(apiKey);
}
