# Local Gemini credential setup

This utility is prepared for the existing Windows processing computer. It does not
activate Gemini, call any API, modify worker configuration, or set an environment variable.

Run `setup-imo3d-gemini-credential.ps1` in Windows PowerShell with `-STA -NoProfile`.
Paste the Gemini / Google AI Studio API key into its masked field and click
**Save securely**. Cancel or closing the form leaves the existing key unchanged.
Never put a real key in a command, conversation, screenshot, `.env`, or Git commit.

The encrypted file is `%LOCALAPPDATA%\BMK-IMO3D\secrets\gemini-api-key.dpapi`.
Storage rejects repository, OneDrive, network, and reparse-point paths. Its ACL
allows the current Windows user and SYSTEM only, with inherited access disabled.
An atomic same-directory replacement preserves the previous key if a save fails.
No plaintext file or encryption master key is written.

Encryption uses Windows current-user DPAPI through `ConvertFrom-SecureString`
without `-Key` or `-SecureKey`, as documented by
[Microsoft](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/convertfrom-securestring).
The worker must run under that Windows account on that computer. This is not a
portable credential and does not configure Vercel, Supabase, or another computer.

For a safe presence/decryption check, run `imo3d-local-credential-bridge.ps1`
without `-PrivatePipe`. Its only output is `configured` and `decryptable` booleans;
it makes no network request and does not validate API permissions, billing, or quota.
Do not invoke the internal `-PrivatePipe` mode from a terminal or redirect it to a file.

Future local-worker code can use
`withLocalCredential('gemini-api-key', async secretBuffer => { /* private use */ })`
from `scripts/lib/imo3d-local-credentials.mjs`. The key crosses a captured private
child-process pipe in memory; stderr and detailed child errors are discarded.
Owned buffers are wiped after the callback. The consumer must not log, return,
retain, or serialize the buffer. If it converts the key to a JavaScript string or
an HTTP header, that additional memory cannot be reliably wiped by this loader.

This protects storage and prevents accidental logging; it does not isolate the
key from malware, administrators, or other programs running as the same Windows
user. Pasting uses the existing system clipboard, which this utility neither
reads programmatically nor clears. Avoid screenshots of other unmasked key pages.

Synthetic-only checks:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File tests/imo3d-local-credentials.test.ps1
powershell.exe -NoLogo -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File scripts/setup-imo3d-gemini-credential.ps1 -VerifyUi
node --test tests/imo3d-local-credentials.test.mjs
```

`-ExecutionPolicy Bypass` applies only to the launched PowerShell process. The
utility never changes the machine or account execution policy. `-VerifyUi`
constructs the masked controls without displaying a window or reading any key.
