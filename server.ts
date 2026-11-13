// bb-plugin-duo-rail — backend entry.
//
// The plugin is all frontend (see app.tsx). The server only declares the
// settings the app reads through useSettings().
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export default async function plugin(bb: BbPluginApi) {
  bb.settings.define({
    mode: {
      type: "select",
      label: "Expand chat into the side rail",
      description:
        "Auto expands whenever a folded side rail is detected (portrait with a left or right safe-area inset). Manual waits for the Expand into rail action in the thread menu. Off never changes the layout.",
      options: ["auto", "manual", "off"],
      experimental_optionLabels: {
        auto: "Auto (default)",
        manual: "Manual toggle only",
        off: "Off",
      },
      default: "auto",
    },
    cameraAreaHeight: {
      type: "number",
      label: "Camera and status bar area height (pt)",
      description:
        "Height of the block at the top of the rail that holds the camera and the iOS status bar. The header stays beside it, a cap covers it, and the toggle button sits just below it.",
      experimental_schema: z.number().int().min(0).max(400),
      default: 240,
    },
    sideInset: {
      type: "number",
      label: "Rail-side inset (pt)",
      description:
        "Space kept clear on the rail side while expanded. Leave at 0 to fill the rail. Raise it if the status bar or camera runs down the rail and covers the chat.",
      experimental_schema: z.number().int().min(0).max(120),
      default: 0,
    },
  });
}
