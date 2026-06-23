import * as cheerio from "cheerio";
import { extractText, getDocumentProxy } from "unpdf";

const HTML_CONTENT_SELECTORS = [
  "article",
  "main",
  '[role="main"]',
  ".post-content",
  ".entry-content",
  ".article-content",
] as const;

export interface ExtractReadableResult {
  title: string;
  content: string;
  contentType: string;
  truncated: boolean;
  unsupported?: boolean;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateText(
  text: string,
  maxChars: number,
): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: text.slice(0, maxChars),
    truncated: true,
  };
}

function extractHtmlTitle($: cheerio.CheerioAPI, url: string): string {
  return (
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $("title").text().trim() ||
    $("h1").first().text().trim() ||
    url
  );
}

function extractHtmlContent($: cheerio.CheerioAPI): string {
  $(
    "script, style, nav, header, footer, aside, noscript, iframe, form, [role='navigation'], [role='banner'], [role='complementary']",
  ).remove();

  for (const selector of HTML_CONTENT_SELECTORS) {
    const candidate = $(selector).first();
    if (candidate.length && candidate.text().trim().length > 200) {
      return collapseWhitespace(candidate.text());
    }
  }

  return collapseWhitespace($("body").text());
}

async function extractPdfText(body: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(body));
  const { text } = await extractText(pdf, { mergePages: true });
  return collapseWhitespace(text);
}

export async function extractReadable(
  body: Buffer,
  contentType: string,
  url: string,
  maxChars: number,
): Promise<ExtractReadableResult> {
  const normalizedType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";

  if (
    normalizedType.includes("text/html") ||
    normalizedType.includes("application/xhtml+xml")
  ) {
    const html = body.toString("utf8");
    const $ = cheerio.load(html);
    const title = extractHtmlTitle($, url);
    const content = extractHtmlContent($);
    const { text, truncated } = truncateText(content, maxChars);
    return { title, content: text, contentType: normalizedType, truncated };
  }

  if (normalizedType === "application/pdf") {
    const content = await extractPdfText(body);
    const { text, truncated } = truncateText(content, maxChars);
    return {
      title: url,
      content: text,
      contentType: normalizedType,
      truncated,
    };
  }

  if (
    normalizedType.startsWith("text/") ||
    normalizedType === "application/json" ||
    normalizedType === "application/csv" ||
    normalizedType === "text/csv"
  ) {
    const content = collapseWhitespace(body.toString("utf8"));
    const { text, truncated } = truncateText(content, maxChars);
    return {
      title: url,
      content: text,
      contentType: normalizedType,
      truncated,
    };
  }

  return {
    title: url,
    content: `Unsupported content type: ${normalizedType || contentType}`,
    contentType: normalizedType || contentType,
    truncated: false,
    unsupported: true,
  };
}
