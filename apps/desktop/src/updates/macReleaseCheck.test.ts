import { describe, expect, it } from "vite-plus/test";

import {
  githubMacReleasesUrl,
  githubMacReleasePageUrl,
  githubMacReleaseRepository,
  macManualUpdateOffer,
  macReleaseVersionOf,
  newestMacReleaseTag,
} from "./macReleaseCheck.ts";

const repository = { owner: "SpectateHaZe", repo: "mem" };
const releases = (tags: readonly (string | { tag: string; draft?: boolean })[]) =>
  tags.map((entry) =>
    typeof entry === "string" ? { tag_name: entry } : { tag_name: entry.tag, draft: entry.draft },
  );

describe("macReleaseCheck repository", () => {
  it("reads the repository a GitHub feed names", () => {
    expect(
      githubMacReleaseRepository({ provider: "github", owner: "SpectateHaZe", repo: "mem" }),
    ).toEqual(repository);
  });

  it("rejects non-GitHub and incomplete feeds", () => {
    expect(
      githubMacReleaseRepository({ provider: "generic", url: "https://example.com" }),
    ).toBeNull();
    expect(githubMacReleaseRepository({ provider: "github", owner: "SpectateHaZe" })).toBeNull();
    expect(githubMacReleaseRepository(null)).toBeNull();
  });

  it("builds the feed and release-page URLs", () => {
    expect(githubMacReleasesUrl(repository)).toBe(
      "https://api.github.com/repos/SpectateHaZe/mem/releases?per_page=10",
    );
    expect(githubMacReleasePageUrl(repository, "v0.1.10")).toBe(
      "https://github.com/SpectateHaZe/mem/releases/tag/v0.1.10",
    );
  });
});

describe("macReleaseCheck version comparison", () => {
  it("finds a newer release on the same track", () => {
    const offer = macManualUpdateOffer({
      tag: "v0.1.10",
      currentVersion: "0.1.9",
      repository,
    });
    expect(offer).toEqual({
      version: "0.1.10",
      releaseUrl: "https://github.com/SpectateHaZe/mem/releases/tag/v0.1.10",
    });
  });

  it("compares versions numerically, not lexically", () => {
    const offer = macManualUpdateOffer({
      tag: "v0.1.10",
      currentVersion: "0.1.9",
      repository,
    });
    expect(offer?.version).toBe("0.1.10");
    // Lexical compare would read "0.1.10" as older than "0.1.9".
    expect(offer).not.toBeNull();
  });

  it("offers nothing for the running or an older release", () => {
    expect(macManualUpdateOffer({ tag: "v0.1.9", currentVersion: "0.1.9", repository })).toBeNull();
    expect(macManualUpdateOffer({ tag: "v0.1.8", currentVersion: "0.1.9", repository })).toBeNull();
  });

  it("rejects tags that are not release versions", () => {
    expect(macReleaseVersionOf("nightly")).toBeUndefined();
    expect(
      macManualUpdateOffer({ tag: "chore-note", currentVersion: "0.1.9", repository }),
    ).toBeNull();
  });
});

describe("macReleaseCheck channel selection", () => {
  it("picks the newest release of the track, skipping drafts and foreign tracks", () => {
    expect(
      newestMacReleaseTag(
        releases(["v0.1.12", "v0.1.11-nightly.20260912.7", "v0.1.10", "v0-1-9"]),
        "latest",
      ),
    ).toBe("v0.1.12");
    expect(
      newestMacReleaseTag(
        releases(["v0.1.12", "v0.1.11-nightly.20260912.7", "v0.1.10"]),
        "nightly",
      ),
    ).toBe("v0.1.11-nightly.20260912.7");
    expect(
      newestMacReleaseTag(releases(["v0.1.10", { tag: "v0.1.11", draft: true }]), "latest"),
    ).toBe("v0.1.10");
  });

  it("finds nothing when the feed has no release of the track", () => {
    expect(newestMacReleaseTag(releases(["v0.1.10"]), "nightly")).toBeUndefined();
    expect(newestMacReleaseTag([], "latest")).toBeUndefined();
  });
});
