Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
Import-Module (Join-Path $PSScriptRoot '../scripts/lib/imo3d-local-credentials.psm1') -Force
$name = 'test-' + [Guid]::NewGuid().ToString('N')
$path = $null
$first = ConvertTo-SecureString 'synthetic-first-value' -AsPlainText -Force
$second = ConvertTo-SecureString 'synthetic-second-value' -AsPlainText -Force
function Assert-Test([bool] $Condition) { if (-not $Condition) { throw 'synthetic_credential_test_failed' } }
function Assert-DummyValue([string] $Expected) {
    $secure = Read-ImoLocalCredential -Name $name
    $pointer = [IntPtr]::Zero
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        Assert-Test ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) -ceq $Expected)
    } finally {
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        $secure.Dispose()
    }
}
try {
    Save-ImoLocalCredential -Name $name -Secret $first
    $path = Get-ImoCredentialPath $name
    Assert-Test ($path.StartsWith([Environment]::GetFolderPath('LocalApplicationData') + '\BMK-IMO3D\secrets\'))
    Assert-Test (-not [IO.File]::ReadAllText($path).Contains('synthetic-first-value'))
    Assert-DummyValue 'synthetic-first-value'
    $acl = Get-Acl -LiteralPath $path
    Assert-Test $acl.AreAccessRulesProtected
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        Assert-Test ($rule.IdentityReference.Value -in @($identity, 'S-1-5-18'))
    }
    Save-ImoLocalCredential -Name $name -Secret $second
    Assert-DummyValue 'synthetic-second-value'
    $empty = New-Object Security.SecureString
    $rejected = $false
    try { Save-ImoLocalCredential -Name $name -Secret $empty } catch { $rejected = $true } finally { $empty.Dispose() }
    Assert-Test $rejected
    Assert-DummyValue 'synthetic-second-value'
    $wideAcl = [IO.File]::GetAccessControl($path, [Security.AccessControl.AccessControlSections]::Access)
    $everyone = New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
    $extraRule = New-Object Security.AccessControl.FileSystemAccessRule($everyone, 'Read', 'Allow')
    $wideAcl.AddAccessRule($extraRule)
    try {
        [IO.File]::SetAccessControl($path, $wideAcl)
        $rejected = $false
        try { $unexpected = Read-ImoLocalCredential -Name $name; $unexpected.Dispose() } catch { $rejected = $true }
        Assert-Test $rejected
    } finally {
        $wideAcl.RemoveAccessRuleSpecific($extraRule)
        [IO.File]::SetAccessControl($path, $wideAcl)
    }
    Assert-DummyValue 'synthetic-second-value'
    $lock = [IO.File]::Open($path, 'Open', 'Read', 'None')
    $rejected = $false
    try { Save-ImoLocalCredential -Name $name -Secret $first } catch { $rejected = $true } finally { $lock.Dispose() }
    Assert-Test $rejected
    Assert-DummyValue 'synthetic-second-value'
    foreach ($invalid in @('../escape', 'bad/name', 'UPPER', ('x' * 49))) {
        $rejected = $false
        try { $null = Get-ImoCredentialPath $invalid } catch { $rejected = $true }
        Assert-Test $rejected
    }
    $tokens = $null; $errors = $null
    $uiPath = Join-Path $PSScriptRoot '../scripts/setup-imo3d-gemini-credential.ps1'
    $null = [Management.Automation.Language.Parser]::ParseFile($uiPath, [ref]$tokens, [ref]$errors)
    Assert-Test ($errors.Count -eq 0)
    $ui = [IO.File]::ReadAllText($uiPath)
    Assert-Test ($ui.Contains('Windows.Controls.PasswordBox') -and $ui.Contains('$entry.SecurePassword'))
    Assert-Test (-not $ui.Contains('$entry.Password'))
    Write-Output 'PASS: DPAPI roundtrip; encrypted disk storage; restrictive ACL and unsafe-ACL rejection; atomic replacement; failed/empty save preserves prior value; name validation; masked UI syntax.'
} finally {
    $first.Dispose(); $second.Dispose()
    if ($path -and (Split-Path $path -Leaf) -ceq ($name + '.dpapi') -and [IO.File]::Exists($path)) {
        [IO.File]::Delete($path)
    }
}
