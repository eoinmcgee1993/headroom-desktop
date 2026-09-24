// Deliberately narrow: this exists to catch React hook bugs, not to enforce
// style. App.tsx carries 78 useEffect hooks and no memoization, and until now
// nothing checked them -- a conditional hook or a stale closure over state
// shipped silently. Formatting and general lint rules are left out on purpose;
// they would bury the two rules that actually find bugs under thousands of
// cosmetic findings and nobody would read the output.
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["dist/**", "coverage/**", "src-tauri/**", "node_modules/**"],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // Hooks called conditionally or in a loop. Near-zero false positives and
      // the failure mode is a corrupted hook order, so this one blocks CI.
      "react-hooks/rules-of-hooks": "error",
      // Missing/incorrect dependency arrays. An error since the run went clean
      // (2026-09-24): every intentional omission carries a disable comment with
      // its reason, so a new warning is a stale closure until shown otherwise.
      "react-hooks/exhaustive-deps": "error",
    },
  },
];
