import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      ".swarm-data/**",
      "workspaces/**",
      "**/*.db",
      "artifacts/**",
      "test-results/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { fetch: "readonly", console: "readonly", setTimeout: "readonly" },
    },
  },
  {
    files: ["web/**/*.js"],
    languageOptions: {
      globals: {
        document: "readonly",
        window: "readonly",
        location: "readonly",
        fetch: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        FormData: "readonly",
      },
    },
  },
  {
    languageOptions: { globals: { process: "readonly" } },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
