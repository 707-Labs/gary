"""Validate and extract only the pinned source, on a case-sensitive Linux FS."""
import hashlib
from pathlib import Path, PurePosixPath
import tarfile

archive = Path('/tmp/hermes-source.tar')
assert hashlib.sha256(archive.read_bytes()).hexdigest() == '9551e0c2ea7c6feaea6d03362fb1344af7742bfb4980397bcfecffcdf2f427fb'
root = Path('/opt/gary-hermes-runtime/vendor/hermes')
root.mkdir(parents=True)
with tarfile.open(archive) as tar:
    names = set()
    regular = 0
    for member in tar:
        name = member.name.rstrip('/')
        parts = PurePosixPath(name).parts
        assert name and not name.startswith('/') and '\\' not in name and all(p not in ('.', '..', '') for p in parts)
        assert not any(ord(c) < 32 or ord(c) == 127 for c in name)
        assert name not in names and (member.isfile() or member.isdir()), name
        names.add(name)
        target = root / name
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            regular += 1
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as output:
                output.write(tar.extractfile(member).read())
            target.chmod(0o755 if member.mode & 0o111 else 0o644)
    assert regular == 9644
assert (root / 'contributors/emails/agent@Agents-Mac-mini.local').read_bytes() != (root / 'contributors/emails/agent@agents-Mac-mini.local').read_bytes()
assert hashlib.sha256((root / 'uv.lock').read_bytes()).hexdigest() == '8fd868b9da8b6bc2f4aa94a845e210eccdd5e31be7a0b404f0a8527ced0fddec'
