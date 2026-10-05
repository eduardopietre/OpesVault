// Lint rules that carry the CLAUDE.md pitfalls into the web code.
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const noFloatMoney = [
  { selector: "CallExpression[callee.name='parseFloat']", message: "Dinheiro nunca passa por float: use Dec.parse." },
  {
    selector: "CallExpression[callee.object.name='Number'][callee.property.name='parseFloat']",
    message: "Dinheiro nunca passa por float: use Dec.parse.",
  },
];

export default tseslint.config(
  { ignores: ["**/node_modules", "**/dist", "**/coverage", "**/build", "**/playwright-report", "**/test-results"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-extraneous-class": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
      "@typescript-eslint/no-invalid-void-type": "off",
      "no-console": "error",
      "no-restricted-globals": [
        "error",
        { name: "localStorage", message: "Só preferences.ts usa localStorage; nada do projeto vai para ele." },
        { name: "sessionStorage", message: "Nada do projeto vai para o armazenamento do navegador em claro." },
      ],
      "no-restricted-syntax": ["error", ...noFloatMoney],
    },
  },
  {
    files: ["packages/domain/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["react", "react-dom", "@opesvault/*"],
              message: "O domínio não depende de interface, cofre nem rede.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "O domínio não usa a rede; o cliente do Ollama recebe o transporte." },
        { name: "localStorage", message: "O domínio não guarda nada no navegador." },
        { name: "document", message: "O domínio não toca no DOM." },
        { name: "window", message: "O domínio não toca no DOM." },
      ],
    },
  },
  {
    files: ["packages/crypto/src/**/*.ts", "packages/vault/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["react", "react-dom", "@opesvault/domain", "@opesvault/ui"], message: "Fronteira de pacote." },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/app/src/**/*.{ts,tsx}", "packages/ui/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    files: ["**/preferences.ts"],
    rules: { "no-restricted-globals": "off" },
  },
  {
    files: ["**/diagnostics.ts", "apps/server/src/**/*.ts", "tools/**/*.ts", "**/*.config.ts", "**/*.config.js"],
    rules: { "no-console": "off" },
  },
  {
    files: ["**/test/**/*.{ts,tsx}", "**/*.test.{ts,tsx}", "**/e2e/**/*.ts"],
    rules: { "no-restricted-globals": "off", "@typescript-eslint/no-non-null-assertion": "off" },
  },
);
