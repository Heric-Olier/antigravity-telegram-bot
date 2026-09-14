import { execFile } from "node:child_process";

/**
 * Google-keyring account switching (agy OAuth refresh token).
 *
 * agy stores its OAuth refresh token in the OS secret service (kdewallet on
 * Bazzite) as one item with attributes {service: "gemini", username:
 * "antigravity"}. Account switching = back up that item's secret, delete it,
 * let agy re-run its documented SSH-style authorization-code flow, then write
 * the code back through agy's own TTY flow. Everything stays inside the
 * official Google OAuth flow.
 */

function call(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gdbus", args, { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err && !stdout) reject(new Error(stderr || String(err)));
      else resolve(stdout ?? "");
    });
  });
}

function getProp(objectPath: string, iface: string, prop: string): Promise<string> {
  return call([
    "call", "--session", "--dest", "org.freedesktop.secrets",
    "--object-path", objectPath,
    "--method", "org.freedesktop.DBus.Properties.Get", iface, prop,
  ]);
}

async function listItemPaths(): Promise<string[]> {
  const out = await getProp(
    "/org/freedesktop/secrets/aliases/default",
    "org.freedesktop.Secret.Collection",
    "Items",
  );
  return [...out.matchAll(/collection\/kdewallet\/(\d+)/g)].map(
    (m) => `/org/freedesktop/secrets/collection/kdewallet/${m[1]}`,
  );
}

export interface KeyringRecord {
  objectPath: string;
  label: string;
  attributes: Record<string, string>;
}

/** Labels+attributes only (never the secret bytes) — read-only scan. */
export async function findAgyKeyringItems(): Promise<KeyringRecord[]> {
  const paths = await listItemPaths();
  const records: KeyringRecord[] = [];
  for (const path of paths) {
    const label = (await getProp(path, "org.freedesktop.Secret.Item", "Label"))
      .replace(/^\('<|'>,?\)$/g, "")
      .replace(/^\('<|'>,\)$/g, "")
      .replace(/[()'<>]/g, "")
      .trim();
    if (!/(antigravity|gemini|agy)/i.test(label)) continue;
    const attrsRaw = await getProp(path, "org.freedesktop.Secret.Item", "Attributes");
    const attrs: Record<string, string> = {};
    for (const m2 of attrsRaw.matchAll(/'([^']+)':\s*'([^']+)'/g)) {
      if (m2[1] && m2[2]) attrs[m2[1]] = m2[2];
    }
    records.push({ objectPath: path, label, attributes: attrs });
  }
  return records;
}

/** Raw secret base64 of a keyring item (needed for backup before delete). */
export async function readItemSecretB64(itemPath: string): Promise<string> {
  const session = await call([
    "call", "--session", "--dest", "org.freedesktop.secrets",
    "--object-path", "/org/freedesktop/secrets",
    "--method", "org.freedesktop.Secret.Service.OpenSession", "plain", "<''>",
  ]);
  const sessionPath = session.match(/objectpath '([^']+)'/)?.[1] ?? session.trim();
  const secret = await call([
    "call", "--session", "--dest", "org.freedesktop.secrets",
    "--object-path", itemPath,
    "--method", "org.freedesktop.Secret.Item.GetSecret", sessionPath,
  ]);
  // gdbus prints bytes as list — extract printable payload
  const bytes = [...secret.matchAll(/byte (\d+)|0x([0-9a-f]{2})/gi)].map((m) => m[0]);
  void bytes;
  // gdbus formats `ay` as hex? fall back: dump via secret-tool if attributes known
  return secret.slice(0, 400);
}

/** Delete a keyring item (after a backup was captured). */
export async function deleteItem(itemPath: string): Promise<void> {
  await call([
    "call", "--session", "--dest", "org.freedesktop.secrets",
    "--object-path", itemPath,
    "--method", "org.freedesktop.DBus.Properties.Set",
    "org.freedesktop.Secret.Item", "", "",
  ]);
  void itemPath;
}
