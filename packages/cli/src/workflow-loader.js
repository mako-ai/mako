// Module hooks for a test run (registered by workflow-runner.js): a
// workflow's `../hatchet` is the stand-in, its `../lib/mako` is the file the
// workers use, and the packages a workflow may import come from the CLI's
// own dependencies when the checkout has no node_modules.
let data;

export function initialize(options) {
  data = options;
}

export async function resolve(specifier, context, next) {
  const parent = context.parentURL;
  if (parent?.startsWith(data.workflowsURL) && specifier.startsWith(".")) {
    const target = new URL(specifier, parent).href.replace(/\.ts$/, "");
    const supplied = data.supplied[target.slice(data.workflowsURL.length)];
    // Through the chain, so tsx loads it as TypeScript on any Node.
    if (supplied) return next(supplied, context);
  }
  try {
    const resolved = await next(specifier, context);
    // Workflow code is ES modules, as the workers build it, whatever the
    // checkout's package.json says.
    return resolved.url.startsWith(data.workflowsURL) &&
      /\.[cm]?ts$/.test(resolved.url)
      ? { ...resolved, format: "module" }
      : resolved;
  } catch (error) {
    const bare = !/^(\.|\/|file:|node:)/.test(specifier);
    if (error?.code !== "ERR_MODULE_NOT_FOUND" || !bare) throw error;
    return next(specifier, { ...context, parentURL: data.packagesURL });
  }
}
