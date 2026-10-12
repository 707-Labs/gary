/** Parse dependency declarations as data, never JavaScript. No I/O or install.
 * A lock pins content; it does not authorize arbitrary candidate URLs. This
 * initial public profile accepts canonical npm registry tarballs only. */
import { createHash } from 'node:crypto';
import { validateEngineeringIntegrity, type EngineeringNetworkReference } from './engineering-network-broker.ts';
export interface EngineeringDependencyPackage {
    readonly name: string;
    readonly version: string;
    readonly url: string;
    readonly integrity: string;
    readonly fileName: string;
}
export interface EngineeringDependencyPlan {
    readonly version: 1;
    readonly kind: 'bun' | 'npm';
    readonly hash: string;
    readonly packageJsonSha256: string;
    readonly lockfileSha256: string;
    readonly lockfileName: 'bun.lock' | 'package-lock.json';
    readonly provenanceSha256: string;
    readonly packages: readonly EngineeringDependencyPackage[];
}
const plans = new WeakMap<object, {
    packageJson: Uint8Array;
    lockfile: Uint8Array;
}>();
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value: unknown) => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function fail(code: string): never { throw Error('engineering_dependency:' + code); }
export function engineeringNpmTarball(name: string, version: string): string {
    if (typeof name !== 'string' || name.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)
        || name.split('/').some(v => v === '.' || v === '..') || typeof version !== 'string' || version.length > 128
        || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version))
        fail('package_identity');
    return `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`;
}
/** Minimal JSON-with-comments/trailing-commas reader. Strings are preserved;
 * comments are blanked before removing commas outside strings. No eval/JSON5. */
export function parseEngineeringBunLock(bytes: Uint8Array): unknown {
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    catch {
        return fail('lock_json');
    }
    let out = '', quoted = false, escape = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        if (quoted) {
            out += c;
            if (escape)
                escape = false;
            else if (c === '\\')
                escape = true;
            else if (c === '"')
                quoted = false;
            continue;
        }
        if (c === '"') {
            quoted = true;
            out += c;
            continue;
        }
        if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') {
                out += ' ';
                i++;
            }
            out += '\n';
            continue;
        }
        if (c === '/' && text[i + 1] === '*') {
            out += '  ';
            i += 2;
            let found = false;
            for (; i < text.length; i++) {
                if (text[i] === '*' && text[i + 1] === '/') {
                    out += '  ';
                    i++;
                    found = true;
                    break;
                }
                out += text[i] === '\n' ? '\n' : ' ';
            }
            if (!found)
                fail('lock_json');
            continue;
        }
        out += c;
    }
    let clean = '';
    quoted = false;
    escape = false;
    for (let i = 0; i < out.length; i++) {
        const c = out[i]!;
        if (quoted) {
            clean += c;
            if (escape)
                escape = false;
            else if (c === '\\')
                escape = true;
            else if (c === '"')
                quoted = false;
            continue;
        }
        if (c === '"')
            quoted = true;
        if (c === ',') {
            let j = i + 1;
            while (/\s/.test(out[j] ?? '') && j < out.length)
                j++;
            if (out[j] === ']' || out[j] === '}')
                continue;
        }
        clean += c;
    }
    try {
        return JSON.parse(clean);
    }
    catch {
        return fail('lock_json');
    }
}
export function createEngineeringDependencyPlan(input: {
    packageJson: Uint8Array;
    lockfile: {
        name: 'bun.lock' | 'package-lock.json';
        bytes: Uint8Array;
    };
    provenanceSha256: string;
}): EngineeringDependencyPlan {
    if (!(input.packageJson instanceof Uint8Array) || input.packageJson.length > 1024 * 1024 || !(input.lockfile.bytes instanceof Uint8Array)
        || input.lockfile.bytes.length > 16 * 1024 * 1024 || !['bun.lock', 'package-lock.json'].includes(input.lockfile.name)
        || !/^[a-f0-9]{64}$/.test(input.provenanceSha256))
        fail('input');
    let manifest: unknown;
    try {
        manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.packageJson));
    }
    catch {
        return fail('package_json');
    }
    if (!object(manifest))
        fail('package_json');
    const lock = input.lockfile.name === 'bun.lock' ? parseEngineeringBunLock(input.lockfile.bytes) : (() => { try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.lockfile.bytes));
    }
    catch {
        return fail('lock_json');
    } })();
    if (!object(lock) || !object(lock.packages))
        fail('lock_shape');
    const packages = new Map<string, EngineeringDependencyPackage>();
    const add = (name: string, version: string, integrity: unknown, resolved: unknown) => {
        const url = engineeringNpmTarball(name, version);
        if (typeof integrity !== 'string')
            fail('integrity_missing');
        validateEngineeringIntegrity(integrity);
        if (resolved !== undefined && resolved !== '' && resolved !== url)
            fail('source_not_canonical');
        const key = `${name}@${version}`, previous = packages.get(key);
        if (previous && previous.integrity !== integrity)
            fail('integrity_conflict');
        packages.set(key, Object.freeze({ name, version, url, integrity, fileName: sha(key + '\0' + integrity) + '.tgz' }));
        if (packages.size > 2048)
            fail('package_limit');
    };
    if (input.lockfile.name === 'bun.lock') {
        if (lock.lockfileVersion !== 1 || !object(lock.workspaces) || !object(lock.workspaces['']))
            fail('lock_version');
        const root = lock.workspaces[''];
        for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
            if (canonical(manifest[key] ?? {}) !== canonical(root[key] ?? {}))
                fail('manifest_lock_mismatch');
        }
        for (const value of Object.values(lock.packages)) {
            if (!Array.isArray(value) || value.length !== 4 || typeof value[0] !== 'string' || !object(value[2]))
                fail('package_shape');
            const at = value[0].lastIndexOf('@');
            if (at <= 0)
                fail('package_identity');
            add(value[0].slice(0, at), value[0].slice(at + 1), value[3], value[1]);
        }
    }
    else {
        if (![2, 3].includes(Number(lock.lockfileVersion)) || !object(lock.packages['']))
            fail('lock_version');
        for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
            if (canonical(manifest[key] ?? {}) !== canonical(lock.packages[''][key] ?? {}))
                fail('manifest_lock_mismatch');
        }
        for (const [path, value] of Object.entries(lock.packages)) {
            if (path === '')
                continue;
            if (!object(value) || value.link === true || typeof value.version !== 'string' || !path.startsWith('node_modules/')
                || path.split('/').some(v => !v || v === '.' || v === '..'))
                fail('package_shape');
            const tail = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
            const name = typeof value.name === 'string' ? value.name : tail;
            add(name, value.version, value.integrity, value.resolved);
        }
    }
    const body = { version: 1 as const, kind: input.lockfile.name === 'bun.lock' ? 'bun' as const : 'npm' as const,
        packageJsonSha256: sha(input.packageJson), lockfileSha256: sha(input.lockfile.bytes), lockfileName: input.lockfile.name,
        provenanceSha256: input.provenanceSha256, packages: Object.freeze([...packages.values()].sort((a, b) => a.url.localeCompare(b.url))) };
    const plan = Object.freeze({ ...body, hash: sha(JSON.stringify(body)) });
    plans.set(plan, { packageJson: Uint8Array.from(input.packageJson), lockfile: Uint8Array.from(input.lockfile.bytes) });
    return plan;
}
export function assertEngineeringDependencyPlan(plan: EngineeringDependencyPlan): void { if (!plan || !plans.has(plan))
    fail('plan_provenance'); }
