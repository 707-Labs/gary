import { afterEach, describe, expect, test } from "bun:test";
import { APPROVED_SLACK_IDENTITY, createSlackTransport, validateSlackSocketUrl,
  type SlackFetch, type SlackSocket, type SlackTransport, type SlackTransportOptions } from "../../src/slack/transport.ts";

const credentials = Object.freeze({ botToken: "xoxb-offline-fixture-not-a-real-token", appToken: "xapp-offline-fixture-not-a-real-token" });
const socketUrl = "wss://wss-primary.slack.com/link/?ticket=offline-fixture-ticket";
const hello = { type: "hello", connection_info: { app_id: APPROVED_SLACK_IDENTITY.appId } };
const auth = { ok: true, team_id: APPROVED_SLACK_IDENTITY.teamId, user_id: APPROVED_SLACK_IDENTITY.botUserId, bot_id: "BFAKE123" };
const envelope = { type: "events_api", envelope_id: "fake-envelope-id", payload: { type: "event_callback", event_id: "EvFAKE" } };
const message = { channel: "CFAKE123", text: "Offline transport fixture", threadTs: "123.456" };
const memberMetadata={id:'U0MEMBER11',team_id:APPROVED_SLACK_IDENTITY.teamId,deleted:false,is_bot:false,is_app_user:false,is_restricted:false,is_ultra_restricted:false,profile:{email:'private@example.invalid',real_name:'Do not retain'}};
const channelMetadata={id:'C0CHANNEL1',context_team_id:APPROVED_SLACK_IDENTITY.teamId,is_channel:true,is_group:false,is_private:false,is_im:false,is_mpim:false,
  is_member:true,is_archived:false,is_shared:false,is_ext_shared:false,is_org_shared:false,is_pending_ext_shared:false,shared_team_ids:[APPROVED_SLACK_IDENTITY.teamId],pending_shared:[],pending_connected_team_ids:[]};
class FakeSocket implements SlackSocket {
  readyState = 1;
  sent: string[] = [];
  closes = 0;
  terminations = 0;
  sendFailure = false;
  listeners = new Map<string, Set<(event: unknown) => void>>();
  addEventListener(type: string, listener: (event: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (event: unknown) => void) { this.listeners.get(type)?.delete(listener); }
  send(data: string) { if (this.sendFailure) throw new Error(credentials.appToken); this.sent.push(data); }
  close() { this.closes++; this.readyState = 3; }
  terminate() { this.terminations++; this.readyState = 3; }
  emit(type: string, event: unknown) { for (const listener of [...this.listeners.get(type) ?? []]) listener(event); }
  frame(value: unknown) { this.emit("message", { data: JSON.stringify(value) }); }
  listenerCount() { return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0); }
}
const transports: SlackTransport[] = [];
afterEach(async () => { await Promise.all(transports.splice(0).map(transport => transport.stop())); });
const tick = () => new Promise(resolve => setTimeout(resolve, 1));
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await tick();
  expect(check()).toBe(true);
}
function harness(options: Partial<SlackTransportOptions> = {}, authReply: unknown = auth) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  let post: SlackFetch = async () => Response.json({ ok: true, channel: message.channel, ts: "124.456" });
  const fetch: SlackFetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("auth.test")) return Response.json(authReply);
    if (url.endsWith("apps.connections.open")) return Response.json({ ok: true, url: socketUrl });
    if (url.endsWith("chat.postMessage")) return post(url, init);
    throw new Error("unexpected fake HTTP method");
  };
  const transport = createSlackTransport({ credentials, fetch, createSocket(url) {
    urls.push(url); const socket = new FakeSocket(); sockets.push(socket); return socket;
  }, httpTimeoutMs: 100, helloTimeoutMs: 100, reconnectBaseMs: 1, maxReconnectAttempts: 0, ...options });
  transports.push(transport);
  return { transport, calls, sockets, urls, setPost(value: SlackFetch) { post = value; }, async start(handler = (_envelope: unknown): void | Promise<void> => undefined) {
    const started = transport.start(handler);
    await until(() => sockets.length === 1);
    sockets[0]!.frame(hello);
    await started;
    return sockets[0]!;
  } };
}

