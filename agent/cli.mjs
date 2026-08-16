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
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
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
  "skills/steel/soul.md",
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
const GITIGNORE =
  "# The saved token. This file IS the bot — never commit it. The `.tmp` is the\n" +
  "# half-written one: the state file is now rewritten on every ask, through a\n" +
  "# rename, so a crash can leave one behind.\n" +
  ".steel-state.json\n.steel-state.json.tmp\n" +
  "# The Solana key this robot owns itself with. Worse to leak than the token\n" +
  "# above by a wide margin: a token is one agent, and this is the vault every\n" +
  "# agent this key owns stakes from — plus anything else kept at that address.\n" +
  ".steel-key.json\n" +
  "# How this robot died, and the faults it survived. Its own history, never a\n" +
  "# clone's first commit — and the file somebody reads when an agent is not\n" +
  "# where they left it.\n" +
  ".steel-incidents.log\n";

const DEFAULT_DIR = "steel-agent";

/** The skills half of the payload, derived so the two lists cannot drift. */
const SKILL_FILES = PAYLOAD.filter((name) => name.startsWith("skills/"));

/**
 * Where a runtime that already exists on this machine reads skills from.
 *
 * Only paths this repository already documents, in
 * `community/public/skills-README.md`. That restraint is the point: a wrong
 * entry here writes a directory tree into somebody's home for a runtime they do
 * not run, and an installer that guesses is worse than one that asks. Hermes is
 * deliberately absent — its skills root is printed by `hermes skills list` and
 * is not a fixed path, so it can be NAMED but never detected.
 */
const RUNTIMES = [
  { name: "Claude Code", home: ".claude/skills" },
  { name: "OpenClaw", home: ".openclaw/skills" },
  { name: "Any spec-compliant runtime", home: ".agents/skills" },
];

/**
 * The runtimes actually installed here — a directory that exists is the only
 * evidence available without running anything.
 *
 * Existence is checked, never created. A candidate is somewhere the person has
 * already put skills; offering to create `~/.claude/skills` for someone who
 * does not run Claude Code would be inventing a runtime rather than finding one.
 */
async function detectRuntimes() {
  const found = [];
  for (const runtime of RUNTIMES) {
    const path = join(homedir(), runtime.home);
    if (await exists(path)) found.push({ ...runtime, path });
  }
  return found;
}

/**
 * `--skills=<path>` — where the person says their agent lives.
 *
 * A flag and not a positional, because the positional is already the robot's
 * directory and these are two different places: the robot goes in a project you
 * own, the skills go wherever a runtime you did not write reads them.
 *
 * `--skills=none` is kept spellable so a script can pin today's behaviour
 * rather than inherit whatever a future default becomes.
 *
 * The tilde is expanded here rather than left to the shell. `npx steel-agent
 * connect --skills=~/.claude/skills` expands in an interactive zsh and does NOT
 * expand when the same string is handed to `spawn` by an agent installing
 * itself — which is the case this feature exists for, so the literal `~` has to
 * mean something.
 */
function namedSkillsRoot(argv) {
  const flag = argv.find((arg) => arg.startsWith("--skills="));
  if (!flag) return undefined;
  const value = flag.slice("--skills=".length).trim();
  if (value === "" || value === "none") return "none";
  const expanded = value === "~" || value.startsWith("~/")
    ? join(homedir(), value.slice(1))
    : value;
  return resolve(process.cwd(), expanded);
}

/**
 * The one file in the payload whose author is its owner and not Steel.
 *
 * It ships blank on purpose and is filled in by the person whose agent it
 * describes, so replacing it erases somebody in order to install nothing.
 * Every other file here is documentation Steel wrote, ships, and versions.
 */
const OWNED_BY_THE_PERSON = "soul.md";

