/**
 * The Monaco namespace type. @monaco-editor/react's own `Monaco` type points
 * at "monaco-editor/esm/vs/editor/editor.api", which monaco-editor >= 0.55's
 * `exports` map no longer resolves, so it silently degrades to `any`.
 */
export type Monaco = typeof import("monaco-editor");

type MonacoReact = typeof import("@monaco-editor/react");

let monacoReactPromise: Promise<MonacoReact> | null = null;

/**
 * Load the bundled Monaco (configuring @monaco-editor/react to use it instead
 * of the CDN) and then the React bindings. Every editor in the app goes
 * through this, so the configuration always happens before the first
 * `loader.init()`.
 */
export function loadMonacoReact(): Promise<MonacoReact> {
  monacoReactPromise ??= import("./setup")
    .then(() => import("@monaco-editor/react"))
    .catch((error: unknown) => {
      // Allow a retry (e.g. a chunk that failed to load on a flaky network).
      monacoReactPromise = null;
      throw error;
    });
  return monacoReactPromise;
}

/** The Monaco namespace, once the bundled editor has loaded. */
export async function loadMonaco(): Promise<Monaco> {
  const { loader } = await loadMonacoReact();
  return (await loader.init()) as Monaco;
}
