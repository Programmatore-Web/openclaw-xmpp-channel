import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { xmppPlugin } from "./src/channel.js";
import { setXmppRuntime } from "./src/runtime.js";

const plugin = {
  id: "xmpp",
  name: "XMPP",
  description: "XMPP channel plugin (Prosody, ejabberd)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi): void {
    setXmppRuntime(api.runtime);
    api.registerChannel({ plugin: xmppPlugin });
  },
};

export default plugin;

// Re-export utilities for external use
export { xmppPlugin } from "./src/channel.js";
export { xmppOnboardingAdapter } from "./src/onboarding.js";
export {
  listXmppAccountIds,
  resolveDefaultXmppAccountId,
  resolveXmppAccount,
} from "./src/accounts.js";
export { collectXmppStatusIssues } from "./src/status-issues.js";
export {
  looksLikeXmppJid,
  normalizeXmppTarget,
  normalizeXmppMessagingTarget,
} from "./src/normalize.js";
export { XmppConfigSchema } from "./src/config-schema.js";
export type { XmppConfig, ResolvedXmppAccount, XmppInboundMessage } from "./src/types.js";
export { getActiveClient } from "./src/monitor.js";
