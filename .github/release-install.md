## Install

macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/@REPO@/@TAG@/install.sh | CIRCLE_VERSION=@VERSION@ bash
```

Windows, in PowerShell:

```powershell
$env:CIRCLE_VERSION = '@VERSION@'; irm https://raw.githubusercontent.com/@REPO@/@TAG@/install.ps1 | iex
```

Already on 1.0 or later? Run `circle update`.

Coming from Circle 0.5.0 or older, the Python version: its `circle update` cannot install this release and reports a missing file. Run the install command above instead. It removes the Python version, keeps your settings, keys and sessions, and installs this one in its place.
