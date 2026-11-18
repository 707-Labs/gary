/** Host-only public GET transport. No ambient proxies, cookies, credentials or
 * model-supplied headers. Importing performs no network or filesystem work. */
import { createHash } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
export interface EngineeringNetworkBinding {
    readonly taskId: string;
    readonly scopeKey: string;
    readonly deadlineMs: number;
}
export interface EngineeringNetworkReference {
    readonly purpose: 'documentation' | 'dependency';
    readonly url: string;
    readonly provenanceSha256: string;
    readonly integrity?: string;
}
export interface EngineeringNetworkRequest {
    readonly url: string;
    readonly purpose: 'documentation' | 'dependency';
}
export interface EngineeringNetworkReceipt {
    readonly taskId: string;
    readonly scopeKey: string;
    readonly purpose: string;
    readonly url: string;
    readonly finalUrl: string;
    readonly provenanceSha256: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly integrity: string | null;
    readonly redirects: number;
    readonly contentType: string;
}
export interface EngineeringDownloadedResource {
    readonly receipt: EngineeringNetworkReceipt;
    bytes(): Uint8Array;
}
export interface EngineeringNetworkHop {
    readonly url: string;
    readonly hostname: string;
    readonly address: string;
    readonly family: 4 | 6;
    readonly maxBytes: number;
    readonly signal: AbortSignal;
}
export interface EngineeringNetworkResponse {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly bytes: Uint8Array;
}
export const ENGINEERING_NETWORK_LIMITS = Object.freeze({ documentationBytes: 2 * 1024 * 1024, dependencyBytes: 64 * 1024 * 1024,
    taskBytes: 512 * 1024 * 1024, taskRequests: 4096, redirects: 3, transferMs: 30000 });
const SHA = /^[a-f0-9]{64}$/;
const minted = new WeakSet<object>();
export interface EngineeringNetworkQuota {
    readonly binding: EngineeringNetworkBinding;
}
const quotas = new WeakMap<object, {
    count: number;
    total: number;
    busy: boolean;
}>();
/** One host-owned quota per task, shared by documents and all dependency stages. */
export function createEngineeringNetworkQuota(binding: EngineeringNetworkBinding): EngineeringNetworkQuota {
    if (!exact(binding, ['taskId', 'scopeKey', 'deadlineMs']) || !/^[A-Za-z0-9_.:-]{1,160}$/.test(binding.taskId)
        || !/^[A-Za-z0-9_.:-]{1,256}$/.test(binding.scopeKey) || !Number.isSafeInteger(binding.deadlineMs))
        fail('binding');
    const value = Object.freeze({ binding: Object.freeze({ ...binding }) });
    quotas.set(value, { count: 0, total: 0, busy: false });
    return value;
}
function fail(code: string): never { throw Error('engineering_network:' + code); }
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function exact(value: unknown, keys: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
        return false;
    const d = Object.getOwnPropertyDescriptors(value);
    return Reflect.ownKeys(d).every(k => typeof k === 'string' && [...keys, ...optional].includes(k) && Object.hasOwn(d[k]!, 'value'))
        && keys.every(k => Object.hasOwn(d, k));
}
function publicV4(address: string): boolean {
    if (isIP(address) !== 4)
        return false;
    const [a, b, c] = address.split('.').map(Number) as [
        number,
        number,
        number,
        number
    ];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127
        || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99)
        || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
}
/** Deliberately excludes transition, mapped, local, documentation and special
 * IPv6 space. A non-global DNS answer rejects the whole resolution. */
export function isEngineeringPublicAddress(address: string): boolean {
    if (isIP(address) === 4)
        return publicV4(address);
    if (isIP(address) !== 6 || address.includes('%') || address.includes('.'))
        return false;
    const halves = address.toLowerCase().split('::');
    const left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : [];
    const parts = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
    const first = parseInt(parts[0]!, 16), second = parseInt(parts[1]!, 16);
    return parts.length === 8 && first >= 0x2000 && first <= 0x3fff
        && !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) && first !== 0x2002
        && first !== 0x3ffe && !(first === 0x3fff && second < 0x1000);
}
export function engineeringPublicHttpsUrl(raw: string): URL {
    if (typeof raw !== 'string' || raw.length > 2048 || /[\x00-\x20\x7f\\]/.test(raw))
        fail('url');
    let url: URL;
    try {
        url = new URL(raw);
    }
    catch {
        return fail('url');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port
        || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname)
        || isIP(url.hostname) || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local')
        || url.hostname.endsWith('.internal') || url.hostname.endsWith('.test') || url.hostname.endsWith('.invalid')
        || /%(?:00|0a|0d|2f|5c)/i.test(url.pathname))
        fail('url');
    return url;
}
export function validateEngineeringIntegrity(integrity: string): {
    algorithm: 'sha512' | 'sha256';
    base64: string;
} {
    if (typeof integrity !== 'string')
        fail('integrity');
    const match = /^(sha512|sha256)-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
    if (!match)
        fail('integrity');
    const bytes = Buffer.from(match[2]!, 'base64');
    if (bytes.toString('base64') !== match[2] || bytes.length !== (match[1] === 'sha512' ? 64 : 32))
        fail('integrity');
    return { algorithm: match[1] as 'sha512' | 'sha256', base64: match[2]! };
}
export function verifyEngineeringIntegrity(bytes: Uint8Array, integrity: string): void {
    const sri = validateEngineeringIntegrity(integrity);
    if (createHash(sri.algorithm).update(bytes).digest('base64') !== sri.base64)
        fail('integrity_mismatch');
}
export function assertEngineeringDownloadedResource(value: EngineeringDownloadedResource): void {
    if (!value || !minted.has(value) || digest(value.bytes()) !== value.receipt.sha256)
        fail('resource_provenance');
}
async function resolvePublic(hostname: string, signal: AbortSignal): Promise<readonly string[]> {
    const resolver = new Resolver({ timeout: 5000, tries: 1 });
    const cancel = () => resolver.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    try {
        signal.throwIfAborted();
        const results = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
        signal.throwIfAborted();
        return results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
    }
    finally {
        signal.removeEventListener('abort', cancel);
        resolver.cancel();
    }
}
/** Numeric-address TLS connect prevents DNS rebinding between check and dial.
 * Certificate verification and SNI still use the original approved hostname. */
