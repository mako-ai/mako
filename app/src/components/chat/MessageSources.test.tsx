// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MessageSources } from "./MessageSources";

afterEach(cleanup);

describe("message sources", () => {
  it("deduplicates URLs, rejects unsafe links, and uses the hostname for untitled sources", () => {
    render(
      <MessageSources
        sources={[
          { url: "https://example.com", title: "Reference" },
          { url: "https://example.com/", title: "Repeated reference" },
          { url: "https://docs.example.com/guide" },
          { url: "javascript:alert(1)", title: "Unsafe" },
          { url: "not a url", title: "Malformed" },
        ]}
      />,
    );
    expect(screen.queryByRole("link")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Used 2 sources" }));
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute("href")).toBe("https://example.com/");
    expect(links[1].textContent).toBe("docs.example.com (opens in a new tab)");
  });

  it("renders nothing when no valid sources exist", () => {
    const { container } = render(<MessageSources sources={[]} />);
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
