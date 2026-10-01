"""Run the existing installer against a local release archive, without network."""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile


def main() -> None:
    archive = Path(sys.argv[1]).resolve()
    version = sys.argv[2]
    root = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix='circle-install-smoke-') as directory:
        scratch = Path(directory)
        commands = scratch / 'commands'
        commands.mkdir()
        # Only the transport is replaced. The production installer performs its
        # ordinary detection, unpacking, symlink and shell configuration steps.
        curl = commands / 'curl'
        curl.write_text('#!/bin/sh\n[ "$1" = "-fsSL" ] || exit 2\n'
                        '[ "$3" = "-o" ] || exit 2\n'
                        'case "$2" in\n'
                        '  "https://github.com/qingshanfeihu/circle/releases/download/v' + version + '/"' + archive.name + ') cp "$CIRCLE_SMOKE_ARCHIVE" "$4" ;;\n'
                        '  *) exit 2 ;;\nesac\n')
        curl.chmod(0o755)
        env = dict(os.environ, HOME=str(scratch), SHELL='/bin/bash',
                   PATH=str(commands) + os.pathsep + os.environ['PATH'],
                   CIRCLE_SMOKE_ARCHIVE=str(archive), CIRCLE_VERSION=version,
                   CIRCLE_BIN_DIR=str(scratch / 'bin'), CIRCLE_PREFIX=str(scratch / 'prefix'),
                   CIRCLE_HOME=str(scratch / 'home'))
        for _ in range(2):
            subprocess.run(['bash', str(root / 'install.sh')], cwd=scratch, env=env, check=True, timeout=60)
        assert (scratch / '.bashrc').read_text().count('# circle path') == 1
        subprocess.run([sys.executable, str(root / 'scripts/smoke_release.py'),
                        str(scratch / 'bin/circle'), version], env=env, check=True, timeout=120)
        print('archive install and repeat install passed')


if __name__ == '__main__':
    main()
