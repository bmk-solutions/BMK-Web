Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
    # Resolve the built-in module explicitly; inherited PSModulePath may point to PowerShell 7.
    Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -Force
}

function Assert-ImoCredentialWindows {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'credentials_windows_required' }
}

function Assert-ImoCredentialName([string] $Name) {
    if ($Name -cnotmatch '^[a-z][a-z0-9-]{0,47}$') { throw 'credentials_invalid_name' }
}

function Assert-ImoOrdinaryPath([string] $Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    if ($cursor.StartsWith('\\')) { throw 'credentials_local_path_required' }
    while ($cursor) {
        if ([IO.File]::Exists($cursor) -or [IO.Directory]::Exists($cursor)) {
            if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'credentials_reparse_path_rejected'
            }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function New-ImoCredentialAcl([bool] $Directory) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    if ($Directory) { $acl = New-Object Security.AccessControl.DirectorySecurity }
    else { $acl = New-Object Security.AccessControl.FileSecurity }
    $acl.SetOwner($identity)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($identity, $system)) {
        if ($Directory) {
            $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
        } else { $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow') }
        $acl.AddAccessRule($rule)
    }
    return $acl
}

function Assert-ImoCredentialAcl([string] $Path) {
    Assert-ImoOrdinaryPath $Path
    $acl = Get-Acl -LiteralPath $Path
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $identity) {
        throw 'credentials_permissions_rejected'
    }
    $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    $hasOwner = $false
    foreach ($rule in $rules) {
        if ($rule.IdentityReference.Value -notin @($identity, 'S-1-5-18')) { throw 'credentials_permissions_rejected' }
        if ($rule.IdentityReference.Value -eq $identity -and $rule.AccessControlType -eq 'Allow') { $hasOwner = $true }
    }
    if (-not $hasOwner) { throw 'credentials_permissions_rejected' }
}

function Get-ImoCredentialDirectory([switch] $Create) {
    Assert-ImoCredentialWindows
    $local = [IO.Path]::GetFullPath([Environment]::GetFolderPath('LocalApplicationData'))
    if (-not [IO.Directory]::Exists($local)) { throw 'credentials_local_profile_required' }
    $directory = Join-Path (Join-Path $local 'BMK-IMO3D') 'secrets'
    $repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    foreach ($excluded in @($repo, $env:OneDrive, $env:OneDriveCommercial, $env:OneDriveConsumer)) {
        if ($excluded) {
            $prefix = [IO.Path]::GetFullPath($excluded).TrimEnd('\') + '\'
            if (($directory + '\').StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'credentials_synced_path_rejected' }
        }
    }
    Assert-ImoOrdinaryPath $directory
    if ($Create) {
        foreach ($path in @((Split-Path $directory -Parent), $directory)) {
            if (-not [IO.Directory]::Exists($path)) {
                $null = [IO.Directory]::CreateDirectory($path, (New-ImoCredentialAcl $true))
            }
        }
    }
    if ([IO.Directory]::Exists($directory)) { Assert-ImoCredentialAcl $directory }
    return $directory
}

function Get-ImoCredentialPath([string] $Name, [switch] $Create) {
    Assert-ImoCredentialName $Name
    $directory = Get-ImoCredentialDirectory -Create:$Create
    $path = Join-Path $directory ($Name + '.dpapi')
    Assert-ImoOrdinaryPath $path
    if ([IO.File]::Exists($path)) { Assert-ImoCredentialAcl $path }
    return $path
}

function Save-ImoLocalCredential {
    param([Parameter(Mandatory)][string] $Name, [Parameter(Mandatory)][Security.SecureString] $Secret)
    Assert-ImoCredentialWindows
    if ($Secret.Length -lt 1 -or $Secret.Length -gt 8192) { throw 'credentials_invalid_length' }
    # No Key/SecureKey parameter: Windows DPAPI binds encryption to this user.
    $ciphertext = ConvertFrom-SecureString -SecureString $Secret
    $bytes = [Text.Encoding]::ASCII.GetBytes($ciphertext)
    $temporary = $null
    try {
        $path = Get-ImoCredentialPath $Name -Create
        $temporary = Join-Path (Split-Path $path -Parent) ('.pending-' + [Guid]::NewGuid().ToString('N'))
        $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            Set-Acl -LiteralPath $temporary -AclObject (New-ImoCredentialAcl $false)
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        } finally { $stream.Dispose() }
        Assert-ImoCredentialAcl $temporary
        $null = Get-ImoCredentialPath $Name
        # Same-directory atomic commit; failure leaves the existing credential intact.
        if ([IO.File]::Exists($path)) { [IO.File]::Replace($temporary, $path, [Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary, $path) }
        $temporary = $null
    } finally {
        [Array]::Clear($bytes, 0, $bytes.Length)
        $ciphertext = $null
        if ($temporary -and [IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

function Read-ImoLocalCredential {
    param([Parameter(Mandatory)][string] $Name)
    $path = Get-ImoCredentialPath $Name
    if (-not [IO.File]::Exists($path)) { throw 'credentials_not_configured' }
    $file = Get-Item -LiteralPath $path
    if ($file.Length -lt 1 -or $file.Length -gt 131072) { throw 'credentials_invalid_file' }
    $ciphertext = [IO.File]::ReadAllText($path, [Text.Encoding]::ASCII)
    try {
        $secret = ConvertTo-SecureString -String $ciphertext
        if ($secret.Length -lt 1 -or $secret.Length -gt 8192) { $secret.Dispose(); throw 'credentials_invalid_length' }
        return $secret
    } finally { $ciphertext = $null }
}

Export-ModuleMember -Function Save-ImoLocalCredential, Read-ImoLocalCredential, Get-ImoCredentialPath
