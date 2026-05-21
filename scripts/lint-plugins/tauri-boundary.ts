// deno-lint plugin: forbid direct imports from `@tauri-apps/*` outside the
// dedicated platform implementation. Everything in the Svelte client that
// needs a Tauri capability MUST go through `$lib/platform/`, which has both
// a Tauri impl (the one exception) and a browser stub. This keeps the same
// component tree runnable under a future web/mobile build.
//
// Wired into the root `deno.json` via `lint.plugins`. The plugin filters by
// filename so it doesn't fire on core / shared package files.
//
// To opt a single file out (e.g. while a refactor is in flight), add at the
// top of the file:
//   // deno-lint-ignore-file tomat/no-tauri-import
// and leave a TODO explaining the migration path.

const ALLOWED_FILES = new Set<string>([
  // The Platform interface's Tauri implementation IS the place where
  // @tauri-apps lives. Everything else routes through it.
  "platform/tauri.ts",
]);

function isAllowed(filename: string): boolean {
  for (const suffix of ALLOWED_FILES) {
    if (filename.endsWith("/" + suffix)) return true;
  }
  return false;
}

function inClientUiTree(filename: string): boolean {
  // Only enforce inside the Svelte client's source tree. Core / shared
  // packages never use @tauri-apps anyway, and CI scripts touching Tauri
  // (build orchestrators, etc.) are out of scope.
  return filename.includes("/packages/tomat-client/src/ui/");
}

const plugin: Deno.lint.Plugin = {
  name: "tomat",
  rules: {
    "no-tauri-import": {
      create(context) {
        if (!inClientUiTree(context.filename)) return {};
        if (isAllowed(context.filename)) return {};
        return {
          ImportDeclaration(node) {
            const src = node.source.value;
            if (typeof src !== "string") return;
            if (
              src === "@tauri-apps" ||
              src.startsWith("@tauri-apps/")
            ) {
              context.report({
                node,
                message:
                  `Direct @tauri-apps import is forbidden here. Route this ` +
                  `call through $lib/platform/ so the web/mobile build stub ` +
                  `can intercept it. Add a method to the Platform interface ` +
                  `if one doesn't exist yet.`,
              });
            }
          },
        };
      },
    },
  },
};

export default plugin;