describe("Slack transport, fake fetch and WebSocket only", () => {
  test('shared metadata uses only exact bot-authenticated info routes, rejects foreign/pending facts, and discards profile text',async()=>{
    const calls:Array<{url:string;body:any;headers:Headers}>=[];let user:any={...memberMetadata},channel:any={...channelMetadata};
    const h=harness({fetch:async(url,init)=>{calls.push({url,body:JSON.parse(String(init.body)),headers:new Headers(init.headers)});
      if(url.endsWith('auth.test'))return Response.json(auth);if(url.endsWith('apps.connections.open'))return Response.json({ok:true,url:socketUrl});
      if(url.endsWith('users.info'))return Response.json({ok:true,user});if(url.endsWith('conversations.info'))return Response.json({ok:true,channel});throw new Error('forbidden route');}});
    await h.start();const member=await h.transport.memberInfo!('U0MEMBER11'),facts=await h.transport.channelInfo!('C0CHANNEL1');
    expect(member).toMatchObject({id:'U0MEMBER11',teamId:APPROVED_SLACK_IDENTITY.teamId,isRestricted:false,isStranger:false});expect(facts).toMatchObject({isMember:true,isShared:false});
    expect(JSON.stringify(member)).not.toContain('private@example');expect(JSON.stringify(member)).not.toContain('Do not retain');
    for(const call of calls.filter(call=>call.url.endsWith('.info')))expect(call.headers.get('authorization')).toBe('Bearer '+credentials.botToken);
    expect(calls.filter(call=>call.url.endsWith('.info')).map(call=>call.body)).toEqual([{user:'U0MEMBER11'},{channel:'C0CHANNEL1'}]);
    for(const bad of [{id:'C0FOREIGN'},{context_team_id:undefined},{is_member:undefined},{is_im:true},{connected_team_ids:['TFOREIGN']},{shared_team_ids:['TFOREIGN']},{pending_connected_team_ids:[APPROVED_SLACK_IDENTITY.teamId]},{pending_shared:['TFOREIGN']},{is_ext_ws_shared:true},{is_ext_ws_shared:'false'},{conversation_host_id:'TFOREIGN'}]){
      channel={...channelMetadata,...bad};await expect(h.transport.channelInfo!('C0CHANNEL1')).rejects.toThrow('slack_response_rejected');
    }
    for(const bad of [{id:'U0FOREIGN'},{team_id:undefined},{is_restricted:undefined},{is_stranger:'false'},{is_external:true},{suspended:true},{is_invited_user:true},{is_profile_only_user:true},{is_external:'false'},{suspended:null}]){
      user={...memberMetadata,...bad};await expect(h.transport.memberInfo!('U0MEMBER11')).rejects.toThrow('slack_response_rejected');
    }
    await expect(h.transport.memberInfo!('USLACKBOT')).rejects.toThrow('slack_response_rejected');
    expect(calls.every(call=>!call.url.includes('history')&&!call.url.includes('replies')&&!call.url.includes('list'))).toBe(true);
  });
  test("construction is inert; authenticated bot and socket hello bind identity without extra scopes", async () => {
    const h = harness(); expect(h.calls).toEqual([]); expect(h.sockets).toEqual([]);
    await expect(h.transport.identity()).rejects.toThrow("slack_socket_unhealthy");
    expect(await h.transport.sendMessage(message)).toEqual({ ok: false, outcome: "definitely_not_sent", code: "slack_socket_unhealthy" });
    await h.start();
    expect(await h.transport.identity()).toEqual(APPROVED_SLACK_IDENTITY);
    expect(h.transport.socketHealthy()).toBe(true);
    expect(h.urls).toEqual([socketUrl]);
    expect(h.calls.map(call => call.url)).toEqual([
      "https://slack.com/api/auth.test", "https://slack.com/api/apps.connections.open", "https://slack.com/api/auth.test",
    ]);
    for (const call of h.calls) {
      expect(call.init.redirect).toBe("error"); expect(call.init.method).toBe("POST");
      expect(call.init.credentials).toBe("omit"); expect(call.init.signal).toBeInstanceOf(AbortSignal);
      const token = call.url.endsWith("apps.connections.open") ? credentials.appToken : credentials.botToken;
      expect(new Headers(call.init.headers).get("authorization")).toBe(`Bearer ${token}`);
      expect(call.url).not.toContain(token); expect(call.init.body).not.toContain(token);
    }
  });
  test.each([{ ...auth, team_id: "TOTHER" }, { ...auth, user_id: "UOTHER" }, { ...auth, bot_id: undefined }, { ok: false }])(
    "rejects bot identity before requesting a socket %#", async value => {
      const h = harness({}, value);
      await expect(h.transport.start(() => undefined)).rejects.toThrow();
      expect(h.calls).toHaveLength(1); expect(h.sockets).toEqual([]);
    });
  test.each([{ type: "hello" }, { type: "hello", connection_info: { app_id: "AOTHER" } }, envelope])(
    "rejects absent/mismatched app hello or an event preceding hello %#", async value => {
      const h = harness(); const started = h.transport.start(() => undefined);
      const rejected = started.catch(error => error);
      await until(() => h.sockets.length === 1); h.sockets[0]!.frame(value);
      expect(await rejected).toBeInstanceOf(Error);
      expect(h.transport.socketHealthy()).toBe(false); expect(h.sockets[0]!.listenerCount()).toBe(0);
    });
  test("ACK precedes untrusted delivery; service error does not leak, retry or duplicate ACK", async () => {
    const h = harness(); const received: unknown[] = [];
    const socket = await h.start(value => {
      expect(socket.sent).toEqual([JSON.stringify({ envelope_id: envelope.envelope_id })]);
      received.push(value); throw new Error(credentials.botToken);
    });
    socket.frame(envelope); await tick();
    expect(received).toEqual([envelope]); expect(socket.sent).toHaveLength(1); expect(h.transport.socketHealthy()).toBe(true);
    socket.sendFailure = true; socket.frame({ ...envelope, envelope_id: "failed-ack" }); await tick();
    expect(received).toHaveLength(1); expect(h.transport.socketHealthy()).toBe(false);
  });
  test.each(["not json", "[]", JSON.stringify({ ...envelope, envelope_id: "unsafe\n" }), "x".repeat(262_145)])(
    "malformed/oversized frame closes the socket without delivery %#", async data => {
      const h = harness(); let received = 0; const socket = await h.start(() => { received++; });
      socket.emit("message", { data }); await tick();
      expect(received).toBe(0); expect(socket.sent).toEqual([]); expect(socket.listenerCount()).toBe(0);
      expect(h.transport.socketHealthy()).toBe(false);
    });
  test("posts only explicit bounded fields to Slack once and verifies channel/ts", async () => {
    const h = harness(); await h.start();
    expect(await h.transport.sendMessage({ ...message, token: "ignored", response_url: "https://elsewhere.invalid" } as typeof message)).toEqual({ ok: true, channel: message.channel, ts: "124.456" });
    const posted = h.calls.filter(call => call.url.endsWith("chat.postMessage")); expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0]!.init.body as string)).toEqual({ channel: message.channel, text: message.text,
      thread_ts: message.threadTs, unfurl_links: false, unfurl_media: false });
  });
  test("approved Tanner readiness DM accepts user target and confirmed direct-channel receipt only", async () => {
    const h = harness(); await h.start();
    const dm = { channel: "U0A9M5W16F8", text: "Offline readiness fixture" };
    h.setPost(async () => Response.json({ ok: true, channel: "DFAKE123", ts: "1759900000.123456" }));
    expect(await h.transport.sendMessage(dm)).toEqual({ ok: true, channel: "DFAKE123", ts: "1759900000.123456" });
    const sent = h.calls.filter(call => call.url.endsWith("chat.postMessage"));
    expect(sent).toHaveLength(1); expect(JSON.parse(sent[0]!.init.body as string).channel).toBe(dm.channel);
    for (const channel of ["CFAKE123", "U0A9M5W16F8", "D"]) {
      h.setPost(async () => Response.json({ ok: true, channel, ts: "1759900000.123456" }));
      expect(await h.transport.sendMessage(dm)).toEqual({ ok: false, outcome: "unknown", code: "slack_message_not_confirmed" });
    }
    const count = h.calls.length;
    for (const invalid of [{ ...dm, channel: "UOTHER123" }, { ...dm, channel: "U0A97PBGXE3" }, { ...dm, threadTs: "123.456" }]) {
      expect(await h.transport.sendMessage(invalid)).toEqual({ ok: false, outcome: "definitely_not_sent", code: "slack_message_rejected" });
    }
    expect(h.calls).toHaveLength(count);
    expect(h.calls.some(call => call.url.endsWith("conversations.open"))).toBe(false);
  });
  test.each(["invalid_auth", "not_in_channel", "channel_not_found", "missing_scope", "ratelimited"])(
    "definite Slack rejection %s does not retry or return upstream errors", async error => {
      const h = harness(); await h.start(); h.setPost(async () => Response.json({ ok: false, error, detail: credentials.botToken }));
      const result = await h.transport.sendMessage(message);
      expect(result).toEqual({ ok: false, outcome: "definitely_not_sent", code: "slack_message_not_confirmed" });
      expect(h.calls.filter(call => call.url.endsWith("chat.postMessage"))).toHaveLength(1);
    });
  test.each([
    { ok: false, error: "internal_error" }, { ok: false, error: credentials.botToken },
    { ok: true, channel: "COTHER", ts: "124.456" }, { ok: true, channel: message.channel, ts: "invalid" },
  ])("ambiguous response %# is unknown, never retried and never echoes data", async value => {
    const h = harness(); await h.start(); h.setPost(async () => Response.json(value));
    expect(await h.transport.sendMessage(message)).toEqual({ ok: false, outcome: "unknown", code: "slack_message_not_confirmed" });
    expect(h.calls.filter(call => call.url.endsWith("chat.postMessage"))).toHaveLength(1);
  });
  test("network errors, redirects, huge or malformed responses remain unknown without leaking errors", async () => {
    const h = harness(); await h.start();
    const cases: SlackFetch[] = [
      async () => { throw new Error(credentials.botToken); },
      async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.invalid" } }),
      async () => new Response("invalid json"),
      async () => new Response("x".repeat(65_537)),
      async () => new Response("{}", { headers: { "content-length": "9999999" } }),
    ];
    for (const fake of cases) {
      h.setPost(fake); const result = await h.transport.sendMessage(message);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.outcome).toBe("unknown");
      expect(JSON.stringify(result)).not.toContain(credentials.botToken);
    }
    expect(h.calls.filter(call => call.url.endsWith("chat.postMessage"))).toHaveLength(cases.length);
    h.setPost(async () => new Response(null, { status: 429 }));
    expect(await h.transport.sendMessage(message)).toEqual({ ok: false, outcome: "definitely_not_sent", code: "slack_rate_limited" });
  });
  test("HTTP and streamed-body timeouts are bounded even when a fake ignores abort", async () => {
    const h = harness({ httpTimeoutMs: 15 }); await h.start();
    h.setPost(() => new Promise(() => undefined));
    expect(await h.transport.sendMessage(message)).toEqual({ ok: false, outcome: "unknown", code: "slack_request_timeout" });
    let cancelled = false;
    h.setPost(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    expect(await h.transport.sendMessage(message)).toEqual({ ok: false, outcome: "unknown", code: "slack_request_timeout" });
    await tick(); expect(cancelled).toBe(true);
  });
  test("stop cancels active sends and detaches socket listeners; late frames cannot invoke service", async () => {
    const h = harness(); let handled = 0; const socket = await h.start(() => { handled++; });
    let requestSignal: AbortSignal | undefined;
    h.setPost((_url, init) => { requestSignal = init.signal as AbortSignal; return new Promise(() => undefined); });
    const pending = h.transport.sendMessage(message); await until(() => !!requestSignal);
    await h.transport.stop();
    expect((await pending).ok).toBe(false); expect(requestSignal?.aborted).toBe(true);
    expect(socket.listenerCount()).toBe(0); expect(socket.closes).toBe(1);
    expect(socket.terminations).toBe(1);
    socket.frame(envelope); await tick(); expect(handled).toBe(0);
    const count = h.calls.length;
    expect((await h.transport.sendMessage(message)).ok).toBe(false); expect(h.calls).toHaveLength(count);
  });
  test("caller cancellation before send is definite, cancellation during send is unknown", async () => {
    const h = harness(); await h.start(); const signal = new AbortController(); signal.abort();
    expect(await h.transport.sendMessage(message, signal.signal)).toEqual({ ok: false, outcome: "definitely_not_sent", code: "slack_request_cancelled" });
    const during = new AbortController(); h.setPost(() => new Promise(() => undefined));
    const pending = h.transport.sendMessage(message, during.signal); during.abort();
    expect(await pending).toEqual({ ok: false, outcome: "unknown", code: "slack_request_cancelled" });
  });
  test("a missing hello times out, and reconnect attempts stop at the configured bound", async () => {
    const h = harness({ helloTimeoutMs: 5, maxReconnectAttempts: 2 });
    await expect(h.transport.start(() => undefined)).rejects.toThrow("slack_socket_unhealthy");
    expect(h.sockets).toHaveLength(3);
    expect(h.sockets.every(socket => socket.closes === 1 && socket.listenerCount() === 0)).toBe(true);
  });
  test("refresh reconnects to a new URL/session; stop cancels backoff immediately", async () => {
    const h = harness({ maxReconnectAttempts: 2 }); const first = await h.start();
    first.frame({ type: "disconnect", reason: "refresh_requested" });
    await until(() => h.sockets.length === 2); expect(h.transport.socketHealthy()).toBe(false);
    const second = h.sockets[1]!; second.frame(hello); expect(h.transport.socketHealthy()).toBe(true);
    expect(first.listenerCount()).toBe(0); await h.transport.stop(); expect(second.listenerCount()).toBe(0);
    const calls = h.calls.length; await tick(); expect(h.calls).toHaveLength(calls);
  });
  test("successful Slack refreshes can exceed the failed-connect budget indefinitely", async () => {
    const h = harness({ maxReconnectAttempts: 1 }); let socket = await h.start();
    for (let round = 0; round < 6; round++) {
      socket.frame({ type: "disconnect", reason: "refresh_requested" });
      await until(() => h.sockets.length === round + 2);
      expect(socket.listenerCount()).toBe(0); expect(socket.terminations).toBe(1);
      socket = h.sockets[round + 1]!; socket.frame(hello);
      expect(h.transport.socketHealthy()).toBe(true);
    }
    expect(h.sockets).toHaveLength(7);
    expect(await h.transport.identity()).toEqual(APPROVED_SLACK_IDENTITY);
  });
  test("verified hello resets failed-connect count, but subsequent consecutive failures still stop", async () => {
    const h = harness({ maxReconnectAttempts: 1 });
    const started = h.transport.start(() => undefined);
    await until(() => h.sockets.length === 1);
    h.sockets[0]!.emit("error", {});
    await until(() => h.sockets.length === 2);
    h.sockets[1]!.frame(hello); await started;
    h.sockets[1]!.frame({ type: "disconnect", reason: "refresh_requested" });
    await until(() => h.sockets.length === 3);
    h.sockets[2]!.emit("error", {});
    await until(() => h.sockets.length === 4);
    h.sockets[3]!.emit("error", {});
    await tick(); await tick();
    expect(h.sockets).toHaveLength(4); expect(h.transport.socketHealthy()).toBe(false);
    expect(h.sockets.every(socket => socket.listenerCount() === 0 && socket.terminations === 1)).toBe(true);
  });
  test("cancels initial startup without waiting for timeout", async () => {
    const controller = new AbortController(); const h = harness({ helloTimeoutMs: 1000 });
    const started = h.transport.start(() => undefined, controller.signal);
    const rejected = started.catch(error => error);
    await until(() => h.sockets.length === 1); controller.abort();
    expect(String(await rejected)).toContain("slack_request_cancelled");
    expect(h.sockets[0]!.listenerCount()).toBe(0); expect(h.transport.socketHealthy()).toBe(false);
  });
  test("disconnect disabled and repeated hello stop rather than redeliver or reconnect", async () => {
    for (const frame of [{ type: "disconnect", reason: "link_disabled" }, hello]) {
      const h = harness({ maxReconnectAttempts: 2 }); const socket = await h.start();
      socket.frame(frame); await tick(); await tick();
      expect(h.sockets).toHaveLength(1); expect(h.transport.socketHealthy()).toBe(false);
      expect(socket.listenerCount()).toBe(0);
    }
  });
  test("stop forcibly terminates a socket whose graceful close remains pending", async () => {
    const h = harness(); const socket = await h.start();
    socket.close = () => { socket.closes++; socket.readyState = 2; };
    await h.transport.stop();
    expect(socket.terminations).toBe(1); expect(socket.readyState).toBe(3);
    expect(socket.listenerCount()).toBe(0);
  });
  test("pending handlers are bounded and overflow is not ACKed", async () => {
    const h = harness(); const releases: Array<() => void> = [];
    const socket = await h.start(() => new Promise<void>(resolve => releases.push(resolve)));
    for (let i = 0; i < 33; i++) socket.frame({ ...envelope, envelope_id: `bounded-${i}` });
    await tick(); expect(socket.sent).toHaveLength(32); expect(releases).toHaveLength(32);
    expect(h.transport.socketHealthy()).toBe(false); expect(socket.listenerCount()).toBe(0);
    for (const release of releases) release();
  });
  test("binary frames are rejected; invalid message fields never issue an HTTP call", async () => {
    const h = harness(); const socket = await h.start();
    const count = h.calls.length;
    for (const input of [{ ...message, channel: "bad/channel" }, { ...message, text: " " },
      { ...message, text: "x".repeat(16_001) }, { ...message, threadTs: "bad" }]) {
      const result = await h.transport.sendMessage(input);
      expect(result).toEqual({ ok: false, outcome: "definitely_not_sent", code: "slack_message_rejected" });
    }
    expect(h.calls).toHaveLength(count);
    socket.emit("message", { data: new Uint8Array([123, 125]) });
    expect(h.transport.socketHealthy()).toBe(false); expect(socket.sent).toEqual([]);
  });
  test("a server-issued non-Slack URL is rejected before socket construction", async () => {
    const calls: string[] = []; let constructed = false;
    const h = harness({ fetch: async url => {
      calls.push(url);
      return Response.json(url.endsWith("auth.test") ? auth : { ok: true, url: "wss://elsewhere.invalid/link/?ticket=fake" });
    }, createSocket() { constructed = true; return new FakeSocket(); } });
    await expect(h.transport.start(() => undefined)).rejects.toThrow("slack_socket_url_rejected");
    expect(calls).toHaveLength(2); expect(constructed).toBe(false);
  });
  test.each(["ws://wss.slack.com/link/?ticket=fake", "wss://attacker.invalid/link/?ticket=fake",
    "wss://wss.slack.com.attacker.invalid/link/?ticket=fake", "wss://wss.slack.com:444/link/?ticket=fake",
    "wss://user:pass@wss.slack.com/link/?ticket=fake", "wss://wss.slack.com/elsewhere?ticket=fake",
    "wss://wss.slack.com/link/", "wss://wss.slack.com/link/?ticket=a&ticket=b", `${socketUrl}#fragment`, `${socketUrl}\n`])(
    "rejects endpoint outside fixed authenticated Slack socket shape %#", value => {
      expect(() => validateSlackSocketUrl(value)).toThrow("slack_socket_url_rejected");
    });
  test.each(["wss", "wss-primary", "wss-backup", "wss-111"])("accepts Slack-controlled %s socket hosts", host => {
    expect(validateSlackSocketUrl(`wss://${host}.slack.com/link/?ticket=fake`)).toBe(`wss://${host}.slack.com/link/?ticket=fake`);
  });
});
