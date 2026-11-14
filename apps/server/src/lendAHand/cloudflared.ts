// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- a one-time verified install and one long-lived child whose PID Mem owns.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const VERSION = "2026.10.6";
const ASSETS: Partial<Record<NodeJS.Platform, { readonly name: string; readonly sha256: string }>> =
  {
    win32: {
      name: "cloudflared-windows-amd64.exe",
      sha256: "d521b3bf68982165f0d06d76732f22d9a105ef057ff3ae4c0986f3a23190950f",
    },
    // shortcut: Apple Silicon only, add darwin-amd64 if Intel Macs need to host.
    darwin: {
      name: "cloudflared-darwin-arm64.tgz",
      sha256: "ea1e5105d35bbe16cee5b2f7b4742059ada341fbd35938ed827c24b85efa51c8",
    },
  };
const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const TUNNEL_START_TIMEOUT_MS = 45_000;

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

/** The quick-tunnel address in cloudflared's log output, if this chunk has it. */
export const tunnelUrlIn = (output: string) => TUNNEL_URL.exec(output)?.[0];

const install = async (platform: NodeJS.Platform, directory: string, executable: string) => {
  const asset = ASSETS[platform];
  if (asset === undefined) throw new Error("Lend a Hand can only host on Windows or macOS.");
  // @effect-diagnostics-next-line globalFetch:off
  const response = await fetch(
    `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${asset.name}`,
    { headers: { "User-Agent": "Mem" } },
  );
  if (!response.ok) throw new Error(`Downloading cloudflared failed: ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  const sha256 = NodeCrypto.createHash("sha256").update(body).digest("hex");
  if (sha256 !== asset.sha256) throw new Error("cloudflared did not match the pinned hash.");

  await NodeFSP.mkdir(directory, { recursive: true });
  const temp = await NodeFSP.mkdtemp(NodePath.join(directory, "install-"));
  try {
    if (asset.name.endsWith(".tgz")) {
      const archive = NodePath.join(temp, asset.name);
      await NodeFSP.writeFile(archive, body);
      await execFile("/usr/bin/tar", ["-xzf", archive, "-C", temp]);
      await NodeFSP.chmod(NodePath.join(temp, "cloudflared"), 0o755);
      await NodeFSP.rename(NodePath.join(temp, "cloudflared"), executable);
    } else {
      await NodeFSP.writeFile(NodePath.join(temp, "cloudflared.exe"), body);
      await NodeFSP.rename(NodePath.join(temp, "cloudflared.exe"), executable);
    }
  } finally {
    await NodeFSP.rm(temp, { recursive: true, force: true });
  }
};

let installing: Promise<void> | undefined;

/** Installs on first use, so a user who never asks for a hand downloads nothing. */
export const ensureCloudflared = async (stateDir: string, platform: NodeJS.Platform) => {
  const directory = NodePath.join(stateDir, "cloudflared", VERSION);
  const executable = NodePath.join(
    directory,
    platform === "win32" ? "cloudflared.exe" : "cloudflared",
  );
  const installed = await NodeFSP.access(executable).then(
    () => true,
    () => false,
  );
  if (!installed) {
    installing ??= install(platform, directory, executable).finally(() => {
      installing = undefined;
    });
    await installing;
  }
  return executable;
};

export interface Tunnel {
  readonly url: string;
  readonly close: () => void;
  /** Called once if cloudflared exits on its own. */
  readonly onExit: (listener: () => void) => void;
}

/** Opens a quick tunnel to `localUrl`; resolves once Cloudflare has handed out the address. */
export const openTunnel = (executable: string, localUrl: string) =>
  new Promise<Tunnel>((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      executable,
      ["tunnel", "--no-autoupdate", "--url", localUrl],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let settled = false;
    let exitListener: (() => void) | undefined;
    const timer = setTimeout(() => {
      fail(new Error("Cloudflare did not open a tunnel in time. Check the internet connection."));
    }, TUNNEL_START_TIMEOUT_MS);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const read = (chunk: Buffer) => {
      const url = tunnelUrlIn(chunk.toString("utf8"));
      if (url === undefined || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        url,
        // Only this child, by the handle Mem spawned: never by name.
        close: () => child.kill(),
        onExit: (listener) => {
          exitListener = listener;
        },
      });
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", (error) => fail(error));
    child.on("exit", () => {
      fail(new Error("cloudflared exited before the tunnel opened."));
      exitListener?.();
    });
  });
