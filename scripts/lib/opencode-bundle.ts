// @effect-diagnostics nodeBuiltinImport:off - Node's SHA-256 digests the downloaded release asset for verification.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";

import type { BuildArch, BuildPlatform } from "./build-target-arch.ts";

// Pinned OpenCode CLI release (MIT: https://github.com/anomalyco/opencode/blob/dev/LICENSE)
// bundled into desktop builds; checksums come from the release's SHA256SUMS asset.
export const OPENCODE_BUNDLE_VERSION = "2.2.6";
const OPENCODE_BUNDLE_RELEASE_REPO = "anomalyco/opencode";

export interface OpenCodeBundleAsset {
  readonly assetName: string;
  readonly binaryName: string;
  readonly sha256: string;
}

const OPENCODE_BUNDLE_ASSETS: Readonly<Record<string, OpenCodeBundleAsset>> = {
  "mac:arm64": {
    assetName: "opencode-darwin-arm64.zip",
    binaryName: "opencode",
    sha256: "15491608f6b0bc4debe5eac35eab629a2b07ea9a1fbac68ad53bcea59fcc4b45",
  },
  "win:x64": {
    assetName: "opencode-windows-x64.zip",
    binaryName: "opencode.exe",
    sha256: "f75c16b33b8523fe1ff41e7d97e3ae654a47d59a0e327def24db2d9291bb24be",
  },
};

export function resolveOpenCodeBundleAsset(input: {
  readonly platform: BuildPlatform;
  readonly arch: BuildArch | undefined;
}): OpenCodeBundleAsset | undefined {
  return OPENCODE_BUNDLE_ASSETS[`${input.platform}:${input.arch}`];
}

export class OpenCodeBundleChecksumMismatchError extends Schema.TaggedError<OpenCodeBundleChecksumMismatchError>()(
  "OpenCodeBundleChecksumMismatchError",
  {
    assetName: Schema.String,
    expectedSha256: Schema.String,
    actualSha256: Schema.String,
  },
) {
  override get message(): string {
    return `OpenCode release asset ${this.assetName} failed the SHA-256 check: expected ${this.expectedSha256}, got ${this.actualSha256}.`;
  }
}

export const verifyOpenCodeBundleChecksum = Effect.fn("verifyOpenCodeBundleChecksum")(
  function* (input: {
    readonly filePath: string;
    readonly assetName: string;
    readonly expectedSha256: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const hash = NodeCrypto.createHash("sha256");
    yield* fs
      .stream(input.filePath)
      .pipe(Stream.runForEach((chunk) => Effect.sync(() => hash.update(chunk))));
    const actualSha256 = hash.digest("hex").toLowerCase();
    if (actualSha256 !== input.expectedSha256.toLowerCase()) {
      return yield* new OpenCodeBundleChecksumMismatchError({
        assetName: input.assetName,
        expectedSha256: input.expectedSha256.toLowerCase(),
        actualSha256,
      });
    }
  },
);

export const openCodeBundleAssetUrl = (assetName: string): string =>
  `https://github.com/${OPENCODE_BUNDLE_RELEASE_REPO}/releases/download/v${OPENCODE_BUNDLE_VERSION}/${assetName}`;

const OPENCODE_BUNDLE_DOWNLOAD_ATTEMPTS = 3;

export const downloadOpenCodeBundleFile = Effect.fn("downloadOpenCodeBundleFile")(
  function* (input: { readonly url: string; readonly destinationPath: string }) {
    const fs = yield* FileSystem.FileSystem;
    const client = yield* HttpClient.HttpClient;
    yield* client.get(input.url).pipe(
      Effect.flatMap((response) => Stream.run(response.stream, fs.sink(input.destinationPath))),
      Effect.retry({
        times: OPENCODE_BUNDLE_DOWNLOAD_ATTEMPTS - 1,
        schedule: Schedule.spaced("2 seconds"),
      }),
      Effect.scoped,
    );
  },
);
