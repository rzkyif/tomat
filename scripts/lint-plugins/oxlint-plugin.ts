// Local oxlint plugin housing tomat's custom lint rules. Registered via
// `jsPlugins` in the root `.oxlintrc.json` under the `tomat/` namespace.
//
// Rules:
//   - no-tauri-import: forbid direct `@tauri-apps/*` imports. The Svelte client
//     must reach Tauri capabilities through `$lib/platform/` (a Tauri impl plus
//     a browser stub), so the same component tree can run under a future
//     web/mobile build. Scoped to the client UI tree, with the one allowed file
//     (`platform/tauri.ts`) exempted, via `overrides` in `.oxlintrc.json`. oxlint
//     can't parse `.svelte`, so `check-tauri-imports-svelte.ts` covers the
//     `<script>`-block gap.
//   - no-em-dash: forbid the em dash (U+2014) anywhere: code, comments, or
//     string/template text. Scans the raw source so every occurrence is caught,
//     not just AST string nodes.
//   - no-uppercase-tomat: forbid the capitalized brand word anywhere: code,
//     comments, or string/template text. The brand is always lowercase. Like
//     no-em-dash, scans raw source. The all-caps env-var prefix and the
//     lowercase brand are both fine; only the mixed-case (capital initial) form
//     is rejected. The needle is built by concatenation so this file never
//     trips its own rule.
//
// Keep this file em-dash-free and brand-uppercase-free, or the rules will flag
// their own source.

interface ImportDeclarationNode {
  source: { value: unknown };
}

interface ReportDescriptor {
  node?: unknown;
  loc?: { line: number; column: number };
  message: string;
}

interface RuleContext {
  sourceCode: { text: string };
  report(descriptor: ReportDescriptor): void;
}

const TAURI_MESSAGE =
  "Direct @tauri-apps import is forbidden here. Route this call through " +
  "$lib/platform/ so the web/mobile build stub can intercept it. Add a method " +
  "to the Platform interface if one doesn't exist yet.";

const EM_DASH = String.fromCharCode(0x2014);
const EM_DASH_MESSAGE =
  "Em dash (U+2014) is not allowed. Reword the surrounding text so the " +
  "sentence reads naturally without an em dash.";

// Built by concatenation so this source file does not trip the rule itself.
const UPPERCASE_BRAND = "T" + "omat";
const UPPERCASE_BRAND_MESSAGE =
  "The brand is always lowercase 'tomat'. Replace the capital-initial " +
  "spelling. (The all-caps TOMAT_ env-var prefix is a separate token and fine.)";

const noTauriImport = {
  create(context: RuleContext) {
    return {
      ImportDeclaration(node: ImportDeclarationNode) {
        const src = node.source.value;
        if (typeof src !== "string") return;
        if (src === "@tauri-apps" || src.startsWith("@tauri-apps/")) {
          context.report({ node, message: TAURI_MESSAGE });
        }
      },
    };
  },
};

const noEmDash = {
  create(context: RuleContext) {
    return {
      Program() {
        const lines = context.sourceCode.text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          let col = lines[i].indexOf(EM_DASH);
          while (col !== -1) {
            context.report({
              message: EM_DASH_MESSAGE,
              loc: { line: i + 1, column: col },
            });
            col = lines[i].indexOf(EM_DASH, col + 1);
          }
        }
      },
    };
  },
};

const noUppercaseBrand = {
  create(context: RuleContext) {
    return {
      Program() {
        const lines = context.sourceCode.text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          let col = lines[i].indexOf(UPPERCASE_BRAND);
          while (col !== -1) {
            context.report({
              message: UPPERCASE_BRAND_MESSAGE,
              loc: { line: i + 1, column: col },
            });
            col = lines[i].indexOf(UPPERCASE_BRAND, col + 1);
          }
        }
      },
    };
  },
};

export default {
  meta: { name: "tomat" },
  rules: {
    "no-tauri-import": noTauriImport,
    "no-em-dash": noEmDash,
    "no-uppercase-tomat": noUppercaseBrand,
  },
};
