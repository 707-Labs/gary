import { createSlackIngressEmitter, slackEnvelopeShape, type SlackIngressObserver } from './ingress-diagnostics.ts';
import { validSlackCredentials, type SlackCredentials } from "./credentials.ts";

export interface SlackIdentity { readonly appId: string; readonly teamId: string; readonly botUserId: string }
export interface SlackMessage { readonly channel: string; readonly text: string; readonly threadTs?: string }
export type SlackSendResult = { ok: true; channel: string; ts: string }
  | { ok: false; outcome: "definitely_not_sent" | "unknown"; code: string };
export interface SlackMemberMetadata { readonly id:string; readonly teamId:string; readonly deleted:boolean; readonly isBot:boolean; readonly isAppUser:boolean; readonly isRestricted:boolean; readonly isUltraRestricted:boolean; readonly isStranger:boolean; readonly observedAt:number }
export interface SlackChannelMetadata { readonly id:string; readonly teamId:string; readonly isMember:boolean; readonly isArchived:boolean; readonly isPrivate:boolean; readonly isShared:boolean; readonly isExtShared:boolean; readonly isOrgShared:boolean; readonly isPendingExtShared:boolean; readonly observedAt:number }
export interface SlackTransport {
  /** Host-only metadata for explicit channel mentions; never history or profile text. */
  memberInfo?(userId:string,signal?:AbortSignal):Promise<SlackMemberMetadata>;
  channelInfo?(channelId:string,signal?:AbortSignal):Promise<SlackChannelMetadata>;
  identity(signal?: AbortSignal): Promise<SlackIdentity>;
  socketHealthy(): boolean;
  sendMessage(message: SlackMessage, signal?: AbortSignal): Promise<SlackSendResult>;
  /** Envelopes are untrusted; the service must validate identity, event and policy. */
  start(onEnvelope: (envelope: unknown) => void | Promise<void>, signal?: AbortSignal): Promise<void>;
  stop(): Promise<void>;
}

export const APPROVED_SLACK_IDENTITY: SlackIdentity = Object.freeze({
  appId: "A0C7QFW3PEG", teamId: "T0AA24R7VUZ", botUserId: "U0C7NPEUG1F",
});
export type SlackFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface SlackSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Bun's immediate close; stops a peer from holding the closing handshake. */
  terminate?(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}
export interface SlackTransportOptions {
  credentials: SlackCredentials;
  onIngressDiagnostic?:SlackIngressObserver;
  /** Dependency seams for offline tests; production uses global fetch/WebSocket. */
  fetch?: SlackFetch;
  createSocket?: (url: string) => SlackSocket;
  httpTimeoutMs?: number;
  helloTimeoutMs?: number;
  maxReconnectAttempts?: number;
  reconnectBaseMs?: number;
}
type FaultCode = "slack_configuration_rejected" | "slack_transport_stopped" | "slack_request_cancelled"
  | "slack_request_timeout" | "slack_network_failure" | "slack_response_rejected" | "slack_api_rejected"
  | "slack_rate_limited" | "slack_identity_mismatch" | "slack_socket_url_rejected" | "slack_socket_unhealthy"
  | "slack_socket_protocol_rejected" | "slack_socket_identity_mismatch" | "slack_reconnect_exhausted"
  | "slack_transport_already_started";
export class SlackTransportError extends Error {
  constructor(readonly code: FaultCode) { super(code); this.name = "SlackTransportError"; }
}
const fail = (code: FaultCode): never => { throw new SlackTransportError(code); };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const MAX_HTTP_BYTES = 65_536;
const MAX_SOCKET_BYTES = 262_144;
const definiteRejections = new Set([
  "invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive", "missing_scope",
  "no_permission", "not_in_channel", "channel_not_found", "is_archived", "msg_too_long", "no_text",
  "invalid_arguments", "invalid_arg_name", "invalid_thread_ts", "restricted_action", "ratelimited", "rate_limited",
]);

