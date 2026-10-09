// node music.mjs <out.mp3> <lengthMs> <prompt.txt> — ElevenLabs music, prompt from a file.
import { readFileSync, writeFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync(new URL(".env", import.meta.url), "utf8").split("\n").filter((l) => l.includes("="))
  .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const [out, ms, promptFile] = process.argv.slice(2);
const res = await fetch("https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128", {
  method: "POST", headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: readFileSync(promptFile, "utf8").trim(), music_length_ms: Number(ms) }),
});
if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
writeFileSync(out, Buffer.from(await res.arrayBuffer()));
console.log(out, res.headers.get("character-cost") ?? "");
