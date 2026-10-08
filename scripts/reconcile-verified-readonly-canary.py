#!/usr/bin/env python3
"""Retire only the unused USD4.990725 authorization of the verified 5de09cee canary.

Default preview. No SQL writes, new enrollment, inference, Slack calls, or service
changes. Preserves the prior closed hold and every historical/unknown liability.
Uses the admission coordinator's stable exclusive lock; no stale-lock stealing.
"""
import argparse
import contextlib
import datetime
from decimal import Decimal
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import stat
import sys
import uuid

# Reuse the reviewed exact-decimal, no-symlink, durable-file primitives only.
sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location('readonly_reconciliation_util', Path(__file__).with_name('reconcile-readonly-canary.py'))
u = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(u)
RUN = 'hermes-readonly-20261008-5de09cee'
ALLOCATION = 'local:' + RUN
HOLD = 'hermes-readonly-canary:' + RUN
OPERATION = RUN + '-verified-unused-authorization-retirement'
ORIGINAL_HASH = '7f031985c7ef3d7d4bff4dc1d1309ec26079b95d40f912a95a3d58c731a5115b'
CONFIG_HASH = '89cf5db7d4bf4900f8c0e5709e2b3050ef613d66e4bb4d22666662d8cadb3fd7'
READINESS_RECEIPT = 'sha256:a22fd3ad3f0e1e32eb198b775878ff88caf9983701e3384dd0182e9ff80a173d'
CAP, CHARGED, RETIRED = 5_000_000_000, 9_275_000, 4_990_725_000
REQUEST = 'Sentinel_ecc85c3dae948191965308b6414c1165'
READY_KEY = 'ready:' + REQUEST + ':A0C7QFW3PEG:T0AA24R7VUZ:U0A9M5W16F8'


def reject(code):
    raise ValueError('verified_canary_reconciliation:' + code)


def receipt(row):
    value = dict(version=1, kind='verified_readonly', runId=row['run_id'], allocationId=row['allocation_id'],
        configFingerprint=row['config_fingerprint'], ownerEpoch=row['owner_epoch'], requestId=row['request_id'],
        fixtureSha256=row['fixture_sha256'], tracePath=row['trace_path'], traceSha256=row['trace_sha256'],
        modelRequests=row['model_requests'], toolReads=row['tool_reads'], chargedMicros=row['charged_micros'],
        nativeStatus='no_finish', traceClosed=True, cleanupComplete=True, publicationApproved=False)
    return 'sha256:' + u.sha(json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode())


