/** Read-only, explicitly pinned recovery evidence for one macOS reboot. This
 * never authorizes enrollment, edits an old receipt, or changes a spend cap. */
import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
export interface EngineeringLedgerRebootReference { path: string; sha256: string; }
export interface EngineeringLedgerMetadata { dev: number; ino: number; uid: number; gid: number; mode: number; }
export interface EngineeringLedgerRebootContext {
  ledgerPath: string; originalIntentPath: string; originalIntentSha256: string;
  campaignId: string; allocationId: string;
  originalMetadata: EngineeringLedgerMetadata; currentMetadata: EngineeringLedgerMetadata;
}
export interface EngineeringLedgerBootIdentity { bootSessionUUID: string; apfsVolumeUUID: string; }
const UUID = /^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const metadataKeys = ['dev','ino','uid','gid','mode'] as const;
function fail(): never { throw new Error('engineering_budget_admission:reboot_attestation_rejected'); }
function record(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
function exact(v: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k)); }
/** Pure validation is separate so future-boot and identity-change cases can be
 * tested without overriding the production host observer. */
export function validateEngineeringLedgerRebootAttestation(value: unknown, context: EngineeringLedgerRebootContext, host: EngineeringLedgerBootIdentity): void {
  const keys = ['version','kind','ledgerPath','originalIntentPath','originalIntentSha256','campaignId','allocationId','capMicros',
    'originalMetadata','currentMetadata','bootSessionUUID','apfsVolumeUUID','rebootObservationSha256','userMessageId'];
  if (!record(value) || !exact(value,keys) || value.version !== 1 || value.kind !== 'engineering_ledger_reboot_attestation'
      || value.ledgerPath !== context.ledgerPath || value.originalIntentPath !== context.originalIntentPath
      || value.originalIntentSha256 !== context.originalIntentSha256 || !SHA.test(context.originalIntentSha256)
      || value.campaignId !== context.campaignId || value.allocationId !== context.allocationId || value.capMicros !== 5_650_000
      || value.userMessageId !== 'Sentinel_f2a39cc8fb608191b26f1f7fd9769ab6'
      || typeof value.rebootObservationSha256 !== 'string' || !SHA.test(value.rebootObservationSha256)
      || typeof value.bootSessionUUID !== 'string' || !UUID.test(value.bootSessionUUID) || value.bootSessionUUID !== host.bootSessionUUID
      || typeof value.apfsVolumeUUID !== 'string' || !UUID.test(value.apfsVolumeUUID) || value.apfsVolumeUUID !== host.apfsVolumeUUID) fail();
  for (const key of ['originalMetadata','currentMetadata'] as const) {
    const metadata = value[key];
    if (!record(metadata) || !exact(metadata,metadataKeys) || metadataKeys.some(k => !Number.isSafeInteger(metadata[k])
        || Number(metadata[k]) < 0 || metadata[k] !== context[key][k])) fail();
  }
  if (context.originalMetadata.dev === context.currentMetadata.dev
      || metadataKeys.filter(k => k !== 'dev').some(k => context.originalMetadata[k] !== context.currentMetadata[k])) fail();
}

let bootSessionUUID: string | undefined;
let volume: { dev: number; uuid: string } | undefined;
/** A process cannot survive a host reboot. Cache that immutable boot identity;
 * still check the current Data-volume device on every guard. No shell, PATH
 * lookup, environment override, credentials, network, or host mutation. */
export function observeEngineeringLedgerBootIdentity(ledgerDev: number): EngineeringLedgerBootIdentity {
  if (process.platform !== 'darwin') fail();
  const dataDev = lstatSync('/System/Volumes/Data').dev;
  if (dataDev !== ledgerDev) fail();
  const command = (executable: string, args: string[]) => {
    try { return execFileSync(executable,args,{ encoding:'utf8',timeout:3_000,maxBuffer:65_536,
      env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LC_ALL:'C'},stdio:['ignore','pipe','pipe'] }); }
    catch { return fail(); }
  };
  if (!bootSessionUUID) {
    const observed = command('/usr/sbin/sysctl',['-n','kern.bootsessionuuid']).trim();
    if (!UUID.test(observed)) fail(); bootSessionUUID = observed;
  }
  if (!volume || volume.dev !== dataDev) {
    const output = command('/usr/sbin/diskutil',['info','-plist','/System/Volumes/Data']);
    const matches = [...output.matchAll(/<key>VolumeUUID<\/key>\s*<string>([^<]+)<\/string>/g)];
    if (matches.length !== 1 || !UUID.test(matches[0]![1]!)) fail();
    volume = { dev:dataDev,uuid:matches[0]![1]! };
  }
  return { bootSessionUUID,apfsVolumeUUID:volume.uuid };
}
