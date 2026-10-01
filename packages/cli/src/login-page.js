/** Self-contained: the loopback callback must render without network access. */
export function loginPage(status, error = "") {
  const approved = status === "approved";
  const denied = status === "denied";
  const title = approved ? "Connection approved" : denied ? "Connection declined" : "Unable to connect";
  const description = approved
    ? "Your browser step is complete. Return to your terminal to finish signing in to Mako."
    : denied
      ? "You declined this connection. If you change your mind, start again from your terminal."
      : "We couldn’t complete this sign-in. Return to your terminal and try again.";
  const detail = String(error).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>${title} — Mako</title>
  <style>
    :root { color-scheme: light; --page: #f6f5f1; --surface: #fff;
      --ink: #1a1a1a; --muted: #555; --border: #d8d5cc;
      --shadow: #e3e0d7; --accent: #6c4fd8; --tint: #f0ecfc; }
    @media (prefers-color-scheme: dark) {
      :root { color-scheme: dark; --page: #161513; --surface: #201e1a;
        --ink: #edeae3; --muted: #b8b3a9; --border: #55504a;
        --shadow: #302c26; --accent: #b7a5ff; --tint: #30283e; }
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; min-height: 100svh; padding: 32px 24px;
      display: flex; align-items: center; justify-content: center;
      background: var(--page); color: var(--ink);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .card { width: 100%; max-width: 486px; padding: 32px;
      background: var(--surface); border: 1px solid var(--border);
      box-shadow: 6px 6px 0 var(--shadow); overflow-wrap: anywhere; }
    .brand { font: 600 12px ui-monospace, monospace; letter-spacing: 0.14em;
      margin-bottom: 36px; }
    .status { width: 48px; height: 48px; display: grid; place-items: center;
      margin-bottom: 24px; color: var(--accent); background: var(--tint);
      border: 1px solid var(--accent); }
    .status svg { width: 24px; height: 24px; }
    h1 { margin: 0 0 12px; font-size: 28px; letter-spacing: -0.035em;
      line-height: 1.2; font-weight: 600; }
    p { margin: 0; font-size: 14px; line-height: 1.7; color: var(--muted); }
    .next { margin-top: 28px; padding: 16px; background: var(--page);
      border: 1px solid var(--border); }
    .next strong { display: block; font-size: 13px; margin-bottom: 4px; }
    code { font: 13px ui-monospace, monospace; color: var(--ink); }
    .detail { margin-top: 16px; }
    footer { border-top: 1px solid var(--border); padding-top: 20px;
      margin-top: 28px; font-size: 12px; color: var(--muted); }
    @media (max-width: 480px) { .card { padding: 24px; } h1 { font-size: 24px; } }
  </style>
</head>
<body>
  <main class="card">
    <div class="brand">MAKO / CLI</div>
    <div class="status" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
        ${approved ? '<path d="m5 12 4 4L19 6" />' : denied ? '<path d="m6 6 12 12M18 6 6 18" />' : '<path d="M12 5v9m0 4h.01" />'}
      </svg>
    </div>
    <h1>${title}</h1>
    <p>${description}</p>
    <div class="next">
      <strong>${approved ? "Continue in your terminal" : "Start a new sign-in"}</strong>
      <p>${approved ? "Your CLI will confirm when you’re signed in." : "Run <code>mako login</code> to reconnect."}</p>
    </div>
    ${detail ? `<p class="detail">Error: <code>${detail}</code></p>` : ""}
    <footer>You can safely close this tab.</footer>
  </main>
</body>
</html>`;
}
