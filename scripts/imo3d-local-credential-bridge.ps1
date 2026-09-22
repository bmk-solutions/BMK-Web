# Internal local worker bridge. Default mode reports booleans only.
# -PrivatePipe is exclusively for a child process whose stdout is captured in memory.
param([string] $Name = 'gemini-api-key', [switch] $PrivatePipe, [switch] $Diagnostics)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$secret = $null; $pointer = [IntPtr]::Zero; $characters = $null; $bytes = $null
$configured = $false
try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'unsupported' }
    if ($PrivatePipe -and -not [Console]::IsOutputRedirected) { throw 'private_pipe_required' }
    Import-Module (Join-Path $PSScriptRoot 'lib/imo3d-local-credentials.psm1') -Force
    $path = Get-ImoCredentialPath -Name $Name
    $configured = [IO.File]::Exists($path)
    if (-not $configured) {
        if (-not $PrivatePipe) { [Console]::WriteLine('{"configured":false,"decryptable":false}') }
        exit 2
    }
    $secret = Read-ImoLocalCredential -Name $Name
    if (-not $PrivatePipe) {
        [Console]::WriteLine('{"configured":true,"decryptable":true}')
    } else {
        # No PowerShell pipeline/Write-Output/string interpolation contains plaintext.
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
        $characters = New-Object char[] $secret.Length
        for ($index = 0; $index -lt $secret.Length; $index++) {
            $characters[$index] = [char]([int][Runtime.InteropServices.Marshal]::ReadInt16($pointer, 2 * $index) -band 65535)
        }
        $bytes = [Text.Encoding]::UTF8.GetBytes($characters)
        $stream = [Console]::OpenStandardOutput()
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
    }
    exit 0
} catch {
    if ($Diagnostics -and -not $PrivatePipe) {
        $reason = 'private_storage_unavailable'
        if ($_.Exception.Message -cmatch '^credentials_[a-z_]+$') { $reason = $_.Exception.Message }
        [Console]::WriteLine((@{configured=$configured;decryptable=$false;diagnostic=$reason} | ConvertTo-Json -Compress))
        exit 2
    }
    if (-not $PrivatePipe) {
        if ($configured) { [Console]::WriteLine('{"configured":true,"decryptable":false}') }
        else { [Console]::WriteLine('{"configured":false,"decryptable":false}') }
    }
    exit 2
} finally {
    if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    if ($characters) { [Array]::Clear($characters, 0, $characters.Length) }
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    if ($secret) { $secret.Dispose() }
}
