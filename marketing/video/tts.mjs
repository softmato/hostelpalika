// node tts.mjs <voiceId> <out.mp3> <text.txt> [modelId]
// Text comes from a file so Devanagari never passes through the shell.
import { readFileSync, writeFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL(".env", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const [voice, out, textFile, model = "eleven_v3"] = process.argv.slice(2);
const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
  method: "POST",
  headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ text: readFileSync(textFile, "utf8").trim(), model_id: model, language_code: "ne" }),
});
if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
writeFileSync(out, Buffer.from(await res.arrayBuffer()));
console.log(out, res.headers.get("character-cost") ?? "");
