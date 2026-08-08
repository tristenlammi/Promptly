// ESLint flat config.
//
// Context: this codebase was written without a working lint gate — the
// ``lint`` script existed in package.json for a long time but no config and no
// eslint binary were ever installed, so it could never run. Turning on a
// maximal rule set now would bury real findings under thousands of stylistic
// ones, so the split here is deliberate:
//
//   error  → things that are real bugs or real a11y breakage. CI fails on these.
//   warn   → existing debt worth seeing but not worth blocking a release on.
//   off    → already enforced by TypeScript (tsconfig has strict +
//            noUnusedLocals/noUnusedParameters), so linting it again is noise.
//
// `npm run lint` fails on errors only, which is what CI gates on.
// `npm run lint:strict` also fails on warnings — use it when burning down debt.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";

export default tseslint.config(
  {
    // Build output, generated bundles, and the emitted config .js that
    // `tsc -b tsconfig.node.json` produces from vite.config.ts.
    ignores: [
      "dist/**",
      "dev-dist/**",
      "node_modules/**",
      "public/**",
      "vite.config.js",
      "tailwind.config.js",
      "postcss.config.js",
      "scripts/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.es2021,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "jsx-a11y": jsxA11y,
    },
    rules: {
      // ---- Real bugs: fail the build -------------------------------------
      // Calling a hook conditionally corrupts React's hook order. This is
      // never a style question.
      "react-hooks/rules-of-hooks": "error",
      // `case` fallthrough and `==` against null are the classic silent ones.
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-fallthrough": "error",

      // ---- Existing debt: surface, don't block ---------------------------
      // ~14 effects in ChatPage alone were written with no dep checking; this
      // needs a real burn-down pass, not a release block.
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-non-null-assertion": "warn",
      // Every occurrence here is an escaped `[` inside a regex character
      // class, which is a no-op that mirrors the `\]` the class genuinely
      // requires. Not worth hand-editing regexes in the message renderer.
      "no-useless-escape": "warn",

      // ---- Handled by TypeScript already ---------------------------------
      // tsconfig sets noUnusedLocals + noUnusedParameters, and `tsc -b` runs
      // in the Docker build, so these would be duplicate reports.
      "@typescript-eslint/no-unused-vars": "off",
      "no-unused-vars": "off",
      // TS resolves globals/module scope correctly; the base rule produces
      // false positives on type-only and DOM identifiers.
      "no-undef": "off",
      // `const extensionThis = this` is the required TipTap idiom inside
      // addProseMirrorPlugins() — the suggestion callbacks rebind `this`.
      // Any other alias is still reported.
      "@typescript-eslint/no-this-alias": [
        "error",
        { allowedNames: ["extensionThis"] },
      ],
    },
  },

  // Accessibility. Kept to the subset that catches genuine screen-reader and
  // keyboard breakage rather than the full recommended set, which fires
  // heavily on this codebase's ~155 clickable <div> sites. Those are tracked
  // as debt (warn) so they show up without blocking.
  {
    files: ["**/*.tsx"],
    rules: {
      "jsx-a11y/alt-text": "error",
      "jsx-a11y/anchor-has-content": "error",
      "jsx-a11y/aria-props": "error",
      "jsx-a11y/aria-proptypes": "error",
      "jsx-a11y/aria-unsupported-elements": "error",
      "jsx-a11y/role-has-required-aria-props": "error",
      "jsx-a11y/role-supports-aria-props": "error",
      "jsx-a11y/no-redundant-roles": "error",

      "jsx-a11y/click-events-have-key-events": "warn",
      "jsx-a11y/no-static-element-interactions": "warn",
      "jsx-a11y/no-noninteractive-element-interactions": "warn",
      "jsx-a11y/label-has-associated-control": "warn",
    },
  },

  // Service worker runs in a worker scope, not the browser window scope.
  {
    files: ["src/sw.ts", "src/**/*.worker.ts"],
    languageOptions: {
      globals: { ...globals.serviceworker, ...globals.worker },
    },
  },
);
