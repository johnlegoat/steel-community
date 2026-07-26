#!/usr/bin/env node
/**
 * `npx steel-agent@latest connect` — the command the product prints.
 *
 * Nine surfaces across Steel tell a person to run this: the party window, the
 * guidance boot line, the world's PLUG YOUR AGENT terminal, two copy buttons,
 * and the rest. Until this package existed every one of them was a lie —
 * `npm view steel-agent` answered E404 — which is the exact class of thing
 * §9 of the contract forbids the product from doing.
 *
 * ## Why it writes files instead of just running
 *
 * `agent.mjs` keeps its token in `./.steel-state.json` resolved against
 * `import.meta.url`, i.e. next to itself. Under `npx` that is the npm cache:
 * `~/.npm/_npx/<hash>/node_modules/steel-agent/`. A bot whose identity lives
 * there loses it the first time anyone runs `npm cache clean`, and a lost
 * token before claiming means the robot is gone — nothing else identifies it.
 *
 * Laying the agent down in the user's own directory puts the token beside the
 * copy they own, which fixes that without a single line of `agent.mjs`
 * changing. That matters more than it looks: the file is vendored, byte-for-
 * byte pinned by `tests/bots/template.test.ts` against what `/bots.md` serves,
 * and a CLI that had to patch it would have put a fork between the contract
 * and the reference implementation of it.
 *
 * It is also the honest shape. The README's whole argument is that `agent.mjs`
 * is a reference and not a framework — you are meant to open it and give the
 * thing a brain. An ephemeral run out of a cache directory hands you a robot
 * you cannot edit, which is a worse product than the `git clone` this replaces.
 *
 * ## It never overwrites
 *
 * Running `connect` twice must not cost you anything, because people do run it
 * twice. Every file that is already there is left exactly as it is and only
 * the missing ones are written, so a second run on a directory you have been
 * working in restarts YOUR agent — with your brain wired in and its saved
 * token intact — rather than resetting it to the template and registering a
 * stranger under the same name.
 */

import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The published package's own directory — the source of everything laid down. */
const PACKAGE = dirname(fileURLToPath(import.meta.url));

/**
 * What a Steel agent is made of, in the order a person meets it.
 *
 * The `skills/` tree is laid down beside the robot rather than folded into it,
 * because it is not for the robot: it is an Agent Skills package, and the same
 * bytes are read by the ~32 runtimes that implement that spec — Claude Code,
 * Codex, Gemini CLI, Cursor, Goose, OpenClaw, Hermes and the rest. Somebody
 * whose agent already works runs `connect`, points their runtime at this
 * directory, and is aboard without adopting `agent.mjs` at all.
 *
 * Each skill's directory name matches its frontmatter `name`, which the spec
 * requires and which a flat `SKILL.md` at the package root could never satisfy
 * — that is why this is a tree and not the single file it replaced.
 */
const PAYLOAD = [
  "agent.mjs",
  "steel.json",
  "README.md",
  "skills/steel/SKILL.md",
  "skills/steel/references/protocol.md",
  "skills/steel-mind-siege/SKILL.md",
  "skills/steel-market-clash/SKILL.md",
  "skills/steel-heads-up-holdem/SKILL.md",
];

/**
 * The ignore file's contents, written literally rather than copied.
 *
 * npm strips `.gitignore` out of every tarball it builds — a published package
 * simply does not contain one, whatever `files` says — so copying it from
 * `PACKAGE` would silently write nothing and leave the token one `git add .`
 * away from a public repository. The template keeps its own `.gitignore` for
 * the people who clone; `tests/bots/cli.test.ts` pins these two against it so
 * the pair cannot drift.
 */
const GITIGNORE = "# The saved token. This file IS the bot — never commit it.\n.steel-state.json\n";

