import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";

export const ComputerUseMode = Schema.Literals(["full", "view", "off"]);
export type ComputerUseMode = typeof ComputerUseMode.Type;

export const ComputerScreenshotInput = Schema.Struct({
  includeImage: Schema.optional(
    Schema.Boolean.annotate({ description: "false returns only the size." }),
  ),
});

export const ComputerScreenshotResult = Schema.Struct({
  screenshot: Schema.Struct({
    mimeType: Schema.Literal("image/png"),
    data: Schema.String,
    width: Schema.Int,
    height: Schema.Int,
  }),
});

export const ComputerActInput = Schema.Struct({
  action: Schema.Literals([
    "move",
    "click",
    "double_click",
    "right_click",
    "scroll",
    "type",
    "key",
  ]),
  x: Schema.optional(Schema.Int.annotate({ description: "Screenshot pixels." })),
  y: Schema.optional(Schema.Int.annotate({ description: "Screenshot pixels." })),
  text: Schema.optional(
    Schema.String.annotate({
      description: "`type`: literal text. `key`: combo such as ctrl+c or enter.",
    }),
  ),
  amount: Schema.optional(
    Schema.Int.annotate({ description: "`scroll`: notches. Positive scrolls up." }),
  ),
});
export type ComputerActInput = typeof ComputerActInput.Type;

export const ComputerActResult = Schema.Struct({ ok: Schema.Boolean });

/** What the desktop glow shows for this machine; `point` is a fraction of the primary display. */
export const ComputerUseActivity = Schema.Struct({
  state: Schema.Literals(["hidden", "driving", "inspecting"]),
  threadId: Schema.NullOr(ThreadId),
  point: Schema.NullOr(Schema.Struct({ x: Schema.Number, y: Schema.Number })),
});
export type ComputerUseActivity = typeof ComputerUseActivity.Type;

export const ComputerUseStopResult = Schema.Struct({ stopped: Schema.Boolean });
