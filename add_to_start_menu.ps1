$WshShell = New-Object -ComObject WScript.Shell
$StartMenuPath = [System.IO.Path]::Combine($env:APPDATA, "Microsoft\Windows\Start Menu\Programs")
$ElectronPath = "C:\Users\admin\LeelaV1\node_modules\electron\dist\electron.exe"
$ProjectPath = "C:\Users\admin\LeelaV1"

# 1. Main App Shortcut
$ShortcutPath = [System.IO.Path]::Combine($StartMenuPath, "Leela V1.lnk")
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $ElectronPath
$Shortcut.Arguments = "`"$ProjectPath`""
$Shortcut.WorkingDirectory = $ProjectPath
$Shortcut.IconLocation = "C:\Windows\System32\shell32.dll, 24"
$Shortcut.Save()

# 2. Dashboard Shortcut
$DashShortcutPath = [System.IO.Path]::Combine($StartMenuPath, "Leela Dashboard.lnk")
$DashShortcut = $WshShell.CreateShortcut($DashShortcutPath)
$DashShortcut.TargetPath = $ElectronPath
$DashShortcut.Arguments = "`"$ProjectPath`" --dashboard"
$DashShortcut.WorkingDirectory = $ProjectPath
$DashShortcut.IconLocation = "C:\Windows\System32\shell32.dll, 21"
$DashShortcut.Save()

Write-Host "Shortcuts created in Start Menu:"
Write-Host " - Leela V1 (Main App)"
Write-Host " - Leela Dashboard (Settings & History)"
