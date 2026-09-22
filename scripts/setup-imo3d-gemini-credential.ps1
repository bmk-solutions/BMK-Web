# Run locally as the same Windows user as the IMO 3D processing worker.
# No credential is accepted as an argument, copied to the clipboard, or printed.
param([switch] $VerifyUi)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
        [Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') { exit 2 }
    Import-Module (Join-Path $PSScriptRoot 'lib/imo3d-local-credentials.psm1') -Force
    Add-Type -AssemblyName PresentationFramework
    $window = New-Object Windows.Window
    $window.Title = 'IMO 3D - Private Gemini key'
    $window.Width = 520; $window.Height = 350
    $window.ResizeMode = 'NoResize'; $window.WindowStartupLocation = 'CenterScreen'
    $window.Topmost = $true
    $panel = New-Object Windows.Controls.StackPanel
    $panel.Margin = '24'
    $panel.FlowDirection = 'RightToLeft'
    $window.Content = $panel
    $title = New-Object Windows.Controls.TextBlock
    $title.Text = 'مفتاح Google Gemini / AI Studio'
    $title.FontSize = 20; $title.FontWeight = 'SemiBold'; $title.Margin = '0,0,0,12'
    $null = $panel.Children.Add($title)
    $description = New-Object Windows.Controls.TextBlock
    $description.Text = 'الصق المفتاح هنا فقط. يُحفظ مشفّرًا على هذا الجهاز خارج المشروع وOneDrive. الحفظ لا يرسل المفتاح ولا يختبره لدى Google.'
    $description.TextWrapping = 'Wrap'; $description.Margin = '0,0,0,18'
    $null = $panel.Children.Add($description)
    $entry = New-Object Windows.Controls.PasswordBox
    $entry.FlowDirection = 'LeftToRight'
    $entry.MaxLength = 8192; $entry.FontSize = 18; $entry.Padding = '8'
    $null = $panel.Children.Add($entry)
    $status = New-Object Windows.Controls.TextBlock
    $status.Margin = '0,10,0,8'; $status.TextWrapping = 'Wrap'
    $null = $panel.Children.Add($status)
    $buttons = New-Object Windows.Controls.StackPanel
    $buttons.Orientation = 'Horizontal'; $buttons.HorizontalAlignment = 'Right'
    $null = $panel.Children.Add($buttons)
    $cancel = New-Object Windows.Controls.Button
    $cancel.Content = 'إلغاء'; $cancel.Width = 90; $cancel.Height = 34; $cancel.Margin = '0,0,10,0'
    $cancel.IsCancel = $true
    $cancel.Add_Click({ $window.Close() })
    $null = $buttons.Children.Add($cancel)
    $save = New-Object Windows.Controls.Button
    $save.Content = 'حفظ بأمان'; $save.Width = 130; $save.Height = 34; $save.IsDefault = $true
    $null = $buttons.Children.Add($save)
    $save.Add_Click({
        $secure = $entry.SecurePassword
        try {
            if ($secure.Length -eq 0) { $status.Text = 'أدخل المفتاح أو اضغط إلغاء.'; return }
            Save-ImoLocalCredential -Name 'gemini-api-key' -Secret $secure
            $entry.Clear()
            $window.DialogResult = $true
            $window.Close()
        } catch {
            $status.Text = 'تعذّر حفظ المفتاح بأمان. لم يُعرض المفتاح. أغلق النافذة وأبلغنا بمشكلة الحفظ.'
        } finally { $secure.Dispose() }
    })
    $window.Add_ContentRendered({ $null = $entry.Focus() })
    if ($VerifyUi) { $entry.Clear(); $window.Close(); exit 0 }
    $null = $window.ShowDialog()
    $entry.Clear()
    exit 0
} catch { exit 2 }