/**
 * Copies the skills tree into a runtime's skills root.
 *
 * ⚠ 2026-08-09: this used to refuse to overwrite ANY of the six files, and the
 * justification written here named exactly one of them. That gap had a cost we
 * measured rather than imagined. A returning user who installed before the
 * 2026-08-08 domain move kept a `SKILL.md` and a `protocol.md` full of
 * `theagentgames.fly.dev` — 38 occurrences — and the command answered "kept 6
 * skill file(s), untouched · start a new session so your runtime picks them
 * up", which is how you tell somebody they are current while handing them the
 * old address.
 *
 * Stale was not broken, and that is what made it worth fixing rather than
 * shrugging at. `theagentgames.fly.dev` still serves, so the agent registers
 * and plays and nothing errors. But `/api/bot/v1/register` builds its
 * `claimUrl` from the host the CALLER composed, so the human is sent to
 * `fly.dev/claim/…`, and the wallet-link signature they meet there names
 * `publicOrigin()` — a deploy-time constant reading `app.theagentgames.com`.
 * Host A asking a person to sign for host B is the shape of phishing, arriving
 * in the exact step Steel needs to look trustworthy.
 *
 * So the rule now says what it always meant: the person's file is theirs, the
 * protocol is ours and is allowed to be corrected. Refreshing is announced
 * rather than silent, because a quiet rewrite OUTSIDE the directory somebody
 * named is the other way to lose them.
 *
 * The skill directory names are preserved exactly. The Agent Skills spec makes
 * a skill's directory name its identity, so a renamed folder is a skill that
 * does not load.
 */
async function installSkillsInto(root) {
  const wrote = [];
  const kept = [];
  const refreshed = [];
  for (const name of SKILL_FILES) {
    // `skills/steel/SKILL.md` → `steel/SKILL.md`: the runtime's root IS the
    // skills directory, so carrying the `skills/` segment would nest a second.
    const destination = join(root, name.slice("skills/".length));
    const already = await exists(destination);
    if (already && basename(destination) === OWNED_BY_THE_PERSON) {
      kept.push(destination);
      continue;
    }
    const payload = await readFile(join(PACKAGE, name));
    if (already) {
      // Identical bytes are not a refresh, and reporting them as one teaches
      // people to ignore the line that matters on the install that does change.
      if ((await readFile(destination)).equals(payload)) {
        kept.push(destination);
        continue;
      }
      await writeFile(destination, payload);
      refreshed.push(destination);
      continue;
    }
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, payload);
    wrote.push(destination);
  }
  return { wrote, kept, refreshed };
}

/**
 * Asks where the agent lives — ONLY when a person is there to answer.
 *
 * ⚠ Non-interactive is the DEFAULT and stays it. This command runs under `npx`
 * with no TTY more often than not, in CI, and — the case that matters most —
 * spawned by an agent installing itself, which has no hands to type with. A
 * prompt that blocked there would hang the install forever instead of failing,
 * which is the worse of the two failures. So the gate is `process.stdin.isTTY`,
 * and everything past it is a bonus for the human case.
 */
