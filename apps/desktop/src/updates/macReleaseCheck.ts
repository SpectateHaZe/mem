import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Schema from "effect/Schema";

import { desktopUpdateChannelOf } from "@t3tools/shared/cliRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";

const MAC_RELEASE_TAG_VERSION = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const MAC_RELEASE_FETCH_TIMEOUT = Duration.seconds(30);
/** Nightlies can push stable releases past the first page; one is enough for a mac feed. */
const MAC_RELEASE_PAGE_SIZE = 10;

export interface MacReleaseRepository {
  readonly owner: string;
  readonly repo: string;
}

/** The GitHub repository an unsigned mac build checks itself against, or null for any other feed. */
export function githubMacReleaseRepository(
  appUpdateYml: Readonly<Record<string, string>> | null | undefined,
): MacReleaseRepository | null {
  if (!appUpdateYml || appUpdateYml.provider !== "github") return null;
  const owner = appUpdateYml.owner?.trim() ?? "";
  const repo = appUpdateYml.repo?.trim() ?? "";
  return owner.length > 0 && repo.length > 0 ? { owner, repo } : null;
}

export function githubMacReleasesUrl(repository: MacReleaseRepository): string {
  return `https://api.github.com/repos/${repository.owner}/${repository.repo}/releases?per_page=${MAC_RELEASE_PAGE_SIZE}`;
}

export function githubMacReleasePageUrl(repository: MacReleaseRepository, tag: string): string {
  return `https://github.com/${repository.owner}/${repository.repo}/releases/tag/${encodeURIComponent(tag)}`;
}

export function macReleaseVersionOf(tag: string): string | undefined {
  return MAC_RELEASE_TAG_VERSION.exec(tag)?.[1];
}

/** The first (newest) release of the configured track, by the feed's release order. */
export function newestMacReleaseTag(
  releases: ReadonlyArray<{ readonly tag_name: string; readonly draft?: boolean | undefined }>,
  channel: "latest" | "nightly",
): string | undefined {
  for (const release of releases) {
    // Draft assets are not downloadable.
    if (release.draft) continue;
    const version = macReleaseVersionOf(release.tag_name);
    if (version === undefined) continue;
    if (desktopUpdateChannelOf(version) === channel) return release.tag_name;
  }
  return undefined;
}

/** A strictly newer release than the running build, else null; the comparison is proper semver. */
export function macManualUpdateOffer(args: {
  readonly tag: string;
  readonly currentVersion: string;
  readonly repository: MacReleaseRepository;
}): { version: string; releaseUrl: string } | null {
  const version = macReleaseVersionOf(args.tag);
  if (version === undefined) return null;
  if (compareSemverVersions(version, args.currentVersion) <= 0) return null;
  return {
    version,
    releaseUrl: githubMacReleasePageUrl(args.repository, args.tag),
  };
}

export class MacReleaseFeedError extends Schema.TaggedError<MacReleaseFeedError>()(
  "MacReleaseFeedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export interface MacReleaseFeedEntry {
  readonly tag_name: string;
  readonly draft?: boolean | undefined;
}

const MacReleaseListSchema = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.optional(Schema.Boolean),
});
const decodeMacReleaseList = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(MacReleaseListSchema)),
);

/**
 * The transport the unsigned mac release check reads its feed with, so tests fake the network.
 * All failures are `MacReleaseFeedError` and the check handles them quietly.
 */
export class MacReleaseHttp extends Context.Service<
  MacReleaseHttp,
  {
    readonly getReleases: (
      url: string,
    ) => Effect.Effect<ReadonlyArray<MacReleaseFeedEntry>, MacReleaseFeedError>;
  }
>()("@t3tools/desktop/updates/macReleaseCheck/MacReleaseHttp") {}

export const MacReleaseHttpLayer = Layer.effect(
  MacReleaseHttp,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    return {
      getReleases: Effect.fn("desktop.updates.macReleaseHttp.getReleases")(function* (url: string) {
        const request = HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
        );
        return yield* httpClient.execute(request).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.text),
          Effect.mapError(
            () => new MacReleaseFeedError({ reason: "The mac release feed could not be read." }),
          ),
          Effect.timeoutOrElse({
            duration: MAC_RELEASE_FETCH_TIMEOUT,
            orElse: () =>
              Effect.fail(new MacReleaseFeedError({ reason: "The mac release feed timed out." })),
          }),
          Effect.flatMap((text) =>
            decodeMacReleaseList(text).pipe(
              Effect.mapError(
                () =>
                  new MacReleaseFeedError({
                    reason: "The mac release feed had an unexpected shape.",
                  }),
              ),
            ),
          ),
        );
      }),
    };
  }),
);
