import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Vendored from the @animate-ui registry (components.json) and replaced
    // wholesale on update, so it keeps its upstream shape. The React compiler
    // rules are held to our own code, not to a copy we do not maintain.
    files: ["src/components/animate-ui/**", "src/components/react-bits/**"],
    rules: {
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/static-components": "off",
    },
  },
  {
    // One icon set for web and app: `packages/shared/src/constants/glyphs.ts`.
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              message: 'Draw our own: <Glyph name="…" /> or a name from "@/components/icons".',
              name: "lucide-react",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
