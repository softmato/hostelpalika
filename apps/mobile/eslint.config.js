// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  },
  {
    // One icon set for web and app: `packages/shared/src/constants/glyphs.ts`.
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { message: 'Draw our own: <Glyph name="…" /> from "@/components/ui/glyph".', name: "lucide-react-native" },
            { message: 'Draw our own: <Glyph name="…" /> from "@/components/ui/glyph".', name: "@expo/vector-icons" },
          ],
          patterns: [{ group: ["@expo/vector-icons/*"], message: 'Draw our own: <Glyph name="…" />.' }],
        },
      ],
    },
  },
]);