export function engineeringDependencyPlanFiles(plan: EngineeringDependencyPlan): {
    packageJson: Uint8Array;
    lockfile: Uint8Array;
} {
    assertEngineeringDependencyPlan(plan);
    const value = plans.get(plan)!;
    return { packageJson: Uint8Array.from(value.packageJson), lockfile: Uint8Array.from(value.lockfile) };
}
export function engineeringDependencyNetworkReferences(plan: EngineeringDependencyPlan): readonly EngineeringNetworkReference[] {
    assertEngineeringDependencyPlan(plan);
    return Object.freeze(plan.packages.map(p => Object.freeze({ purpose: 'dependency' as const, url: p.url, integrity: p.integrity, provenanceSha256: plan.hash })));
}
/** Exact-version registry metadata is data for resolving a newly requested
 * package, not executable configuration. Caller admits this reference under the
 * task before passing it to the broker; no arbitrary URL or registry override. */
export function engineeringNpmMetadataReference(name: string, version: string, provenanceSha256: string): EngineeringNetworkReference {
    engineeringNpmTarball(name, version);
    if (!/^[a-f0-9]{64}$/.test(provenanceSha256))
        fail('input');
    return Object.freeze({ purpose: 'documentation', url: `https://registry.npmjs.org/${name}/${version}`, provenanceSha256 });
}
export function parseEngineeringNpmMetadata(name: string, version: string, bytes: Uint8Array): EngineeringDependencyPackage {
    if (bytes.length > 2 * 1024 * 1024)
        fail('metadata_size');
    let value: unknown;
    try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    }
    catch {
        return fail('metadata_json');
    }
    const url = engineeringNpmTarball(name, version);
    if (!object(value) || value.name !== name || value.version !== version || !object(value.dist) || value.dist.tarball !== url || typeof value.dist.integrity !== 'string')
        fail('metadata_binding');
    validateEngineeringIntegrity(value.dist.integrity);
    return Object.freeze({ name, version, url, integrity: value.dist.integrity, fileName: sha(`${name}@${version}\0${value.dist.integrity}`) + '.tgz' });
}