export function engineeringPublicHttpsTransport(hop: EngineeringNetworkHop): Promise<EngineeringNetworkResponse> {
    return new Promise((resolve, reject) => {
        const url = engineeringPublicHttpsUrl(hop.url);
        if (url.hostname !== hop.hostname || isIP(hop.address) !== hop.family || !isEngineeringPublicAddress(hop.address))
            return reject(Error('engineering_network:address'));
        const req = httpsRequest({ hostname: hop.address, family: hop.family, port: 443, servername: hop.hostname,
            method: 'GET', path: url.pathname, agent: false, rejectUnauthorized: true, signal: hop.signal,
            checkServerIdentity: (_name, cert) => checkServerIdentity(hop.hostname, cert),
            headers: { Host: hop.hostname, Accept: '*/*', 'Accept-Encoding': 'identity', 'User-Agent': 'Gary-Public-Broker/1' } }, response => {
            const chunks: Buffer[] = [];
            let size = 0;
            const headers: Record<string, string> = {};
            for (const name of ['location', 'content-length', 'content-type', 'content-encoding']) {
                const value = response.headers[name];
                if (typeof value === 'string')
                    headers[name] = value;
            }
            const length = headers['content-length'];
            if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > hop.maxBytes)) {
                req.destroy(Error('engineering_network:byte_limit'));
                return;
            }
            if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') {
                req.destroy(Error('engineering_network:encoding'));
                return;
            }
            response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > hop.maxBytes)
                req.destroy(Error('engineering_network:byte_limit'));
            else
                chunks.push(chunk); });
            response.once('error', reject);
            response.once('end', () => resolve({ status: response.statusCode ?? 0, headers, bytes: Buffer.concat(chunks) }));
        });
        req.once('error', reject);
        req.end();
    });
}
export function createEngineeringNetworkBroker(options: {
    binding: EngineeringNetworkBinding;
    assertCurrent(): void;
    quota?: EngineeringNetworkQuota;
    /** Host-observed public references only. Never fill this from model tool JSON.
     * Fixed package-plan URLs or explicit user/public-document references qualify. */
    references: readonly EngineeringNetworkReference[];
    /** Exact origins, including any independently admitted CDN redirect origins. */
    allowedOrigins: readonly string[];
    resolve?: (hostname: string, signal: AbortSignal) => Promise<readonly string[]>;
    transport?: (hop: EngineeringNetworkHop) => Promise<EngineeringNetworkResponse>;
    now?: () => number;
}) {
    const now = options.now ?? Date.now, binding = Object.freeze({ ...options.binding });
    if (!exact(binding, ['taskId', 'scopeKey', 'deadlineMs']) || !/^[A-Za-z0-9_.:-]{1,160}$/.test(binding.taskId)
        || !/^[A-Za-z0-9_.:-]{1,256}$/.test(binding.scopeKey) || !Number.isSafeInteger(binding.deadlineMs) || binding.deadlineMs <= now())
        fail('binding');
    const origins = new Set(options.allowedOrigins.map(raw => { const u = engineeringPublicHttpsUrl(raw); if (u.origin !== raw || u.pathname !== '/')
        fail('origin'); return raw; }));
    if (!origins.size || origins.size > 32 || options.references.length > ENGINEERING_NETWORK_LIMITS.taskRequests)
        fail('references');
    const references = new Map<string, Readonly<EngineeringNetworkReference>>();
    for (const ref of options.references) {
        if (!exact(ref, ['url', 'purpose', 'provenanceSha256'], ['integrity']) || !SHA.test(ref.provenanceSha256)
            || !['documentation', 'dependency'].includes(ref.purpose))
            fail('reference');
        const url = engineeringPublicHttpsUrl(ref.url).href;
        if (!origins.has(new URL(url).origin) || references.has(url))
            fail('reference');
        if (ref.purpose === 'dependency' && !ref.integrity)
            fail('integrity');
        if (ref.integrity !== undefined)
            validateEngineeringIntegrity(ref.integrity);
        references.set(url, Object.freeze({ ...ref, url }));
    }
    const requests = new WeakMap<object, {
        reference: Readonly<EngineeringNetworkReference>;
        consumed: boolean;
    }>();
    const quota = options.quota ?? createEngineeringNetworkQuota(binding), state = quotas.get(quota);
    if (!state || quota.binding.taskId !== binding.taskId || quota.binding.scopeKey !== binding.scopeKey || quota.binding.deadlineMs !== binding.deadlineMs)
        fail('quota_binding');
    function guard() { const result: unknown = options.assertCurrent(); if (result !== undefined) {
        void Promise.resolve(result).catch(() => { });
        fail('asynchronous_guard');
    } if (now() >= binding.deadlineMs)
        fail('deadline'); }
    return Object.freeze({
        request(url: string): EngineeringNetworkRequest {
            guard();
            const reference = references.get(engineeringPublicHttpsUrl(url).href);
            if (!reference)
                fail('reference_not_admitted');
            const value = Object.freeze({ url: reference.url, purpose: reference.purpose });
            requests.set(value, { reference, consumed: false });
            return value;
        },
        async download(request: EngineeringNetworkRequest): Promise<EngineeringDownloadedResource> {
            guard();
            const entry = requests.get(request);
            if (!entry || entry.consumed || state.busy)
                fail('request_replay_or_busy');
            entry.consumed = true;
            state.busy = true;
            const controller = new AbortController(), timeout = Math.min(ENGINEERING_NETWORK_LIMITS.transferMs, binding.deadlineMs - now());
            const timer = setTimeout(() => controller.abort(Error('engineering_network:deadline')), timeout);
            const deadline = new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(Error('engineering_network:deadline')), { once: true }));
            const bounded = <T>(p: Promise<T>) => Promise.race([p, deadline]);
            try {
                let url = entry.reference.url;
                const maximum = entry.reference.purpose === 'dependency' ? ENGINEERING_NETWORK_LIMITS.dependencyBytes : ENGINEERING_NETWORK_LIMITS.documentationBytes;
                for (let redirects = 0; redirects <= ENGINEERING_NETWORK_LIMITS.redirects; redirects++) {
                    guard();
                    controller.signal.throwIfAborted();
                    if (++state.count > ENGINEERING_NETWORK_LIMITS.taskRequests)
                        fail('request_limit');
                    const parsed = engineeringPublicHttpsUrl(url);
                    if (!origins.has(parsed.origin))
                        fail('redirect_origin');
                    const addresses = await bounded((options.resolve ?? resolvePublic)(parsed.hostname, controller.signal));
                    guard();
                    if (!addresses.length || addresses.length > 64 || addresses.some(a => !isEngineeringPublicAddress(a)))
                        fail('address');
                    const address = addresses[0]!, remaining = Math.min(maximum, ENGINEERING_NETWORK_LIMITS.taskBytes - state.total);
                    if (remaining <= 0)
                        fail('task_byte_limit');
                    // Failed/unknown transfers retain their full byte reservation. A peer
                    // cannot evade the task ceiling with repeated partial/error responses.
                    state.total += remaining;
                    const response = await bounded((options.transport ?? engineeringPublicHttpsTransport)({ url, hostname: parsed.hostname, address, family: isIP(address) as 4 | 6, maxBytes: remaining, signal: controller.signal }));
                    guard();
                    controller.signal.throwIfAborted();
                    if (!(response.bytes instanceof Uint8Array) || response.bytes.byteLength > remaining)
                        fail('byte_limit');
                    state.total -= remaining - response.bytes.byteLength;
                    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')
                        fail('encoding');
                    if ([301, 302, 303, 307, 308].includes(response.status)) {
                        if (redirects === ENGINEERING_NETWORK_LIMITS.redirects || !response.headers.location)
                            fail('redirect_limit');
                        url = engineeringPublicHttpsUrl(new URL(response.headers.location, url).href).href;
                        continue;
                    }
                    if (response.status !== 200)
                        fail('http_status');
                    const bytes = Uint8Array.from(response.bytes);
                    if (entry.reference.integrity)
                        verifyEngineeringIntegrity(bytes, entry.reference.integrity);
                    const contentType = (response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
                    if (entry.reference.purpose === 'documentation' && !['text/plain', 'text/html', 'text/markdown', 'application/json'].includes(contentType))
                        fail('document_type');
                    const receipt = Object.freeze({ ...binding, purpose: entry.reference.purpose, url: entry.reference.url, finalUrl: url,
                        provenanceSha256: entry.reference.provenanceSha256, sha256: digest(bytes), bytes: bytes.length,
                        integrity: entry.reference.integrity ?? null, redirects, contentType });
                    const resource = Object.freeze({ receipt, bytes: () => Uint8Array.from(bytes) });
                    minted.add(resource);
                    return resource;
                }
                return fail('redirect_limit');
            }
            finally {
                clearTimeout(timer);
                controller.abort();
                state.busy = false;
            }
        },
    });
}