/** Only server-issued Slack Socket Mode endpoints; tickets never enter logs. */
export function validateSlackSocketUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192 || /[\s\\]/.test(value)) return fail("slack_socket_url_rejected");
  try {
    const url = new URL(value);
    if (url.protocol !== "wss:" || !/^wss(?:-[a-z0-9]+)?\.slack\.com$/.test(url.hostname)
        || url.port || url.username || url.password || url.hash || url.pathname !== "/link/"
        || url.searchParams.getAll("ticket").length !== 1 || !url.searchParams.get("ticket")) throw new Error();
    return url.href;
  } catch { return fail("slack_socket_url_rejected"); }
}

async function readJson(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_HTTP_BYTES)) {
    void response.body?.cancel().catch(() => undefined);
    return fail("slack_response_rejected");
  }
  if (!response.body) return fail("slack_response_rejected");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_HTTP_BYTES) return fail("slack_response_rejected");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!record(value)) return fail("slack_response_rejected");
    return value;
  } catch { return fail("slack_response_rejected"); }
  finally { signal.removeEventListener("abort", cancel); void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export function createSlackTransport(options: SlackTransportOptions): SlackTransport {
  if (!options || !validSlackCredentials(options.credentials)) return fail("slack_configuration_rejected");
  const observe=createSlackIngressEmitter('transport',options.onIngressDiagnostic);
  const credentials = Object.freeze({ ...options.credentials });
  const fetcher = options.fetch ?? ((url, init) => fetch(url, init));
  const socketFactory = options.createSocket ?? ((url) => new WebSocket(url) as unknown as SlackSocket);
  const bounded = (value: number | undefined, fallback: number, min: number, max: number) => {
    const n = value ?? fallback;
    if (!Number.isInteger(n) || n < min || n > max) return fail("slack_configuration_rejected");
    return n;
  };
  const httpTimeout = bounded(options.httpTimeoutMs, 10_000, 1, 30_000);
  const helloTimeout = bounded(options.helloTimeoutMs, 10_000, 1, 30_000);
  const maxReconnect = bounded(options.maxReconnectAttempts, 3, 0, 8);
  const backoff = bounded(options.reconnectBaseMs, 1_000, 1, 10_000);
  const lifetime = new AbortController();
  const requests = new Set<AbortController>();
  let stopped = false;
  let healthy = false;
  let started = false;
  let helloAppId: string | undefined;
  let socket: SlackSocket | undefined;
  let runner: Promise<void> | undefined;
  let unlinkStartSignal: (() => void) | undefined;
  let pendingHandlers = 0;

  async function request(method: "auth.test" | "apps.connections.open" | "chat.postMessage" | "users.info" | "conversations.info",
    body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (stopped) return fail("slack_transport_stopped");
    if (signal?.aborted) return fail("slack_request_cancelled");
    const controller = new AbortController();
    requests.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, httpTimeout);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new SlackTransportError(timedOut ? "slack_request_timeout" : "slack_request_cancelled"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([aborted, (async () => {
        const metadataRead = method === "users.info" || method === "conversations.info";
        let requestUrl = `https://slack.com/api/${method}`;
        if (metadataRead) {
          const key = method === "users.info" ? "user" : "channel";
          const value = body[key];
          if (typeof value !== "string" || Object.keys(body).length !== 1) return fail("slack_configuration_rejected");
          requestUrl += `?${new URLSearchParams({ [key]: value })}`;
        }
        const response = await fetcher(requestUrl, {
          method: metadataRead ? "GET" : "POST", redirect: "error", credentials: "omit", signal: controller.signal,
          headers: { ...(metadataRead ? {} : { "Content-Type": "application/json; charset=utf-8" }), "Cache-Control": "no-store",
            Authorization: `Bearer ${method === "apps.connections.open" ? credentials.appToken : credentials.botToken}` },
          ...(metadataRead ? {} : { body: JSON.stringify(body) }),
        });
        if (response.redirected || (response.url && response.url !== requestUrl)) {
          void response.body?.cancel().catch(() => undefined);
          return fail("slack_response_rejected");
        }
        if (response.status === 429) {
          void response.body?.cancel().catch(() => undefined);
          return fail("slack_rate_limited");
        }
        if (response.status !== 200) {
          void response.body?.cancel().catch(() => undefined);
          return fail("slack_response_rejected");
        }
        return await readJson(response, controller.signal);
      })()]);
    } catch (error) {
      if (error instanceof SlackTransportError) throw error;
      return fail("slack_network_failure");
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      signal?.removeEventListener("abort", abort);
      requests.delete(controller);
      controller.abort();
    }
  }

  async function auth(signal?: AbortSignal): Promise<void> {
    const value = await request("auth.test", {}, signal);
    if (value.ok !== true) return fail("slack_api_rejected");
    if (value.team_id !== APPROVED_SLACK_IDENTITY.teamId || value.user_id !== APPROVED_SLACK_IDENTITY.botUserId
        || typeof value.bot_id !== "string" || !/^B[A-Z0-9]{2,63}$/.test(value.bot_id)) return fail("slack_identity_mismatch");
  }

  async function connect(onEnvelope: (envelope: unknown) => void | Promise<void>, onReady: () => void): Promise<void> {
    await auth(lifetime.signal);
    const value = await request("apps.connections.open", {}, lifetime.signal);
    if (value.ok !== true) return fail("slack_api_rejected");
    const url = validateSlackSocketUrl(value.url);
    if (lifetime.signal.aborted) return fail("slack_request_cancelled");
    let ws: SlackSocket;
    try { ws = socketFactory(url); } catch { return fail("slack_socket_unhealthy"); }
    socket = ws;
    await new Promise<void>((resolve, reject) => {
      let done = false;
      let sawHello = false;
      const timer = setTimeout(() => finish("slack_socket_unhealthy"), helloTimeout);
      const finish = (code?: FaultCode) => {
        if (done) return;
        if(code)observe('transport_protocol_rejected');
        done = true;
        clearTimeout(timer);
        if (socket === ws) { healthy = false; helloAppId = undefined; socket = undefined; }
        lifetime.signal.removeEventListener("abort", onAbort);
        for (const [type, handler] of listeners) ws.removeEventListener(type, handler);
        try { ws.close(1000, "client_closed"); } catch { /* never forward socket diagnostics */ }
        try { ws.terminate?.(); } catch { /* Bun shutdown must not expose ticket URLs */ }
        code ? reject(new SlackTransportError(code)) : resolve();
      };
      const onAbort = () => finish();
      const onMessage = (event: unknown) => {
        if (done || socket !== ws || lifetime.signal.aborted) return;
        try {
          // JSON text only, bounded before parsing; never log raw events/errors.
          const data = record(event) ? event.data : undefined;
          if (typeof data !== "string" || Buffer.byteLength(data, "utf8") > MAX_SOCKET_BYTES) return finish("slack_socket_protocol_rejected");
          const envelope: unknown = JSON.parse(data);
          observe('transport_envelope',slackEnvelopeShape(envelope,APPROVED_SLACK_IDENTITY));
          if (!record(envelope)) return finish("slack_socket_protocol_rejected");
          if (envelope.type === "hello") {
            // Official Socket Mode hello binds the app-level token to its app.
            // https://docs.slack.dev/apis/events-api/using-socket-mode/
            if (sawHello || ws.readyState !== 1 || !record(envelope.connection_info)
                || envelope.connection_info.app_id !== APPROVED_SLACK_IDENTITY.appId) return finish("slack_socket_identity_mismatch");
            sawHello = true;
            helloAppId = envelope.connection_info.app_id;
            healthy = true;
            observe('transport_hello');
            clearTimeout(timer);
            onReady();
            return;
          }
          if (!sawHello) return finish("slack_socket_protocol_rejected");
          if (envelope.type === "disconnect") {
            return finish(envelope.reason === "link_disabled" ? "slack_api_rejected" : undefined);
          }
          if (typeof envelope.envelope_id !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(envelope.envelope_id)
              || typeof envelope.type !== "string" || pendingHandlers >= 32 || ws.readyState !== 1) return finish("slack_socket_protocol_rejected");
          ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
          pendingHandlers++;
          // ACK before calling service code; async failures stay private. The
          // service owns durable deduplication and any user-visible response.
          Promise.resolve().then(() => {
            if (!stopped) return onEnvelope(envelope);
          }).catch(() => undefined).finally(() => { pendingHandlers--; });
        } catch { observe('transport_frame_rejected');finish("slack_socket_protocol_rejected"); }
      };
      const listeners: Array<[string, (event: unknown) => void]> = [
        ["message", onMessage], ["error", () => finish("slack_socket_unhealthy")], ["close", () => finish()],
      ];
      for (const [type, handler] of listeners) ws.addEventListener(type, handler);
      lifetime.signal.addEventListener("abort", onAbort, { once: true });
      if (lifetime.signal.aborted) finish();
    });
  }

  function pause(ms: number): Promise<void> {
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); lifetime.signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, ms);
      lifetime.signal.addEventListener("abort", finish, { once: true });
      if (lifetime.signal.aborted) finish();
    });
  }

  const transport: SlackTransport = {
    async memberInfo(userId, signal) {
      if(userId==='USLACKBOT'||!/^[UW][A-Z0-9]{5,32}$/.test(userId)||!transport.socketHealthy())return fail("slack_response_rejected");
      const value=await request("users.info",{user:userId},signal), user=value.user;
      const fields=["deleted","is_bot","is_app_user","is_restricted","is_ultra_restricted"];
      if(value.ok!==true||!record(user)||user.id!==userId||typeof user.team_id!=="string"
        ||fields.some(key=>typeof user[key]!=="boolean")||(user.is_stranger!==undefined&&typeof user.is_stranger!=="boolean")
        ||["is_external","suspended","is_invited_user","is_profile_only_user"].some(key=>user[key]!==undefined&&user[key]!==false))return fail("slack_response_rejected");
      return Object.freeze({id:userId,teamId:user.team_id,deleted:user.deleted as boolean,isBot:user.is_bot as boolean,isAppUser:user.is_app_user as boolean,
        isRestricted:user.is_restricted as boolean,isUltraRestricted:user.is_ultra_restricted as boolean,isStranger:user.is_stranger===true,observedAt:Date.now()});
    },
    async channelInfo(channelId, signal) {
      if(!/^[CG][A-Z0-9]{5,32}$/.test(channelId)||!transport.socketHealthy())return fail("slack_response_rejected");
      const value=await request("conversations.info",{channel:channelId},signal), channel=value.channel;
      const fields=["is_member","is_archived","is_private","is_shared","is_ext_shared","is_org_shared","is_pending_ext_shared"];
      if(value.ok!==true||!record(channel)||channel.id!==channelId||typeof channel.context_team_id!=="string"
        ||fields.some(key=>typeof channel[key]!=="boolean")||channel.is_im!==false||channel.is_mpim!==false
        ||!(channel.is_channel===true||channel.is_group===true&&channel.is_private===true)
        ||(channel.is_frozen!==undefined&&channel.is_frozen!==false)
        ||(channel.is_ext_ws_shared!==undefined&&channel.is_ext_ws_shared!==false)
        ||(channel.conversation_host_id!==undefined&&channel.conversation_host_id!==APPROVED_SLACK_IDENTITY.teamId)
        ||["shared_team_ids","internal_team_ids","connected_team_ids"].some(key=>channel[key]!==undefined&&(!Array.isArray(channel[key])||(channel[key] as unknown[]).some(team=>team!==APPROVED_SLACK_IDENTITY.teamId)))
        ||["pending_shared","pending_connected_team_ids"].some(key=>channel[key]!==undefined&&(!Array.isArray(channel[key])||(channel[key] as unknown[]).length!==0)))return fail("slack_response_rejected");
      return Object.freeze({id:channelId,teamId:channel.context_team_id,isMember:channel.is_member as boolean,isArchived:channel.is_archived as boolean,
        isPrivate:channel.is_private as boolean,isShared:channel.is_shared as boolean,isExtShared:channel.is_ext_shared as boolean,
        isOrgShared:channel.is_org_shared as boolean,isPendingExtShared:channel.is_pending_ext_shared as boolean,observedAt:Date.now()});
    },
    async identity(signal) {
      if (!transport.socketHealthy() || !helloAppId) return fail("slack_socket_unhealthy");
      const current = socket;
      await auth(signal);
      if (!transport.socketHealthy() || socket !== current || !helloAppId) return fail("slack_socket_unhealthy");
      return Object.freeze({ ...APPROVED_SLACK_IDENTITY, appId: helloAppId });
    },
    socketHealthy: () => !stopped && healthy && socket?.readyState === 1,
    async sendMessage(message, signal) {
      // The approved readiness DM uses chat.postMessage's user target form;
      // Slack returns its D-channel ID. No conversations.open scope is needed.
      const readinessDm = message?.channel === "U0A9M5W16F8";
      if (!message || typeof message.channel !== "string" || (!readinessDm && !/^[CGD][A-Z0-9]{2,63}$/.test(message.channel)) || typeof message.text !== "string"
          || !message.text.trim() || Buffer.byteLength(message.text, "utf8") > 16_000
          || (readinessDm && message.threadTs !== undefined)
          || (message.threadTs !== undefined && (typeof message.threadTs !== "string" || !/^\d{1,20}\.\d{1,10}$/.test(message.threadTs)))) {
        return { ok: false, outcome: "definitely_not_sent", code: "slack_message_rejected" };
      }
      if (stopped || signal?.aborted) return { ok: false, outcome: "definitely_not_sent", code: "slack_request_cancelled" };
      if (!transport.socketHealthy()) return { ok: false, outcome: "definitely_not_sent", code: "slack_socket_unhealthy" };
      try {
        const value = await request("chat.postMessage", {
          channel: message.channel, text: message.text, ...(message.threadTs === undefined ? {} : { thread_ts: message.threadTs }),
          unfurl_links: false, unfurl_media: false,
        }, signal);
        const channelConfirmed = typeof value.channel === "string" && (readinessDm
          ? /^D[A-Z0-9]{5,32}$/.test(value.channel) : value.channel === message.channel);
        if (value.ok === true && channelConfirmed && typeof value.channel === "string" && typeof value.ts === "string" && /^\d{1,20}\.\d{1,10}$/.test(value.ts)) {
          return { ok: true, channel: value.channel, ts: value.ts };
        }
        return { ok: false, outcome: value.ok === false && typeof value.error === "string" && definiteRejections.has(value.error)
          ? "definitely_not_sent" : "unknown", code: "slack_message_not_confirmed" };
      } catch (error) {
        return { ok: false, outcome: error instanceof SlackTransportError && error.code === "slack_rate_limited" ? "definitely_not_sent" : "unknown",
          code: error instanceof SlackTransportError ? error.code : "slack_network_failure" };
      }
    },
    async start(onEnvelope, signal) {
      if (stopped || signal?.aborted) return fail("slack_transport_stopped");
      if (started) return fail("slack_transport_already_started");
      if (typeof onEnvelope !== "function") return fail("slack_configuration_rejected");
      started = true;
      const abort = () => { void transport.stop(); };
      signal?.addEventListener("abort", abort, { once: true });
      unlinkStartSignal = () => signal?.removeEventListener("abort", abort);
      let ready = false;
      let resolveReady: () => void = () => undefined;
      let rejectReady: (error: SlackTransportError) => void = () => undefined;
      const readiness = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      runner = (async () => {
        let last: FaultCode = "slack_reconnect_exhausted";
        let failures = 0;
        while (!lifetime.signal.aborted) {
          let verifiedSession = false;
          try { await connect(onEnvelope, () => {
            verifiedSession = true;
            failures = 0;
            ready = true;
            resolveReady();
          }); }
          catch (error) {
            last = error instanceof SlackTransportError ? error.code : "slack_socket_unhealthy";
            if (["slack_identity_mismatch", "slack_socket_identity_mismatch", "slack_socket_url_rejected", "slack_api_rejected"].includes(last)) break;
          }
          // Slack periodically refreshes successful sessions. Only attempts
          // which fail before a verified hello consume the reconnect budget.
          if (!verifiedSession && ++failures > maxReconnect) break;
          if (!lifetime.signal.aborted) await pause(Math.min(10_000, backoff * 2 ** Math.max(0, failures - 1)));
        }
        healthy = false;
        helloAppId = undefined;
        unlinkStartSignal?.();
        if (!ready) rejectReady(new SlackTransportError(lifetime.signal.aborted ? "slack_request_cancelled" : last));
      })();
      return readiness;
    },
    async stop() {
      stopped = true;
      healthy = false;
      helloAppId = undefined;
      lifetime.abort();
      for (const controller of requests) controller.abort();
      unlinkStartSignal?.();
      await runner;
    },
  };
  return Object.freeze(transport);
}
