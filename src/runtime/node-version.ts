const LOWEST_SUPPORTED_MAJOR = 22;

/**
 * Lowest minor of each Node.js release line that ships Node-API v10.
 * Later majors ship it in every release, so they are not listed.
 */
const MINIMUM_MINOR_BY_MAJOR = new Map<number, number>([
  [22, 14],
  [23, 6],
]);

const SUPPORTED_NODE_VERSIONS = "22.14+, 23.6+, or 24+";

/**
 * Returns an error message when the running Node.js is too old, otherwise null.
 *
 * Must be checked before any module that loads a native addon is imported:
 * better-sqlite3 crashes the process with SIGSEGV on unsupported Node.js
 * versions, and such a crash cannot be caught by try/catch. Its prebuilt addon
 * requires Node-API v10, which landed in Node.js 22.14 and 23.6.
 */
export function getUnsupportedNodeVersionMessage(
  version: string = process.versions.node,
): string | null {
  const [rawMajor, rawMinor] = version.split(".");
  const major = Number.parseInt(rawMajor ?? "", 10);
  const minor = Number.parseInt(rawMinor ?? "", 10);

  if (!Number.isInteger(major) || !Number.isInteger(minor)) {
    return null;
  }

  if (major >= LOWEST_SUPPORTED_MAJOR) {
    const minimumMinor = MINIMUM_MINOR_BY_MAJOR.get(major);

    if (minimumMinor === undefined || minor >= minimumMinor) {
      return null;
    }
  }

  return [
    `OpenCode Telegram Bot requires Node.js ${SUPPORTED_NODE_VERSIONS}, but the current version is v${version}.`,
    "Update Node.js and try again: https://nodejs.org",
  ].join("\n");
}
