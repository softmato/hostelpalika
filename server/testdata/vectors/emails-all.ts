/**
 * Golden output for every email template, from the TypeScript templates (the
 * spec). Inputs are built from each template's own parameter type (TypeScript
 * compiler API): every property filled, then optional ones left out; a union of
 * string literals takes its first member, then its last. Strings carry markup
 * and quotes so escaping is compared too. Run from the repo root:
 *
 *   node_modules/.bin/jiti server/testdata/vectors/emails-all.ts
 *
 * Writes emails-all.json: `{ name, input, out }` per vector (Date-typed fields
 * are ISO strings in `input`). TestEveryTemplateMatchesTS replays it.
 */

import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { createJiti } from "jiti";
import ts from "typescript";

const web = createJiti(__filename, {
  alias: {
    "@/": join(process.cwd(), "apps/web/src") + "/",
    "server-only": join(process.cwd(), "node_modules/server-only/empty.js"),
  },
});

const root = join(process.cwd(), "packages/shared/src/email/templates");
const files: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "index.ts") files.push(path);
  }
};
walk(root);

const program = ts.createProgram(files, {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  target: ts.ScriptTarget.ES2022,
});
const checker = program.getTypeChecker();

function str(name: string, full: boolean): string {
  const n = name.toLowerCase();
  if (n.endsWith("url") || n.includes("link")) return "https://x.test/p?a=1&b=<2>";
  if (n.includes("email")) return full ? "sita+1@x.test" : "";
  if (n.includes("phone")) return full ? "9800000000" : "";
  if (n.includes("password")) return "Tmp-9x<&>";
  // What every caller passes: the currency defaults to it, the platform is the brand.
  if (n === "currency") return "NPR";
  if (n === "platformname" || n === "sitename") return "HostelPalika";
  if (n === "supportemail") return "support@softmato.com";
  if (["reason", "message", "note", "comment", "details", "description", "summary", "instruction"].some((w) => n.endsWith(w)))
    return full ? 'Line one\nLine <two> & "three"' : "";
  if (["month", "period", "monthlabel", "periodlabel"].includes(n)) return "Kartik 2083";
  if (n.includes("date") || n.endsWith("on") || n.includes("until") || n.endsWith("at") || n.includes("deadline") || n.endsWith("by"))
    return "5 Nov 2026";
  if (n.includes("code") || n.includes("number") || n.includes("reference") || n.endsWith("id")) return "HP-7F3K2Q";
  if (n === "roomtype") return "Double Sharing";
  if (n.includes("name") || n === "from") return 'Sita "K" <Rai> & Co';
  if (["reason", "message", "note", "body", "details", "description", "comment", "summary", "text", "instruction", "notes"].includes(n))
    return full ? 'Line one\nLine <two> & "three"' : "";
  return 'Value <b>&</b> "q"';
}

function num(name: string): number {
  const n = name.toLowerCase();
  if (n.includes("percent")) return 10;
  if (n.includes("day")) return 7;
  if (n.includes("hour")) return 48;
  if (["count", "strike", "reminder", "seats", "quantity", "nights", "rooms", "beds", "months", "residents"].some((w) => n.includes(w))) return 3;
  return 150000;
}

const isNullish = (t: ts.Type) => (t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0;

function value(t: ts.Type, name: string, full: boolean, depth: number): unknown {
  if (depth > 6) return null;
  if (t.isUnion()) {
    const parts = t.types.filter((p) => !isNullish(p));
    if (parts.length === 0) return null;
    if (parts.every((p) => p.flags & ts.TypeFlags.BooleanLiteral)) return full;
    const literals = parts.filter((p) => p.isStringLiteral() || p.isNumberLiteral());
    if (literals.length === parts.length) {
      const pick = full ? literals[0] : literals[literals.length - 1];
      return (pick as ts.LiteralType).value;
    }
    return value(parts[0], name, full, depth);
  }
  if (t.isStringLiteral() || t.isNumberLiteral()) return t.value;
  if (t.flags & ts.TypeFlags.BooleanLike) return full;
  if (t.flags & ts.TypeFlags.NumberLike) return num(name);
  if (t.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return str(name, full);
  if (t.getSymbol()?.getName() === "Date") return new Date("2026-11-05T09:15:00.000Z");
  if (checker.isArrayType(t)) {
    const elem = checker.getTypeArguments(t as ts.TypeReference)[0];
    return full ? [value(elem, name, true, depth + 1), value(elem, name, false, depth + 1)] : [];
  }
  if (t.getCallSignatures().length > 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const prop of checker.getPropertiesOfType(t)) {
    // No caller passes it (payout-account and resident-access emails); Go has no such input.
    if (prop.getName() === "supportEmail") continue;
    const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
    if (!full && optional) continue;
    const decl = prop.valueDeclaration ?? prop.declarations?.[0];
    const pt = decl ? checker.getTypeOfSymbolAtLocation(prop, decl) : checker.getDeclaredTypeOfSymbol(prop);
    const v = value(pt, prop.getName(), full, depth + 1);
    if (v !== undefined) out[prop.getName()] = v;
  }
  return out;
}

const vectors: unknown[] = [];
let failed = 0;
for (const file of files) {
  const source = program.getSourceFile(file)!;
  const mod = await web.import<Record<string, (input: unknown) => unknown>>(file);
  for (const stmt of source.statements) {
    if (!ts.isFunctionDeclaration(stmt) || !stmt.name || !stmt.name.text.endsWith("Email")) continue;
    if (!stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) || stmt.parameters.length === 0) continue;
    const name = stmt.name.text;
    const param = checker.getTypeAtLocation(stmt.parameters[0]);
    for (const full of [true, false]) {
      const input = value(param, "", full, 0);
      try {
        const out = await mod[name](structuredClone(input));
        vectors.push({ name, file: relative(root, file).replaceAll("\\", "/"), input: JSON.parse(JSON.stringify(input)), out });
      } catch (error) {
        failed++;
        console.error(`${name} (${full ? "full" : "minimal"}): ${String(error)}`);
      }
    }
  }
}
writeFileSync(join(__dirname, "emails-all.json"), JSON.stringify(vectors, null, 1) + "\n");
console.log(`${vectors.length} vectors, ${failed} inputs the TS template refused`);