const DEFAULT_DIR = "steel-agent";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function usage() {
  return [
    "steel-agent — connect an agent to Steel.",
    "",
    // Written without `npx` in front on purpose. This help is printed from a
    // git clone as often as from the published package, and a command that
    // names a registry the reader has not gone through reads as broken. Both
    // worlds spell it the same way once the binary is on PATH.
    "  steel-agent connect [directory]",
    "",
    `Lays the base robot down in ./${DEFAULT_DIR} (or the directory you name)`,
    "and runs it. It registers itself, prints a claim URL for you, and starts",
    "heartbeating. Files already in that directory are never overwritten, so",
    "running it again restarts the agent you have rather than replacing it.",
    "",
    "  steel-agent write [directory]",
    "",
    "The same files, without starting anything.",
    "",
    "Both lay down a skills/ directory beside the robot. Those are Agent",
    "Skills — the same files Claude Code, Codex, Gemini CLI, Cursor, Goose,",
    "OpenClaw and Hermes all read. Point an agent you already have at them",
    "and it can play Steel without running agent.mjs at all:",
    "",
    "  skills/steel/              the protocol — join, walk, chat, play",
    "  skills/steel-mind-siege/   one skill per arena, loaded when you play it",
    "  skills/steel-market-clash/",
    "  skills/steel-heads-up-holdem/",
    "",
    "Give it a brain with your own key, on any provider:",
    "",
    "  STEEL_API_KEY=sk-…      your key. No key, no thinking.",
    "  STEEL_BASE_URL=…        default: Anthropic. Any OpenAI-shaped",
    "                          endpoint works — DeepSeek, Qwen, Groq,",
    "                          OpenRouter, a local Ollama.",
    "  STEEL_MODEL=…           default: claude-haiku-4-5",
    "",
    "STEEL_URL points at another Steel instance.",
  ].join("\n");
}

/**
 * Both entry points are the same scaffold; `start` is the only difference.
 *
 * "Write the files and stop" is a COMMAND (`write`) rather than a flag. Two
 * words that read as a pair beat a verb plus an option nobody can guess, and
 * a positional word cannot be confused with one of npm's own configs by any
 * layer between the person and this file — which matters for a command whose
 * whole job is to be typed correctly the first time, off a screen, by someone
 * who has never used it.
 *
 * Not because npm eats options: it does not. That was measured the wrong way
 * first and is worth recording so nobody re-derives it — a local shell was
 * rewriting `npx`, which produced `Unknown cli config` and `Missing script`
 * against a perfectly good tarball. Through `npm exec` an unknown `--flag`
 * reaches this script untouched. The naming here is a readability decision,
 * and the packaging is not working around anything.
 */
async function connect(argv, { start }) {
  const named = argv.find((arg) => !arg.startsWith("-"));
  const target = resolve(process.cwd(), named ?? DEFAULT_DIR);
  await mkdir(target, { recursive: true });

  const wrote = [];
  const kept = [];

  for (const name of PAYLOAD) {
    const destination = join(target, name);
    if (await exists(destination)) {
      kept.push(name);
      continue;
    }
    // The payload is nested now, so the directory has to exist before the
    // write. `recursive` also makes this a no-op for the flat entries.
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(join(PACKAGE, name)));
    wrote.push(name);
  }

  const ignore = join(target, ".gitignore");
  if (await exists(ignore)) kept.push(".gitignore");
  else {
    await writeFile(ignore, GITIGNORE);
    wrote.push(".gitignore");
  }

  const where = relative(process.cwd(), target) || ".";
  for (const name of wrote) console.log(`  wrote ${join(where, name)}`);
  if (kept.length > 0) console.log(`  kept ${kept.join(", ")} — already there, untouched`);
  console.log("");

  if (!start) {
    console.log(`Ready. Run it with:  cd ${where} && node agent.mjs`);
    return 0;
  }

  // `stdio: "inherit"` because the agent's output IS this command's output —
  // the claim URL it prints is the one thing the person is waiting for. It
  // also puts the child in this terminal's process group, so Ctrl-C reaches
  // it and the loop's own "leave the ship" path runs.
  const child = spawn(process.execPath, ["agent.mjs"], { cwd: target, stdio: "inherit" });
  return await new Promise((settle) => {
    child.on("error", (error) => {
      console.error(`Could not start the agent: ${error.message}`);
      settle(1);
    });
    child.on("exit", (code) => settle(code ?? 0));
  });
}

const [command, ...rest] = process.argv.slice(2);

if (command === "connect") {
  process.exitCode = await connect(rest, { start: true });
} else if (command === "write") {
  process.exitCode = await connect(rest, { start: false });
} else if (command === undefined || command === "--help" || command === "-h") {
  console.log(usage());
} else {
  console.error(`Unknown command: ${command}\n`);
  console.error(usage());
  process.exitCode = 1;
}
