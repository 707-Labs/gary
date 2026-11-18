/** Explicit host composition. Importing does nothing. Production calls make
 * public GETs; tests inject DNS/transport. Payload code is never run here. */
import { lstatSync } from 'node:fs';
import { createEngineeringNetworkBroker, type EngineeringNetworkBinding, type EngineeringNetworkQuota, type EngineeringNetworkHop, type EngineeringNetworkResponse } from './engineering-network-broker.ts';
import { engineeringDependencyNetworkReferences } from './engineering-dependency-plan.ts';
import { createEngineeringDependencyBundle, materializeEngineeringDependencyBundle, type EngineeringDependencyPreparation } from './engineering-dependency-bundle.ts';
import { assertEngineeringVerificationProfile, type EngineeringVerificationProfile } from './engineering-verification-profile.ts';
import { assertEngineeringDependencyAdmission, readEngineeringDependencyPlan, type EngineeringDependencyAdmission } from './engineering-dependency-admission.ts';
export { mintEngineeringDependencyAdmission } from './engineering-dependency-admission.ts';
function fail(c: string): never { throw Error('engineering_dependency_preparation:' + c); }
export async function prepareEngineeringDependencies(options: {
    workspaceRoot: string;
    materializationRoot: string;
    profile: EngineeringVerificationProfile;
    binding: EngineeringNetworkBinding;
    dependencyAdmission: EngineeringDependencyAdmission;
    networkQuota?: EngineeringNetworkQuota;
    provenanceSha256: string;
    allowLifecycleScripts: boolean;
    assertCurrent(): void;
    network?: {
        resolve?: (hostname: string, signal: AbortSignal) => Promise<readonly string[]>;
        transport?: (hop: EngineeringNetworkHop) => Promise<EngineeringNetworkResponse>;
    };
}): Promise<EngineeringDependencyPreparation | undefined> {
    const guard = () => { const r: unknown = options.assertCurrent(); if (r !== undefined) {
        void Promise.resolve(r).catch(() => { });
        fail('asynchronous_guard');
    } assertEngineeringVerificationProfile(options.profile, { workspaceRoot: options.workspaceRoot }); };
    guard();
    const root = options.workspaceRoot, original = lstatSync(root);
    const plan = readEngineeringDependencyPlan(options);
    // SRI is checked after receiving bytes. Coordinates must already be admitted
    // before DNS/HTTP, so a fake name/version cannot export private text in a GET.
    assertEngineeringDependencyAdmission(options.dependencyAdmission, { binding: options.binding, plan });
    if (!plan) return undefined;
    const broker = createEngineeringNetworkBroker({ binding: options.binding, ...(options.networkQuota ? { quota: options.networkQuota } : {}), assertCurrent: guard, references: engineeringDependencyNetworkReferences(plan), allowedOrigins: ['https://registry.npmjs.org'], ...options.network });
    const resources = [];
    for (const ref of engineeringDependencyNetworkReferences(plan)) {
        guard();
        resources.push(await broker.download(broker.request(ref.url)));
    }
    guard();
    if (lstatSync(root).dev !== original.dev || lstatSync(root).ino !== original.ino)
        fail('workspace_changed');
    const bundle = createEngineeringDependencyBundle(plan, resources, { allowLifecycleScripts: options.allowLifecycleScripts });
    return materializeEngineeringDependencyBundle(bundle, options.materializationRoot);
}
