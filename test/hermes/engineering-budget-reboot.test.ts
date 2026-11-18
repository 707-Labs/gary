import { expect, test } from 'bun:test';
import { validateEngineeringLedgerRebootAttestation } from '../../src/hermes/engineering-budget-reboot.ts';
const bootSessionUUID = '02D97A38-83D2-457D-967F-A01481D5EEFC';
const apfsVolumeUUID = '7CD7DC2C-1F22-4B7C-BB7A-525D8FF5B697';
function fixture() {
  const context = {ledgerPath:'/canonical/spend.db',originalIntentPath:'/private/one.intent.json',originalIntentSha256:'a'.repeat(64),
    campaignId:'campaign',allocationId:'allocation',originalMetadata:{dev:16777229,ino:170496253,uid:501,gid:20,mode:33188},
    currentMetadata:{dev:16777232,ino:170496253,uid:501,gid:20,mode:33188}};
  const host = {bootSessionUUID,apfsVolumeUUID};
  const value = {version:1,kind:'engineering_ledger_reboot_attestation',...structuredClone(context),capMicros:5_650_000,...host,
    rebootObservationSha256:'b'.repeat(64),userMessageId:'Sentinel_f2a39cc8fb608191b26f1f7fd9769ab6'};
  return {context,host,value};
}
test('reboot evidence accepts only the exact device transition on the attested boot and volume',()=>{
  const f=fixture();expect(()=>validateEngineeringLedgerRebootAttestation(f.value,f.context,f.host)).not.toThrow();
});
for(const field of ['dev','ino','uid','gid','mode'] as const) test('rejects unrelated current ledger '+field+' changes',()=>{
  const f=fixture();f.context.currentMetadata[field]++;
  expect(()=>validateEngineeringLedgerRebootAttestation(f.value,f.context,f.host)).toThrow('reboot_attestation_rejected');
});
for(const field of ['ino','uid','gid','mode'] as const) test('even a repinned attestation cannot relax '+field,()=>{
  const f=fixture();f.context.currentMetadata[field]++;f.value.currentMetadata={...f.context.currentMetadata};
  expect(()=>validateEngineeringLedgerRebootAttestation(f.value,f.context,f.host)).toThrow('reboot_attestation_rejected');
});
test('a future boot is denied even when the numeric device is reused',()=>{
  const f=fixture();f.host.bootSessionUUID='12D97A38-83D2-457D-967F-A01481D5EEFC';
  expect(()=>validateEngineeringLedgerRebootAttestation(f.value,f.context,f.host)).toThrow('reboot_attestation_rejected');
});
test('another APFS volume is denied even with identical file numbers',()=>{
  const f=fixture();f.host.apfsVolumeUUID='8CD7DC2C-1F22-4B7C-BB7A-525D8FF5B697';
  expect(()=>validateEngineeringLedgerRebootAttestation(f.value,f.context,f.host)).toThrow('reboot_attestation_rejected');
});
test('does not create a general metadata exception when no device transition occurred',()=>{
  const f=fixture();f.context.currentMetadata.dev=f.context.originalMetadata.dev;f.value.currentMetadata={...f.context.currentMetadata};
  expect(()=>validateEngineeringLedgerRebootAttestation(f.value,f.context,f.host)).toThrow('reboot_attestation_rejected');
});
for(const field of ['ledgerPath','originalIntentPath','originalIntentSha256','campaignId','allocationId'] as const)
  test('attestation cannot move to another '+field,()=>{
    const f=fixture();f.context[field]+='x';
    expect(()=>validateEngineeringLedgerRebootAttestation(f.value,f.context,f.host)).toThrow('reboot_attestation_rejected');
  });
test('rejects enlarged cap, extra fields, missing fields, metadata coercion and another approval',()=>{
  for(const change of [(v:any)=>v.capMicros++, (v:any)=>v.extra=true, (v:any)=>delete v.originalIntentSha256,
    (v:any)=>v.originalMetadata.ino=String(v.originalMetadata.ino), (v:any)=>v.currentMetadata.extra=true,
    (v:any)=>v.userMessageId='different', (v:any)=>v.rebootObservationSha256='not-a-hash']) {
    const f=fixture();const value=structuredClone(f.value);change(value);
    expect(()=>validateEngineeringLedgerRebootAttestation(value,f.context,f.host)).toThrow('reboot_attestation_rejected');
  }
});
