#!/usr/bin/env python3
"""Retire ONLY unused authorization from the one closed failed canary.

No SQL writes, enrollment, network, or model calls. All aggregate coordinators
must honor the same stable <aggregate>.admission.lock directory. Crash-left locks
are never stolen. An operator must inspect the claim/audits before removing one.
The next canary requires a NEW hold-first admission and new immutable identities.
"""
import argparse
import contextlib
import datetime
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import uuid

RUN = 'hermes-readonly-20261008-db05d434'
ALLOCATION = 'local:' + RUN
HOLD = 'hermes-readonly-canary:' + RUN
OPERATION = RUN + '-unused-authorization-retirement'
CAP = 5_000_000_000
CHARGED = 4_683_000
RETIRED = CAP - CHARGED


def reject(reason):
    raise ValueError('readonly_canary_reconciliation:' + reason)


def sha(value):
    return hashlib.sha256(value).hexdigest()


def parse(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                reject('duplicate_json_key')
            result[key] = value
        return result
    def invalid(_):
        reject('nonfinite_json')
    return json.loads(raw, parse_float=Decimal, parse_int=Decimal,
                      parse_constant=invalid, object_pairs_hook=pairs)


def encode(value, depth=0):
    """Preserve decimal values/scale without a binary floating-point conversion."""
    if isinstance(value, Decimal):
        if not value.is_finite():
            reject('nonfinite_json')
        return format(value, 'f')
    if isinstance(value, dict):
        return '{\n' + ',\n'.join('  ' * (depth + 1) + json.dumps(k) + ': ' + encode(v, depth + 1)
                                 for k, v in value.items()) + '\n' + '  ' * depth + '}' if value else '{}'
    if isinstance(value, list):
        return '[\n' + ',\n'.join('  ' * (depth + 1) + encode(v, depth + 1) for v in value) + '\n' + '  ' * depth + ']' if value else '[]'
    return json.dumps(value, allow_nan=False, ensure_ascii=True)


def nanos(value):
    if not isinstance(value, Decimal) or not value.is_finite() or value < 0:
        reject('invalid_money')
    result = value * 1_000_000_000
    if result != result.to_integral_value() or result > 1_000_000_000_000:
        reject('invalid_money_precision')
    return int(result)


def money(value):
    return Decimal(value).scaleb(-9).quantize(Decimal('.000000001'))


def canonical(path):
    p = Path(path)
    if not p.is_absolute() or str(p) != os.path.normpath(path) or os.path.realpath(p.parent) != str(p.parent):
        reject('noncanonical_or_symlink_path')
    parent = os.lstat(p.parent)
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid() or parent.st_mode & 0o022:
        reject('unsafe_parent_metadata')
    return str(p)


def metadata(path):
    canonical(path)
    s = os.lstat(path)
    if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_uid != os.getuid() or s.st_mode & 0o022:
        reject('unsafe_file_metadata')
    return s


def identity(s):
    return {k: getattr(s, 'st_' + k) for k in ('dev', 'ino', 'uid', 'gid', 'mode')}


def snapshot(path):
    before = metadata(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        current = os.fstat(fd)
        if identity(current) != identity(before) or current.st_size > 4_194_304:
            reject('unsafe_snapshot')
        with os.fdopen(os.dup(fd), 'rb') as stream:
            raw = stream.read(4_194_305)
        after = os.fstat(fd)
        if (len(raw), after.st_mtime_ns, after.st_ctime_ns) != (current.st_size, current.st_mtime_ns, current.st_ctime_ns):
            reject('snapshot_changed')
        return {'raw': raw, 'hash': sha(raw), 'stat': after}
    finally:
        os.close(fd)


def unchanged(a, b):
    return a['hash'] == b['hash'] and all(getattr(a['stat'], k) == getattr(b['stat'], k)
        for k in ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_new(path, raw, mode=0o600):
    canonical(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(os.dup(fd), 'wb') as stream:
            stream.write(raw)
            stream.flush()
        os.fsync(fd)
    finally:
        os.close(fd)
    fsync_dir(Path(path).parent)


def write_once(path, raw):
    try:
        write_new(path, raw)
    except FileExistsError:
        if snapshot(path)['raw'] != raw:
            reject('audit_conflict')


def totals(budget):
    if budget.get('schemaVersion') != 2 or not isinstance(budget.get('runtimeAllocations'), list):
        reject('aggregate_schema')
    for key, expected in [('totalCeilingUsd', 100), ('runtimePoolUsd', 60), ('other90HoldUsd', 30), ('bufferHoldUsd', 10)]:
        if nanos(budget.get(key)) != expected * 1_000_000_000:
            reject('aggregate_caps')
    held = unknown = retired = 0
    ids = set()
    for a in budget['runtimeAllocations']:
        if not isinstance(a, dict) or not isinstance(a.get('id'), str) or a['id'] in ids:
            reject('aggregate_allocation')
        ids.add(a['id'])
        h, u, r = (nanos(a.get(k)) for k in ('retainedAmountUsd', 'retainedUnknownCostsUsd', 'retiredUnusedAuthorizationUsd'))
        if u > h or h + r != nanos(a.get('amountUsd')):
            reject('aggregate_allocation_totals')
        held += h
        unknown += u
        retired += r
    expected = {'runtimeCommittedOrHeldUsd': held, 'runtimeUnallocatedUsd': 60_000_000_000-held,
                'totalCommittedOrHeldUsd': held+40_000_000_000, 'runtimeUnknownHoldsUsd': unknown,
                'runtimeAuthorizationRetiredUsd': retired}
    if unknown < 4_444_468_350 or any(nanos(budget.get(k)) != v for k, v in expected.items()):
        reject('aggregate_totals')
    return expected


def evidence(spend_path, state_path):
    identities = {}
    for path in (spend_path, state_path):
        identities[path] = identity(metadata(path))
        for suffix in ('-wal', '-shm'):
            try:
                metadata(path + suffix)
            except FileNotFoundError:
                pass
    with contextlib.ExitStack() as stack:
        dbs = []
        for path in (spend_path, state_path):
            db = stack.enter_context(contextlib.closing(sqlite3.connect(Path(path).as_uri() + '?mode=ro', uri=True)))
            db.row_factory = sqlite3.Row
            db.execute('PRAGMA query_only=ON')
            db.execute('BEGIN')
            dbs.append(db)
        spend, state = dbs
        def rows(db, query, args=()):
            return [dict(row) for row in db.execute(query, args)]
        campaigns = rows(spend, 'SELECT * FROM spend_campaigns WHERE id=?', (RUN,))
        tickets = rows(spend, 'SELECT * FROM spend_tickets WHERE campaign_id=? OR ticket_id=?', (RUN, ALLOCATION))
        attempts = rows(spend, 'SELECT * FROM spend_attempts WHERE ticket_id=? ORDER BY id', (ALLOCATION,))
        receipts = rows(spend, 'SELECT r.* FROM spend_receipts r JOIN spend_attempts a ON a.id=r.attempt_id WHERE a.ticket_id=? ORDER BY r.attempt_id', (ALLOCATION,))
        claims = rows(state, 'SELECT * FROM hermes_readonly_canaries WHERE run_id=? OR allocation_id=?', (RUN, ALLOCATION))
        if len(campaigns) != 1 or campaigns[0]['cap_micros'] != 5_000_000 or len(tickets) != 1:
            reject('old_campaign_binding')
        ticket = tickets[0]
        if any(ticket.get(k) != v for k, v in {'ticket_id': ALLOCATION, 'campaign_id': RUN, 'cap_micros': 5_000_000,
            'draft_pr': 0, 'state': 'closed', 'terminal_reason': 'readonly_canary_failed'}.items()):
            reject('old_allocation_not_closed')
        if len(attempts) != 1 or any(attempts[0].get(k) != v for k, v in {'id': 53, 'ticket_id': ALLOCATION,
            'provider': 'deepseek', 'model': 'deepseek-v4-pro', 'max_tokens': 1024, 'reserved_micros': 1_388_176,
            'charged_micros': 4683, 'state': 'settled', 'input_tokens': 475, 'http_status': 200}.items()) or not attempts[0].get('settled_at'):
            reject('old_attempt_evidence')
        if len(receipts) != 1 or receipts[0].get('attempt_id') != 53 or receipts[0].get('reason') != 'accepted':
            reject('old_receipt_evidence')
        details = parse(receipts[0]['details_json'])
        if details.get('modelMatches') is not True or details.get('serviceTier') != 'standard' or details.get('unknownUsageFields') != 0:
            reject('old_receipt_evidence')
        for key, value in [('input_tokens', 475), ('output_tokens', 74), ('cache_read_input_tokens', 0), ('cache_creation_input_tokens', 0)]:
            if details.get('counters', {}).get(key) != {'state': 'integer', 'value': Decimal(value)}:
                reject('old_receipt_counters')
        if len(claims) != 1 or any(claims[0].get(k) != v for k, v in {'run_id': RUN, 'allocation_id': ALLOCATION,
            'state': 'failed', 'model_requests': 0, 'tool_reads': 0}.items()) or not claims[0].get('completed_at'):
            reject('old_claim_not_failed')
        if rows(spend, "SELECT ticket_id FROM spend_tickets WHERE state='active'") or rows(state, "SELECT run_id FROM hermes_readonly_canaries WHERE state='running'"):
            reject('another_allocation_or_canary_active')
        prior = {table: rows(spend, 'SELECT * FROM ' + table + ' ORDER BY ' + key)
                 for table, key in [('spend_campaigns', 'id'), ('spend_tickets', 'ticket_id'), ('spend_attempts', 'id'), ('spend_receipts', 'attempt_id')]}
        result = {'campaign': campaigns[0], 'allocation': ticket, 'attempt': attempts[0], 'receipt': receipts[0], 'claim': claims[0],
                  'allSpendRowsSha256': sha(json.dumps(prior, sort_keys=True, separators=(',', ':')).encode()), 'databaseIdentities': identities}
        for path in (spend_path, state_path):
            if identity(metadata(path)) != identities[path]:
                reject('database_replaced')
        return result


def reconcile(options, hook=lambda stage: None):
    o = dict(options)
    for key in ('aggregate', 'ledger', 'state_db', 'audit_dir'):
        canonical(o[key])
    expected_hash = o['expected_sha256']
    if len(expected_hash) != 64 or any(c not in '0123456789abcdef' for c in expected_hash):
        reject('expected_hash')
    apply = o.get('apply', False)
    lock = o['aggregate'] + '.admission.lock'
    claim = (json.dumps({'version': 1, 'pid': os.getpid(), 'claim': str(uuid.uuid4()), 'runId': RUN, 'operation': OPERATION}) + '\n').encode()
    owned = None
    if apply:
        os.mkdir(lock, 0o700)
        owned = os.lstat(lock)
        fsync_dir(Path(lock).parent)
        write_new(str(Path(lock) / 'claim.json'), claim)
    try:
        if apply:
            hook('locked')
        before = snapshot(o['aggregate'])
        proof = evidence(o['ledger'], o['state_db'])
        proof_raw = (json.dumps(proof, sort_keys=True, indent=2) + '\n').encode()
        proof_hash = sha(proof_raw)
        paths = {name: str(Path(o['audit_dir']) / (OPERATION + '.' + name + '.json')) for name in ('before', 'after', 'evidence', 'intent', 'verified')}
        budget = parse(before['raw'])
        totals(budget)
        old = [a for a in budget['runtimeAllocations'] if a['id'] == HOLD]
        if len(old) != 1:
            reject('missing_old_hold')
        binding = old[0].get('admission', {})
        if any(binding.get(k) != v for k, v in {'kind': 'hermes_readonly_canary', 'runId': RUN, 'campaignId': RUN,
            'allocationId': ALLOCATION, 'ledgerPath': o['ledger'], 'capUsdExact': '5.000000000', 'draftPr': False}.items()):
            reject('old_hold_binding')
        # Original admission audits remain immutable evidence, including the exact hold.
        original_intent = snapshot(binding['auditRecord'])
        admitted = parse(original_intent['raw'])
        if admitted.get('afterSha256') != o.get('original_admission_after_sha256', '5860489e404f713a5da19f1feb961e02db060524b10e65bd399e73b4a96622a4'):
            reject('original_admission_hash')
        # Tests may supply their fixture hash via the API; CLI never exposes an override.
        if admitted.get('runId') != RUN or admitted.get('allocationId') != ALLOCATION or admitted.get('ledgerPath') != o['ledger']:
            reject('original_admission_binding')
        admission_after = snapshot(str(Path(binding['auditRecord']).with_name(RUN + '.after.json')))
        if admission_after['hash'] != admitted['afterSha256']:
            reject('original_admission_audit_changed')
        recovery = old[0].get('state') == 'reconciled_retained_charge'
        def transition(source, timestamp):
            b = parse(source)
            sums = totals(b)
            entry = next(a for a in b['runtimeAllocations'] if a['id'] == HOLD)
            if entry.get('state') != 'held_for_readonly_canary' or nanos(entry.get('amountUsd')) != CAP or nanos(entry.get('retainedAmountUsd')) != CAP or nanos(entry.get('retiredUnusedAuthorizationUsd')) != 0 or nanos(entry.get('retainedUnknownCostsUsd')) != 0:
                reject('old_hold_not_unreconciled')
            if b.get('hermesPaidCalls') != 0:
                reject('paid_call_count_requires_review')
            if 'originalState' in entry or 'reconciliation' in entry:
                reject('old_hold_history_conflict')
            entry['originalState'] = entry['state']
            entry['state'] = 'reconciled_retained_charge'
            entry['retainedAmountUsd'] = money(CHARGED)
            entry['retiredUnusedAuthorizationUsd'] = money(RETIRED)
            entry['reconciliation'] = {'id': OPERATION, 'auditRecord': paths['intent'], 'evidenceSha256': proof_hash,
                'attemptId': 53, 'bookedChargeUsdExact': '0.004683000', 'unusedAuthorizationRetiredUsdExact': '4.995317000',
                'semantics': 'Retained conservative ledger charge, not a provider invoice. No request reservation refunded; old SQL cap, closed allocation, claim and all history remain unchanged.'}
            b['runtimeCommittedOrHeldUsd'] = money(sums['runtimeCommittedOrHeldUsd'] - RETIRED)
            b['runtimeUnallocatedUsd'] = money(sums['runtimeUnallocatedUsd'] + RETIRED)
            b['totalCommittedOrHeldUsd'] = money(sums['totalCommittedOrHeldUsd'] - RETIRED)
            b['runtimeAuthorizationRetiredUsd'] = money(sums['runtimeAuthorizationRetiredUsd'] + RETIRED)
            b['hermesPaidCalls'] = 1
            b['bookkeepingUpdatedAt'] = timestamp
            totals(b)
            return (encode(b) + '\n').encode()
        prior_intent_raw = None
        if recovery:
            original = snapshot(paths['before'])
            after = snapshot(paths['after'])
            prior_intent_raw = snapshot(paths['intent'])['raw']
            intent = parse(prior_intent_raw)
            if any(intent.get(k) != v for k, v in {'operation': OPERATION, 'runId': RUN, 'allocationId': ALLOCATION, 'aggregatePath': o['aggregate'], 'ledgerPath': o['ledger'], 'stateDbPath': o['state_db']}.items()):
                reject('recovery_intent_binding')
            if expected_hash not in (original['hash'], before['hash']) or before['hash'] != after['hash'] or intent.get('beforeSha256') != original['hash'] or intent.get('afterSha256') != after['hash'] or intent.get('evidenceSha256') != proof_hash or snapshot(paths['evidence'])['raw'] != proof_raw:
                reject('recovery_audit_changed')
            after_raw = transition(original['raw'], parse(after['raw'])['bookkeepingUpdatedAt'])
            if after_raw != after['raw']:
                reject('recovery_transition_changed')
        else:
            if before['hash'] != expected_hash or before['hash'] != admitted['afterSha256']:
                reject('aggregate_changed')
            original = before
            after_raw = transition(before['raw'], datetime.datetime.now(datetime.timezone.utc).isoformat())
            try:
                prepared = snapshot(paths['after'])
            except FileNotFoundError:
                prepared = None
            if prepared:
                candidate = transition(before['raw'], parse(prepared['raw'])['bookkeepingUpdatedAt'])
                if candidate != prepared['raw']:
                    reject('prepared_audit_conflict')
                after_raw = candidate
        intent_raw = (json.dumps({'schemaVersion': 1, 'operation': OPERATION, 'runId': RUN, 'allocationId': ALLOCATION,
            'aggregatePath': o['aggregate'], 'ledgerPath': o['ledger'], 'stateDbPath': o['state_db'], 'beforeSha256': original['hash'],
            'afterSha256': sha(after_raw), 'evidenceSha256': proof_hash, 'sourceMetadata': identity(original['stat']),
            'retainedUsdExact': '0.004683000', 'retiredUsdExact': '4.995317000', 'sqlWrites': False,
            'nextCanary': 'Separate NEW immutable campaign/allocation, at most USD5 inclusive across recovery and next canary calls; existing hold-first admission required.'}, indent=2) + '\n').encode()
        if prior_intent_raw is not None:
            intent_raw = prior_intent_raw
        result = {'applied': apply, 'recovery': recovery, 'beforeSha256': original['hash'], 'afterSha256': sha(after_raw),
            'retainedUsd': '0.004683000', 'retiredUsd': '4.995317000', 'runtimeHeldUsd': '8.692298006',
            'runtimeUnallocatedUsd': '51.307701994', 'totalHeldUsd': '48.692298006', 'unknownHoldsUsd': '4.444468350',
            'nextCanaryEnrolled': False}
        if not apply:
            return result
        try:
            os.mkdir(o['audit_dir'], 0o700)
            fsync_dir(Path(o['audit_dir']).parent)
        except FileExistsError:
            pass
        audit_stat = os.lstat(o['audit_dir'])
        if not stat.S_ISDIR(audit_stat.st_mode) or audit_stat.st_uid != os.getuid() or audit_stat.st_mode & 0o077:
            reject('unsafe_audit_directory')
        for name, raw in [('before', original['raw']), ('after', after_raw), ('evidence', proof_raw), ('intent', intent_raw)]:
            write_once(paths[name], raw)
        hook('audit_prepared')
        if evidence(o['ledger'], o['state_db']) != proof or not unchanged(before, snapshot(o['aggregate'])):
            reject('evidence_or_aggregate_changed')
        if not recovery:
            temporary = o['aggregate'] + '.' + str(uuid.uuid4()) + '.tmp'
            try:
                write_new(temporary, after_raw, stat.S_IMODE(before['stat'].st_mode))
                fd = os.open(temporary, os.O_WRONLY | os.O_NOFOLLOW)
                try:
                    os.fchmod(fd, stat.S_IMODE(before['stat'].st_mode))
                    os.fchown(fd, before['stat'].st_uid, before['stat'].st_gid)
                    os.fsync(fd)
                finally:
                    os.close(fd)
                if evidence(o['ledger'], o['state_db']) != proof or not unchanged(before, snapshot(o['aggregate'])):
                    reject('evidence_or_aggregate_changed')
                os.replace(temporary, o['aggregate'])
                fsync_dir(Path(o['aggregate']).parent)
            finally:
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    pass
        hook('retirement_durable')
        if snapshot(o['aggregate'])['hash'] != sha(after_raw) or evidence(o['ledger'], o['state_db']) != proof:
            reject('verification_failed')
        write_once(paths['verified'], (json.dumps({'operation': OPERATION, 'afterSha256': sha(after_raw),
            'evidenceSha256': proof_hash, 'allSpendRowsUnchanged': True, 'oldClaimUnchanged': True}, indent=2) + '\n').encode())
        return result
    finally:
        if owned:
            current = os.lstat(lock)
            if (current.st_dev, current.st_ino) != (owned.st_dev, owned.st_ino) or snapshot(str(Path(lock) / 'claim.json'))['raw'] != claim:
                reject('lock_identity_changed')
            os.unlink(Path(lock) / 'claim.json')
            os.rmdir(lock)
            fsync_dir(Path(lock).parent)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ('aggregate', 'ledger', 'state-db', 'audit-dir', 'expected-sha256'):
        parser.add_argument('--' + flag, required=True)
    parser.add_argument('--apply', action='store_true')
    print(json.dumps(reconcile(vars(parser.parse_args())), indent=2))
