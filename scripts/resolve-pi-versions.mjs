#!/usr/bin/env node
// Resolve the Pi versions CI must verify against: the current latest release
// and the highest release of the previous minor line. Prints a GitHub Actions
// matrix (used via `matrix.include`) as single-line JSON on stdout.
//
// The extension patches pi-tui's internal Markdown renderer, so a renderer
// shape change can break it without any API-level signal. Pinning both the
// current and the previous minor turns that breakage into a red CI run before
// users ever see it.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const PACKAGE = "@earendil-works/pi-coding-agent";
const TUI = "@earendil-works/pi-tui";

async function npmView(...args) {
  const { stdout } = await run("npm", ["view", ...args, "--json"]);
  const value = JSON.parse(stdout || "null");
  if (value === null) throw new Error(`npm view ${args.join(" ")} returned nothing`);
  return value;
}

function parseVersion(version) {
  const [major = 0, minor = 0] = version.replace(/-.*$/, "").split(".").map(Number);
  return { major, minor };
}

/**
 * The extension renders through pi-tui, but CI imports pi-tui directly. Pin it
 * to the dependency range the chosen pi release declares so the tested shape is
 * the one that Pi instance actually ships.
 */
async function tuiRangeFor(piVersion) {
  const dependencies = await npmView(`${PACKAGE}@${piVersion}`, "dependencies");
  const range = dependencies?.[TUI];
  if (!range) throw new Error(`${PACKAGE}@${piVersion} declares no ${TUI} dependency`);
  return range;
}

try {
  const latest = await npmView(PACKAGE, "version");
  const versions = await npmView(PACKAGE, "versions");
  const stable = versions.filter((version) => !version.includes("-"));
  const { major, minor } = parseVersion(latest);

  // Highest release of the previous minor line; walk back across a minor 0.
  let previousMinor;
  for (let candidate = minor - 1; candidate >= 0 && !previousMinor; candidate--) {
    previousMinor = stable
      .filter((version) => {
        const parsed = parseVersion(version);
        return parsed.major === major && parsed.minor === candidate;
      })
      .pop();
  }
  if (major > 0 && !previousMinor) {
    previousMinor = stable
      .filter((version) => parseVersion(version).major === major - 1)
      .pop();
  }

  const targets = [latest, ...(previousMinor ? [previousMinor] : [])];
  const matrix = [];
  for (const pi of targets) {
    matrix.push({ pi, tui: await tuiRangeFor(pi) });
  }
  console.log(JSON.stringify(matrix));
} catch (error) {
  // Never block CI on resolution problems: fall back to unpinned peers, which
  // is what CI did before the matrix existed.
  console.error(`resolve-pi-versions: falling back to unpinned peers (${error.message})`);
  console.log(JSON.stringify([{ pi: "latest", tui: "latest" }]));
}
