// node sfx.mjs <outDir> — generate the film's soft UI sound kit with ElevenLabs sound effects.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL(".env", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const kit = {
  tap: ["Very soft, clean UI tap on a glass phone screen, gentle muted click, premium app sound, no reverb tail", 0.5],
  pop: ["Soft subtle UI pop-in sound, gentle rounded bubble pop, premium minimal interface, quiet and clean", 0.5],
  whoosh: ["Smooth soft air whoosh transition, gentle and airy, premium product video, not aggressive", 1],
  swish: ["Light quick swipe swish, soft fabric-like air movement, minimal UI gesture sound", 0.5],
  paper: ["Single sheet of crisp paper sliding out smoothly onto a desk, soft and clean", 1.2],
  success: ["Gentle two-note success chime, warm soft marimba, premium app confirmation, quiet", 1.2],
  shimmer: ["Soft magical shimmer swell resolving into a warm bell tone, logo reveal, elegant and subtle", 2.5],
  glitch: ["Short soft digital glitch stutter, subtle, low volume, not harsh", 0.6],
  plink: ["Tiny soft plink, like a map pin dropping, light wooden tick, minimal", 0.5],
  cross: ["Soft quick pencil scratch mark, short, subtle", 0.5],
  typing: ["Very soft chat typing indicator blips, three quiet bubbly ticks", 1],
  hit: ["Soft deep cinematic impact, warm sub boom with gentle air, premium trailer, not loud or harsh", 1.5],
  riser: ["Smooth airy cinematic riser building tension, soft synth swell and reverse cymbal, ends abruptly", 3],
  reveal: ["Bright warm light-burst reveal, soft shimmering whoosh opening into a glowing chord, premium logo reveal", 2.5],
  sent: ["Soft message sent swoosh, short and clean, messaging app", 0.6],
};
const out = process.argv[2];
for (const [name, [text, duration]] of Object.entries(kit)) {
  const file = `${out}/${name}.mp3`;
  if (existsSync(file)) continue;
  const res = await fetch("https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128", {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ text, duration_seconds: duration, prompt_influence: 0.6 }),
  });
  if (!res.ok) { console.error(name, res.status, await res.text()); continue; }
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  console.log(name, res.headers.get("character-cost") ?? "");
}
