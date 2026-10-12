import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [{
    files: ["**/*.ts"],
}, {
    plugins: {
        "@typescript-eslint": typescriptEslint,
    },

    languageOptions: {
        parser: tsParser,
        ecmaVersion: 2022,
        sourceType: "module",
    },

    rules: {
        "@typescript-eslint/naming-convention": ["warn", {
            selector: "import",
            format: ["camelCase", "PascalCase"],
        }],

        curly: "warn",
        eqeqeq: "warn",
        "no-throw-literal": "warn",
        semi: "warn",

        // The engine's config, permission, and token helpers read the command-line
        // tool's own files and environment; the extension supplies these from VS Code.
        "no-restricted-imports": ["error", {
            paths: [{
                name: "cmd-git-copilot-tools",
                importNames: ["loadConfig", "saveConfig", "getConfigPath", "loadPermissions", "savePermissions", "getToken"],
                message: "Take sources and settings from the VS Code configuration and the token from VS Code sign-in.",
            }],
        }],
    },
}];