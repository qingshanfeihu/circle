## Install

macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/@REPO@/@TAG@/install.sh | CIRCLE_VERSION=@VERSION@ bash
```

Windows, in PowerShell:

```powershell
$env:CIRCLE_VERSION = '@VERSION@'; irm https://raw.githubusercontent.com/@REPO@/@TAG@/install.ps1 | iex
```

Already installed? Run `circle update`.