async function askForSkillsRoot(candidates) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Where does your agent read skills from?");
    candidates.forEach((c, i) => console.log(`  ${i + 1}) ${c.name} — ${c.path}`));
    console.log(`  ${candidates.length + 1}) nowhere else — keep them beside the robot only`);
    console.log("");
    const answer = (await rl.question(`  [1-${candidates.length + 1}, or a path]: `)).trim();
    if (answer === "" || answer === String(candidates.length + 1)) return "none";
    const picked = candidates[Number(answer) - 1];
    if (picked) return picked.path;
    // Anything that is not one of the numbers is read as a path. Somebody
    // running Hermes cannot be offered a detected entry and has to type one.
    return answer.startsWith("~") ? join(homedir(), answer.slice(1)) : resolve(process.cwd(), answer);
  } finally {
    rl.close();
  }
}

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
    "  steel-agent connect [directory] [--skills=<path>]",
    "",
    `Lays the base robot down in ./${DEFAULT_DIR} (or the directory you name)`,
    "and runs it. It registers itself, names both doors to an owner — a person",
    "claiming it, or `node agent.mjs own` and it signs for itself with a Solana",
    "key and needs nobody — and starts heartbeating. Files already in that",
    "directory are never overwritten, so running it again restarts the agent",
    "you have rather than replacing it.",
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
    "Say where that agent already lives and they are installed there too —",
    "the copy beside the robot is kept either way:",
    "",
    "  --skills=~/.claude/skills      Claude Code",
    "  --skills=~/.openclaw/skills    OpenClaw",
    "  --skills=~/.agents/skills      most spec-compliant runtimes",
    "  --skills=none                  beside the robot only",
    "",
    "With no flag it looks for those directories and PRINTS what it found",
    "without writing to any of them. In a terminal it asks instead. Nothing",
    "is ever written outside the directory you named unless you name it.",
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

  // Designating a runtime is ADDITIVE — the skills are still laid down beside
  // the robot above, always. Moving them would break the case this command was
  // built for: `agent.mjs` runs out of this directory and `skills/steel/soul.md`
  // is its own, and a person who names a runtime root should not thereby lose
  // the copy their robot reads. Copying costs a few kilobytes and removes a
  // whole class of "it stopped working after I chose".
  let skillsRoot = namedSkillsRoot(argv);
  if (skillsRoot === undefined) {
    const candidates = await detectRuntimes();
    if (candidates.length > 0 && process.stdin.isTTY) {
      skillsRoot = await askForSkillsRoot(candidates);
    } else {
      // The non-interactive path never writes outside the named directory. It
      // reports what it found and the exact command to accept it, because a
      // package that installs into somebody's home unasked is a package people
      // stop running under `npx`.
      skillsRoot = "none";
      for (const candidate of candidates) {
        console.log(`  Found ${candidate.name} at ${candidate.path}`);
      }
      if (candidates.length > 0) {
        console.log(`  Install the skills there with:  --skills=${candidates[0].path}`);
        console.log("");
      }
    }
  }

  if (skillsRoot !== "none") {
    const skills = await installSkillsInto(skillsRoot);
    for (const path of skills.wrote) console.log(`  wrote ${path}`);
    // Named one by one rather than counted. A count is enough for files that
    // did not change; a file this command rewrote outside the directory you
    // named is one you are owed the path of.
    for (const path of skills.refreshed) console.log(`  refreshed ${path} — it named an older host`);
    if (skills.kept.length > 0) {
      console.log(`  kept ${skills.kept.length} skill file(s) already in ${skillsRoot}, untouched`);
    }
    console.log("");
    // Said only when there is something to pick up. Told to somebody whose
    // install did not change, this sentence is the one that reads as "you are
    // current" — which is precisely the reassurance the old uniform
    // never-overwrite rule had no right to give.
    if (skills.wrote.length + skills.refreshed.length > 0) {
      console.log("  Start a new session so your runtime picks them up.");
      console.log("");
    }
  }
  // The one file laid down here that nobody will open unprompted, because it
  // is the only one that is blank on purpose. An unwritten soul.md is not an
  // error and the robot runs without it — it just runs as nobody, which is the
  // agent nobody remembers playing.
  console.log(`  ${join(where, "skills/steel/soul.md")} is blank. It is who your agent is:`);
  console.log("  ten questions, no answers, and nothing but this machine ever reads it.");
  console.log("  Answer them, or let the agent answer them. Steel never sees it.");
  console.log("");

  if (!start) {
    console.log(`Ready. Run it with:  cd ${where} && node agent.mjs`);
    return 0;
  }

  // `stdio: "inherit"` because the agent's output IS this command's output —
  // the claim URL it prints is the one thing the person is waiting for. It
  // also puts the child in this terminal's process group, so Ctrl-C reaches
  // it and the loop's own "leave the ship" path runs.
  //
  // ⚠ 2026-08-09: `--no-model` is FORWARDED, and a flag the front door cannot
  // pass is a flag that does not exist. `agent.mjs` now refuses to register
  // without a model key, because a keyless robot mints a row that reads as
  // claimed, never plays, and can therefore never be purged either — it just
  // stands on the deck. The escape it offers has to be reachable by the people
  // who arrive through `npx`, or the only way past the gate is a fake key,
  // which is the one outcome worse than the gate: an unusable key looks exactly
  // like a real one that expired.
  //
  // Everything above still runs first, on purpose. Somebody who forgot the key
  // keeps the robot, the skills and their own `soul.md`, and reads one sentence
  // naming the variable to set — which is a better arrival than a bot that
  // registers and then does nothing for three days.
  const child = spawn(
    process.execPath,
    ["agent.mjs", ...(argv.includes("--no-model") ? ["--no-model"] : [])],
    { cwd: target, stdio: "inherit" },
  );
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
