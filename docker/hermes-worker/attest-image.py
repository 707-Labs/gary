"""Review-only observation, same canonical records as source-attestation.ts."""
import hashlib
import json
from pathlib import Path
import stat

root = Path('/opt/gary-hermes-runtime')
records = []
def visit(relative):
    path = root / relative
    metadata = path.lstat()
    assert not path.is_symlink()
    if stat.S_ISDIR(metadata.st_mode):
        records.append(['directory', relative])
        for child in sorted(path.iterdir(), key=lambda p: p.name.encode()):
            visit(relative + '/' + child.name)
    else:
        assert stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1
        data = path.read_bytes()
        records.append(['file', relative, len(data), 1 if metadata.st_mode & 0o111 else 0, hashlib.sha256(data).hexdigest()])
visit('python/gary_runtime.py')
visit('vendor/hermes')
records.sort(key=lambda row: row[1].encode())
scope = 'gary-hermes-wrapper-and-archive-v1'
encoded = json.dumps(records, ensure_ascii=False, separators=(',', ':')).encode()
print(json.dumps({'status': 'review-only-unapproved', 'scope': scope,
                  'digest': 'sha256:' + hashlib.sha256(scope.encode() + b'\0' + encoded).hexdigest(),
                  'files': sum(row[0] == 'file' for row in records),
                  'wrapperSha256': hashlib.sha256((root / 'python/gary_runtime.py').read_bytes()).hexdigest(),
                  'archiveSha256': '9551e0c2ea7c6feaea6d03362fb1344af7742bfb4980397bcfecffcdf2f427fb',
                  'caseCollisionPreserved': True}, sort_keys=True))
