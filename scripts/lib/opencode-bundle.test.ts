// @effect-diagnostics nodeBuiltinImport:off - Node's SHA-256 digests the fixture bytes for the expected checksum.
import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  OpenCodeBundleChecksumMismatchError,
  OPENCODE_BUNDLE_VERSION,
  openCodeBundleAssetUrl,
  resolveOpenCodeBundleAsset,
  verifyOpenCodeBundleChecksum,
} from "./opencode-bundle.ts";

const sha256 = (content: string) =>
  NodeCrypto.createHash("sha256").update(content, "utf8").digest("hex");

it.layer(NodeServices.layer)("opencode bundle", (it) => {
  describe("assets", () => {
    it("pins the release asset and checksum for win-x64 and mac-arm64 only", () => {
      const windows = resolveOpenCodeBundleAsset({ platform: "win", arch: "x64" });
      assert.equal(windows?.assetName, "opencode-windows-x64.zip");
      assert.equal(windows?.binaryName, "opencode.exe");
      assert.match(windows?.sha256 ?? "", /^[0-9a-f]{64}$/);

      const mac = resolveOpenCodeBundleAsset({ platform: "mac", arch: "arm64" });
      assert.equal(mac?.assetName, "opencode-darwin-arm64.zip");
      assert.equal(mac?.binaryName, "opencode");
      assert.match(mac?.sha256 ?? "", /^[0-9a-f]{64}$/);

      assert.equal(resolveOpenCodeBundleAsset({ platform: "win", arch: "arm64" }), undefined);
      assert.equal(resolveOpenCodeBundleAsset({ platform: "mac", arch: "x64" }), undefined);
      assert.equal(resolveOpenCodeBundleAsset({ platform: "mac", arch: "universal" }), undefined);
      assert.equal(resolveOpenCodeBundleAsset({ platform: "linux", arch: "x64" }), undefined);
      assert.equal(resolveOpenCodeBundleAsset({ platform: "win", arch: undefined }), undefined);
    });

    it("builds release download URLs from the pinned version", () => {
      assert.equal(
        openCodeBundleAssetUrl("opencode-windows-x64.zip"),
        `https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_BUNDLE_VERSION}/opencode-windows-x64.zip`,
      );
    });
  });

  describe("verifyOpenCodeBundleChecksum", () => {
    it.effect("accepts a matching SHA-256", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "opencode-bundle-test-" });
          const content = "opencode asset bytes";
          const filePath = path.join(dir, "asset.zip");
          yield* fs.writeFileString(filePath, content);
          const exit = yield* Effect.exit(
            verifyOpenCodeBundleChecksum({
              filePath,
              assetName: "asset.zip",
              expectedSha256: sha256(content),
            }),
          );
          assert.isTrue(Exit.isSuccess(exit));
        }),
      ),
    );

    it.effect("fails the build on a checksum mismatch", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "opencode-bundle-test-" });
          const filePath = path.join(dir, "opencode-darwin-arm64.zip");
          yield* fs.writeFileString(filePath, "tampered bytes");
          const error = yield* verifyOpenCodeBundleChecksum({
            filePath,
            assetName: "opencode-darwin-arm64.zip",
            expectedSha256: sha256("opencode asset bytes"),
          }).pipe(Effect.flip);
          assert.instanceOf(error, OpenCodeBundleChecksumMismatchError);
          assert.equal(error.assetName, "opencode-darwin-arm64.zip");
        }),
      ),
    );
  });
});
