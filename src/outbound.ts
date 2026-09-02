import { xml } from "@xmpp/client";
import type { XmppConfig, SendResult, Logger } from "./types.js";
import { getActiveClient } from "./monitor.js";
import { bareJid } from "./config-schema.js";

/** Send a plaintext one-to-one or configured-room text message. */
export async function sendXmppMessage(
  config: XmppConfig,
  to: string,
  text: string,
  options: { log?: unknown; accountId?: string } = {}
): Promise<SendResult> {
  const log = options.log as Logger | undefined;
  const accountId = options.accountId ?? "default";
  const client = getActiveClient(accountId);
  if (!client) return { ok: false, error: "XMPP client not connected" };

  const target = bareJid(to);
  const normalizedTarget = target.toLowerCase();
  const isMuc =
    config.groups?.some((room) => bareJid(room).toLowerCase() === normalizedTarget) ?? false;
  const messageId = `msg_${Date.now()}`;
  const message = xml(
    "message",
    { to: target, type: isMuc ? "groupchat" : "chat", id: messageId },
    xml("body", {}, text)
  );

  try {
    await client.send(message);
    log?.debug?.(`[XMPP] Sent text message to ${target}`);
    return { ok: true, messageId };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log?.error?.(`[XMPP] Failed to send text message: ${error}`);
    return { ok: false, error };
  }
}

/** Send an account presence update. */
export async function sendPresence(
  accountId: string,
  options: {
    status?: string;
    show?: "away" | "chat" | "dnd" | "xa";
    log?: Logger;
  } = {}
): Promise<SendResult> {
  const client = getActiveClient(accountId);
  if (!client) return { ok: false, error: "XMPP client not connected" };

  const children = [];
  if (options.show) children.push(xml("show", {}, options.show));
  if (options.status) children.push(xml("status", {}, options.status));

  try {
    await client.send(xml("presence", {}, ...children));
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    options.log?.error?.(`[XMPP] Failed to send presence: ${error}`);
    return { ok: false, error };
  }
}