def evidence(o):
    identities = {}
    for path in (o['ledger'], o['state_db']):
        identities[path] = u.identity(u.metadata(path))
        for suffix in ('-wal', '-shm'):
            try:
                u.metadata(path + suffix)
            except FileNotFoundError:
                pass
    config_file = u.snapshot(o['canary_config'])
    if stat.S_IMODE(config_file['stat'].st_mode) != 0o600:
        reject('unsafe_canary_config')
    # Pin the exact reviewed config and receipt in production. Offline fake-file
    # overrides exist only in the function API, never in CLI flags.
    if config_file['hash'] != o.get('expected_canary_config_sha256', CONFIG_HASH):
        reject('audited_canary_config_changed')
    config = u.parse(config_file['raw'])
    expected = {'version': 1, 'runId': RUN, 'campaignId': RUN, 'allocationId': ALLOCATION,
                'releaseCommit': 'be78cbd932687fb0fe192c3e078d0cdbc40cd1c1'}
    if any(config.get(k) != v for k, v in expected.items()) or set(config) != set(expected) | {'fixtureDirectory', 'traceDirectory'}:
        reject('canary_config_binding')
    with contextlib.ExitStack() as stack:
        connections = []
        for path in (o['ledger'], o['state_db']):
            db = stack.enter_context(contextlib.closing(sqlite3.connect(Path(path).as_uri() + '?mode=ro', uri=True)))
            db.row_factory = sqlite3.Row
            db.execute('PRAGMA query_only=ON')
            db.execute('BEGIN')
            connections.append(db)
        spend, state = connections
        def rows(db, query, args=()):
            return [dict(row) for row in db.execute(query, args)]
        campaigns = rows(spend, 'SELECT * FROM spend_campaigns WHERE id=?', (RUN,))
        allocations = rows(spend, 'SELECT * FROM spend_tickets WHERE campaign_id=? OR ticket_id=?', (RUN, ALLOCATION))
        attempts = rows(spend, 'SELECT * FROM spend_attempts WHERE ticket_id=? ORDER BY id', (ALLOCATION,))
        receipts = rows(spend, 'SELECT r.* FROM spend_receipts r JOIN spend_attempts a ON a.id=r.attempt_id WHERE a.ticket_id=? ORDER BY r.attempt_id', (ALLOCATION,))
        claims = rows(state, 'SELECT * FROM hermes_readonly_canaries WHERE run_id=? OR allocation_id=?', (RUN, ALLOCATION))
        outboxes = rows(state, "SELECT * FROM gary_slack_outbox WHERE kind='ready' OR request_id=?", (REQUEST,))
        if len(campaigns) != 1 or campaigns[0]['cap_micros'] != 5_000_000 or len(allocations) != 1:
            reject('campaign_binding')
        if any(allocations[0].get(k) != v for k, v in dict(ticket_id=ALLOCATION, campaign_id=RUN, cap_micros=5_000_000,
                draft_pr=0, state='closed', terminal_reason='verified_readonly').items()):
            reject('allocation_not_closed_verified')
        if len(attempts) != 2 or len(receipts) != 2:
            reject('unexpected_attempts_or_receipts')
        for attempt, rec, expected in zip(attempts, receipts, [(54, 4578, 396, 396, 45, 0), (55, 4697, 486, 102, 29, 384)]):
            ident, charge, input_total, input_uncached, output, cache = expected
            if any(attempt.get(k) != v for k, v in dict(id=ident, ticket_id=ALLOCATION, provider='deepseek', model='deepseek-v4-pro',
                    max_tokens=1024, reserved_micros=1_388_176, charged_micros=charge, state='settled', input_tokens=input_total, http_status=200).items()) or not attempt.get('settled_at'):
                reject('attempt_evidence')
            if rec.get('attempt_id') != ident or rec.get('reason') != 'accepted':
                reject('receipt_evidence')
            details = u.parse(rec['details_json'])
            if details.get('modelMatches') is not True or details.get('serviceTier') != 'standard' or details.get('unknownUsageFields') != 0:
                reject('receipt_evidence')
            for name, n in [('input_tokens', input_uncached), ('output_tokens', output), ('cache_read_input_tokens', cache), ('cache_creation_input_tokens', 0)]:
                if details.get('counters', {}).get(name) != {'state': 'integer', 'value': Decimal(n)}:
                    reject('receipt_counters')
        if len(claims) != 1 or any(claims[0].get(k) != v for k, v in dict(run_id=RUN, allocation_id=ALLOCATION,
                state='verified', model_requests=2, tool_reads=1, charged_micros=9275,
                config_fingerprint='b299a4c739532bd2eb3d4f741b76c7250515b76524d0b9e20960e72c09c4baeb').items()):
            reject('canary_not_verified')
        claim = claims[0]
        if not claim.get('completed_at') or not claim.get('owner_epoch') or claim.get('receipt_id') != receipt(claim) or claim.get('receipt_id') != o.get('expected_readiness_receipt_id', READINESS_RECEIPT):
            reject('readiness_receipt_binding')
        if claim['trace_path'] != str(Path(config['traceDirectory']) / (claim['request_id'] + '.jsonl')):
            reject('trace_path_binding')
        trace = u.snapshot(claim['trace_path'])
        fixture = u.snapshot(str(Path(config['fixtureDirectory']) / RUN / 'challenge.json'))
        if trace['hash'] != claim['trace_sha256'] or fixture['hash'] != claim['fixture_sha256'] or stat.S_IMODE(trace['stat'].st_mode) != 0o600 or stat.S_IMODE(fixture['stat'].st_mode) != 0o444:
            reject('readiness_files_changed')
        if len(outboxes) != 1 or any(outboxes[0].get(k) != v for k, v in dict(delivery_key=READY_KEY, kind='ready', request_id=REQUEST,
                app_id='A0C7QFW3PEG', team_id='T0AA24R7VUZ', bot_user_id='U0C7NPEUG1F', recipient_id='U0A9M5W16F8',
                target_channel='U0A9M5W16F8', thread_ts=None, content_sha256='dd5abbdd9a4251dcfc82a9a7c833bbfb7676948b0e23049c62aa5c801ad67438',
                readiness_receipt_id=claim['receipt_id'], status='sent', error_code=None, slack_channel='D0C7EJELQJX', slack_ts='1791425065.474159').items()):
            reject('ready_dm_not_confirmed')
        outbox = outboxes[0]
        if not outbox.get('completed_at') or not outbox.get('claim_id') or not isinstance(outbox.get('slack_channel'), str) or not outbox['slack_channel'].startswith('D') or not outbox.get('slack_ts'):
            reject('ready_dm_receipt_missing')
        if rows(spend, "SELECT ticket_id FROM spend_tickets WHERE state='active'") or rows(state, "SELECT run_id FROM hermes_readonly_canaries WHERE state='running'"):
            reject('concurrent_allocation_or_canary')
        prior = {t: rows(spend, 'SELECT * FROM ' + t + ' ORDER BY ' + key) for t, key in
                 [('spend_campaigns', 'id'), ('spend_tickets', 'ticket_id'), ('spend_attempts', 'id'), ('spend_receipts', 'attempt_id')]}
        readonly_attempts = rows(spend, "SELECT id,ticket_id,state,charged_micros FROM spend_attempts WHERE ticket_id LIKE 'local:hermes-readonly-%' ORDER BY id")
        if readonly_attempts != [dict(id=53, ticket_id='local:hermes-readonly-20261008-db05d434', state='settled', charged_micros=4683),
                dict(id=54, ticket_id=ALLOCATION, state='settled', charged_micros=4578), dict(id=55, ticket_id=ALLOCATION, state='settled', charged_micros=4697)]:
            reject('paid_call_count_changed')
        result = dict(campaign=campaigns[0], allocation=allocations[0], attempts=attempts, receipts=receipts, claim=claim, outbox=outbox,
            allSpendRowsSha256=u.sha(json.dumps(prior, sort_keys=True, separators=(',', ':')).encode()), databaseIdentities=identities,
            canaryConfigSha256=config_file['hash'], traceSha256=trace['hash'], fixtureSha256=fixture['hash'], paidCalls=3)
        for path in (o['ledger'], o['state_db']):
            if u.identity(u.metadata(path)) != identities[path]:
                reject('database_replaced')
        return result


