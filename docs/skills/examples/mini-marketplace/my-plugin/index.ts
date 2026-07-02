// @ts-nocheck — example file; install jeopi before running
import type { ExtensionAPI } from "jeopi-cli";

export default function myPlugin(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("my-plugin loaded from example marketplace!", "info");
  });
}
