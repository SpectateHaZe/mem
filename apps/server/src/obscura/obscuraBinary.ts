// @effect-diagnostics nodeBuiltinImport:off -- a one-time install of a verified archive outside any Effect service.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import type { ObscuraFetchInput } from "@t3tools/contracts";

const VERSION = "0.2.6";
// The plain build on purpose: Mem never installs the bot-detection-evading "stealth" assets.
// shortcut: Windows x64 only, add assets and hashes if Mem ships for other hosts.
const ASSET = "obscura-x86_64-windows-no-render.zip";
const ASSET_SHA256 = "a9b88f38eb1f1efdbbb0adf1f526140dbbd4866d01f35d3452f899f5eb7c4442";
const MAX_CONTENT_CHARS = 100_000;

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

export const obscuraArgs = (input: ObscuraFetchInput) => {
  const url = URL.canParse(input.url) ? new URL(input.url) : undefined;
  if (url?.protocol !== "http:" && url?.protocol !== "https:") return undefined;
  return ["fetch", url.href, "--dump", input.dump ?? "text", "--obey-robots", "--quiet"];
};

export const limitContent = (content: string) => ({
  content: content.slice(0, MAX_CONTENT_CHARS),
  truncated: content.length > MAX_CONTENT_CHARS,
});

const install = async (stateDir: string, target: string) => {
  // @effect-diagnostics-next-line globalFetch:off
  const response = await fetch(
    "https://api.github.com/repos/h4ckf0r0day/obscura/releases/assets/696469077",
    { headers: { Accept: "application/octet-stream", "User-Agent": "Mem" } },
  );
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const sha256 = NodeCrypto.createHash("sha256").update(archive).digest("hex");
  if (sha256 !== ASSET_SHA256) throw new Error("Download did not match the pinned hash.");

  const temp = await NodeFSP.mkdtemp(NodePath.join(stateDir, "obscura-install-"));
  try {
    const zip = NodePath.join(temp, ASSET);
    await NodeFSP.writeFile(zip, archive);
    const tar = NodePath.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    await execFile(tar, ["-xf", zip, "-C", temp], { windowsHide: true });
    await NodeFSP.rm(zip);
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.rename(temp, target);
  } finally {
    await NodeFSP.rm(temp, { recursive: true, force: true });
  }
};

let installing: Promise<void> | undefined;

/** Installs on first use so that leaving the setting off downloads nothing. */
export const ensureObscura = async (stateDir: string) => {
  const target = NodePath.join(stateDir, "obscura", VERSION);
  const executable = NodePath.join(target, "obscura.exe");
  const installed = await NodeFSP.access(executable).then(
    () => true,
    () => false,
  );
  if (!installed) {
    installing ??= install(stateDir, target).finally(() => {
      installing = undefined;
    });
    await installing;
  }
  return executable;
};
