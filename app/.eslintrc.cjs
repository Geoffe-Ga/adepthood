/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  env: { es2022: true, node: true, jest: true },
  extends: [
    "eslint:recommended",
    "plugin:react/recommended",
    "plugin:react-hooks/recommended",
    "plugin:@typescript-eslint/recommended-type-checked",
    "plugin:@typescript-eslint/stylistic-type-checked",
    "plugin:import/recommended",
    "plugin:import/typescript",
    "plugin:unicorn/recommended",
    "prettier"
  ],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: ["./tsconfig.eslint.json"],
    tsconfigRootDir: __dirname,
    ecmaVersion: "latest",
    sourceType: "module",
    ecmaFeatures: { jsx: true }
  },
  settings: {
    react: { version: "detect" },
    "import/resolver": {
      typescript: { project: "./tsconfig.json" }
    }
  },
  plugins: ["@typescript-eslint", "react", "react-hooks", "import", "unicorn"],
  rules: {
    "react/react-in-jsx-scope": "off",
    "react/prop-types": "off",
    "unicorn/prevent-abbreviations": "off",
    "unicorn/no-null": "off",
    "import/order": ["error", {
      "alphabetize": { "order": "asc", "caseInsensitive": true },
      "newlines-between": "always"
    }],
    "@typescript-eslint/consistent-type-imports": "error",
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-unused-vars": ["error", {"argsIgnorePattern": "^_"}],
  },
  overrides: [
    {
      files: ["*.js"],
      parser: "espree",
      parserOptions: { ecmaVersion: 2022, sourceType: "module" }
    },
    {
      files: ["**/__tests__/**/*", "**/*.{spec,test}.ts?(x)"],
      rules: {
        "@typescript-eslint/no-unsafe-assignment": "off",
        "@typescript-eslint/no-unsafe-call": "off",
        "@typescript-eslint/no-unsafe-member-access": "off"
      }
    }
  ]
};
