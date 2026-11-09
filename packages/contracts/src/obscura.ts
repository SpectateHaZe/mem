import * as Schema from "effect/Schema";

export const ObscuraFetchInput = Schema.Struct({
  url: Schema.String.annotate({ description: "http or https URL." }),
  dump: Schema.optional(Schema.Literals(["text", "html", "links"])),
});
export type ObscuraFetchInput = typeof ObscuraFetchInput.Type;

export const ObscuraFetchResult = Schema.Struct({
  content: Schema.String,
  truncated: Schema.Boolean,
});
