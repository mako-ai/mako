import React from "react";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export const mdxComponents = {
  h1: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h1
      className="text-4xl font-bold mt-12 mb-6 text-zinc-900 dark:text-white"
      {...props}
    >
      {children}
    </h1>
  ),
  h2: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => {
    const id = typeof children === "string" ? slugify(children) : undefined;
    return (
      <h2
        id={id}
        className="text-2xl font-bold mt-10 mb-4 text-zinc-900 dark:text-white scroll-mt-24"
        {...props}
      >
        {children}
      </h2>
    );
  },
  h3: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => {
    const id = typeof children === "string" ? slugify(children) : undefined;
    return (
      <h3
        id={id}
        className="text-xl font-semibold mt-8 mb-3 text-zinc-900 dark:text-white scroll-mt-24"
        {...props}
      >
        {children}
      </h3>
    );
  },
  p: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p
      className="text-base leading-7 text-zinc-600 dark:text-zinc-300 mb-6"
      {...props}
    >
      {children}
    </p>
  ),
  a: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      href={href}
      className="text-blue-600 dark:text-blue-400 underline underline-offset-2 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
      target={href?.startsWith("http") ? "_blank" : undefined}
      rel={href?.startsWith("http") ? "noopener noreferrer" : undefined}
      {...props}
    >
      {children}
    </a>
  ),
  ul: ({ children, ...props }: React.HTMLAttributes<HTMLUListElement>) => (
    <ul
      className="list-disc pl-6 mb-6 space-y-2 text-zinc-600 dark:text-zinc-300"
      {...props}
    >
      {children}
    </ul>
  ),
  ol: ({ children, ...props }: React.HTMLAttributes<HTMLOListElement>) => (
    <ol
      className="list-decimal pl-6 mb-6 space-y-2 text-zinc-600 dark:text-zinc-300"
      {...props}
    >
      {children}
    </ol>
  ),
  li: ({ children, ...props }: React.HTMLAttributes<HTMLLIElement>) => (
    <li className="text-base leading-7" {...props}>
      {children}
    </li>
  ),
  blockquote: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLQuoteElement>) => (
    <blockquote
      className="border-l-4 border-zinc-300 dark:border-zinc-600 pl-4 italic text-zinc-500 dark:text-zinc-400 my-6"
      {...props}
    >
      {children}
    </blockquote>
  ),
  code: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => {
    const isInline = !props.className;
    if (isInline) {
      return (
        <code className="px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-sm font-mono text-zinc-800 dark:text-zinc-200">
          {children}
        </code>
      );
    }
    return (
      <code className={props.className} {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children, ...props }: React.HTMLAttributes<HTMLPreElement>) => (
    <pre
      className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 p-4 overflow-x-auto mb-6 text-sm font-mono"
      {...props}
    >
      {children}
    </pre>
  ),
  hr: () => <hr className="border-zinc-200 dark:border-zinc-800 my-10" />,
  strong: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => (
    <strong className="font-semibold text-zinc-900 dark:text-white" {...props}>
      {children}
    </strong>
  ),
  em: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => (
    <em className="italic" {...props}>
      {children}
    </em>
  ),
  table: ({ children, ...props }: React.HTMLAttributes<HTMLTableElement>) => (
    <div className="overflow-x-auto mb-6">
      <table className="w-full text-sm border-collapse" {...props}>
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...props }: React.HTMLAttributes<HTMLTableCellElement>) => (
    <th
      className="border border-zinc-200 dark:border-zinc-700 px-4 py-2 text-left font-semibold bg-zinc-50 dark:bg-zinc-800 text-zinc-900 dark:text-white"
      {...props}
    >
      {children}
    </th>
  ),
  td: ({ children, ...props }: React.HTMLAttributes<HTMLTableCellElement>) => (
    <td
      className="border border-zinc-200 dark:border-zinc-700 px-4 py-2 text-zinc-600 dark:text-zinc-300"
      {...props}
    >
      {children}
    </td>
  ),
};