def reconcile(options, hook=lambda stage: None):
    o = dict(options)
    for key in ('aggregate', 'ledger', 'state_db', 'audit_dir', 'canary_config'):
        u.canonical(o[key])
    expected_hash = o['expected_sha256']
    if len(expected_hash) != 64 or any(c not in '0123456789abcdef' for c in expected_hash):
        reject('expected_hash')
    apply = o.get('apply', False)
    lock = o['aggregate'] + '.admission.lock'
    claim = (json.dumps(dict(version=1, pid=os.getpid(), claim=str(uuid.uuid4()), runId=RUN, operation=OPERATION)) + '\n').encode()
    owned = None
    if apply:
        os.mkdir(lock, 0o700)
        owned = os.lstat(lock)
        u.fsync_dir(Path(lock).parent)
        u.write_new(str(Path(lock) / 'claim.json'), claim)
    try:
        if apply:
            hook('locked')
        before = u.snapshot(o['aggregate'])
        proof = evidence(o)
        proof_raw = (json.dumps(proof, sort_keys=True, indent=2) + '\n').encode()
        proof_hash = u.sha(proof_raw)
        paths = {k: str(Path(o['audit_dir']) / (OPERATION + '.' + k + '.json')) for k in ('before', 'after', 'evidence', 'intent', 'verified')}
        budget = u.parse(before['raw'])
        u.totals(budget)
        entries = [a for a in budget['runtimeAllocations'] if a['id'] == HOLD]
        if len(entries) != 1:
            reject('missing_hold')
        admission = entries[0].get('admission', {})
        if any(admission.get(k) != v for k, v in dict(kind='hermes_readonly_canary', runId=RUN, campaignId=RUN,
                allocationId=ALLOCATION, ledgerPath=o['ledger'], capUsdExact='5.000000000', draftPr=False).items()):
            reject('hold_binding')
        admitted = u.parse(u.snapshot(admission['auditRecord'])['raw'])
        # Fixture API override is never exposed by the operator CLI.
        original_hash = o.get('original_admission_after_sha256', ORIGINAL_HASH)
        if admitted.get('afterSha256') != original_hash or any(admitted.get(k) != v for k, v in dict(runId=RUN, allocationId=ALLOCATION, ledgerPath=o['ledger']).items()):
            reject('original_admission_binding')
        admission_after = u.snapshot(str(Path(admission['auditRecord']).with_name(RUN + '.after.json')))
        if admission_after['hash'] != original_hash:
            reject('original_admission_changed')
        def transition(source, timestamp):
            b = u.parse(source)
            sums = u.totals(b)
            entry = next(a for a in b['runtimeAllocations'] if a['id'] == HOLD)
            if entry.get('state') != 'held_for_readonly_canary' or u.nanos(entry.get('amountUsd')) != CAP or u.nanos(entry.get('retainedAmountUsd')) != CAP or u.nanos(entry.get('retiredUnusedAuthorizationUsd')) != 0 or u.nanos(entry.get('retainedUnknownCostsUsd')) != 0:
                reject('hold_not_unreconciled')
            if b.get('hermesPaidCalls') != 1 or 'originalState' in entry or 'reconciliation' in entry:
                reject('snapshot_metadata_changed')
            entry['originalState'] = entry['state']
            entry['state'] = 'verified_retained_charge'
            entry['retainedAmountUsd'] = u.money(CHARGED)
            entry['retiredUnusedAuthorizationUsd'] = u.money(RETIRED)
            entry['reconciliation'] = dict(id=OPERATION, auditRecord=paths['intent'], evidenceSha256=proof_hash,
                attemptIds=[54, 55], settledAttempts=2, unknownAttempts=0, readinessReceiptId=proof['claim']['receipt_id'],
                readyDeliveryKey=READY_KEY, bookedChargeUsdExact='0.009275000', unusedAuthorizationRetiredUsdExact='4.990725000',
                semantics='Retain conservative booked charge, not an invoice. Retire only unused aggregate authorization. SQL caps, closed allocations, claims, outbox, receipts and historical unknowns unchanged.')
            for key, delta in [('runtimeCommittedOrHeldUsd', -RETIRED), ('runtimeUnallocatedUsd', RETIRED),
                               ('totalCommittedOrHeldUsd', -RETIRED), ('runtimeAuthorizationRetiredUsd', RETIRED)]:
                b[key] = u.money(sums[key] + delta)
            b['hermesPaidCalls'] = 3
            b['bookkeepingUpdatedAt'] = timestamp
            u.totals(b)
            return (u.encode(b) + '\n').encode()
        recovery = entries[0].get('state') == 'verified_retained_charge'
        prior_intent_raw = None
        if recovery:
            original = u.snapshot(paths['before'])
            after = u.snapshot(paths['after'])
            prior_intent_raw = u.snapshot(paths['intent'])['raw']
            intent = u.parse(prior_intent_raw)
            binding = dict(operation=OPERATION, runId=RUN, allocationId=ALLOCATION, aggregatePath=o['aggregate'],
                           ledgerPath=o['ledger'], stateDbPath=o['state_db'], canaryConfigPath=o['canary_config'])
            if any(intent.get(k) != v for k, v in binding.items()) or expected_hash not in (original['hash'], before['hash']) or original['hash'] != original_hash or before['hash'] != after['hash'] or intent.get('beforeSha256') != original['hash'] or intent.get('afterSha256') != after['hash'] or intent.get('evidenceSha256') != proof_hash or u.snapshot(paths['evidence'])['raw'] != proof_raw:
                reject('recovery_audit_changed')
            after_raw = transition(original['raw'], u.parse(after['raw'])['bookkeepingUpdatedAt'])
            if after_raw != after['raw']:
                reject('recovery_transition_changed')
        else:
            if before['hash'] != expected_hash or before['hash'] != original_hash:
                reject('aggregate_changed')
            original = before
            after_raw = transition(before['raw'], datetime.datetime.now(datetime.timezone.utc).isoformat())
            try:
                prepared = u.snapshot(paths['after'])
            except FileNotFoundError:
                prepared = None
            if prepared:
                candidate = transition(before['raw'], u.parse(prepared['raw'])['bookkeepingUpdatedAt'])
                if candidate != prepared['raw']:
                    reject('prepared_audit_conflict')
                after_raw = candidate
        intent_raw = prior_intent_raw or (json.dumps(dict(schemaVersion=1, operation=OPERATION, runId=RUN, allocationId=ALLOCATION,
            aggregatePath=o['aggregate'], ledgerPath=o['ledger'], stateDbPath=o['state_db'], canaryConfigPath=o['canary_config'],
            beforeSha256=original['hash'], afterSha256=u.sha(after_raw), evidenceSha256=proof_hash, sourceMetadata=u.identity(original['stat']),
            retainedUsdExact='0.009275000', retiredUsdExact='4.990725000', sqlWrites=False, newAuthorization=False), indent=2) + '\n').encode()
        after_sums = u.totals(u.parse(after_raw))
        result = dict(applied=apply, recovery=recovery, beforeSha256=original['hash'], afterSha256=u.sha(after_raw),
            retainedUsd='0.009275000', retiredUsd='4.990725000', paidCalls=3, sqlWrites=False, newAuthorization=False,
            totals={k: format(u.money(v), 'f') for k, v in after_sums.items()})
        if not apply:
            return result
        try:
            os.mkdir(o['audit_dir'], 0o700)
            u.fsync_dir(Path(o['audit_dir']).parent)
        except FileExistsError:
            pass
        audit_stat = os.lstat(o['audit_dir'])
        if not stat.S_ISDIR(audit_stat.st_mode) or audit_stat.st_uid != os.getuid() or audit_stat.st_mode & 0o077:
            reject('unsafe_audit_directory')
        for name, raw in [('before', original['raw']), ('after', after_raw), ('evidence', proof_raw), ('intent', intent_raw)]:
            u.write_once(paths[name], raw)
        hook('audit_prepared')
        if evidence(o) != proof or not u.unchanged(before, u.snapshot(o['aggregate'])):
            reject('evidence_or_aggregate_changed')
        if not recovery:
            temporary = o['aggregate'] + '.' + str(uuid.uuid4()) + '.tmp'
            try:
                u.write_new(temporary, after_raw, stat.S_IMODE(before['stat'].st_mode))
                fd = os.open(temporary, os.O_WRONLY | os.O_NOFOLLOW)
                try:
                    os.fchmod(fd, stat.S_IMODE(before['stat'].st_mode))
                    os.fchown(fd, before['stat'].st_uid, before['stat'].st_gid)
                    os.fsync(fd)
                finally:
                    os.close(fd)
                if evidence(o) != proof or not u.unchanged(before, u.snapshot(o['aggregate'])):
                    reject('evidence_or_aggregate_changed')
                os.replace(temporary, o['aggregate'])
                u.fsync_dir(Path(o['aggregate']).parent)
            finally:
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    pass
        hook('retirement_durable')
        if u.snapshot(o['aggregate'])['hash'] != u.sha(after_raw) or evidence(o) != proof:
            reject('verification_failed')
        u.write_once(paths['verified'], (json.dumps(dict(operation=OPERATION, afterSha256=u.sha(after_raw),
            evidenceSha256=proof_hash, allSpendRowsUnchanged=True, claimUnchanged=True, sentOutboxUnchanged=True), indent=2) + '\n').encode())
        return result
    finally:
        if owned:
            current = os.lstat(lock)
            if (current.st_dev, current.st_ino) != (owned.st_dev, owned.st_ino) or u.snapshot(str(Path(lock) / 'claim.json'))['raw'] != claim:
                reject('lock_identity_changed')
            os.unlink(Path(lock) / 'claim.json')
            os.rmdir(lock)
            u.fsync_dir(Path(lock).parent)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ('aggregate', 'ledger', 'state-db', 'audit-dir', 'canary-config', 'expected-sha256'):
        parser.add_argument('--' + flag, required=True)
    parser.add_argument('--apply', action='store_true')
    print(json.dumps(reconcile(vars(parser.parse_args())), indent=2))
