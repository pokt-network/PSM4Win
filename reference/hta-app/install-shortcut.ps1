# Creates "Pocket Service Manager" shortcuts with the Pocket icon.
# Default targets: the Desktop and the Start menu Programs folder. Run via install-shortcut.cmd.
param([string[]]$Dirs = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')))

$here = $PSScriptRoot
$hta = Join-Path $here 'PocketServiceManager.hta'
$ico = Join-Path $here 'assets\pocket.ico'
if (-not (Test-Path $hta)) { Write-Error "PocketServiceManager.hta not found next to this script."; exit 1 }
if (-not (Test-Path $ico)) { Write-Error "assets\pocket.ico not found next to this script."; exit 1 }

# The shortcut carries the same AppUserModelID the running window declares
# (see winshell.ps1), so the taskbar groups them and pinning works properly.
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Runtime.InteropServices.ComTypes;
[StructLayout(LayoutKind.Sequential, Pack = 4)] public struct PROPERTYKEY2 { public Guid fmtid; public uint pid; public PROPERTYKEY2(Guid f, uint p) { fmtid = f; pid = p; } }
[StructLayout(LayoutKind.Explicit, Size = 24)] public struct PROPVARIANT2 { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; [FieldOffset(16)] public IntPtr p2; }
[ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore2 { int GetCount(out uint c); int GetAt(uint i, out PROPERTYKEY2 k); int GetValue(ref PROPERTYKEY2 k, out PROPVARIANT2 v); int SetValue(ref PROPERTYKEY2 k, ref PROPVARIANT2 v); int Commit(); }
[ComImport, Guid("00021401-0000-0000-C000-000000000046")] public class ShellLinkCo { }
public class LnkId {
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT2 v);
  public static void Set(string lnkPath, string appId) {
    object link = new ShellLinkCo();
    var pf = (IPersistFile)link; pf.Load(lnkPath, 2);
    var ps = (IPropertyStore2)link;
    var key = new PROPERTYKEY2(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);
    var v = new PROPVARIANT2(); v.vt = 31; v.p = Marshal.StringToCoTaskMemUni(appId);
    int hr = ps.SetValue(ref key, ref v); if (hr != 0) throw new Exception("SetValue failed 0x" + hr.ToString("X"));
    ps.Commit(); PropVariantClear(ref v);
    pf.Save(lnkPath, true);
    Marshal.ReleaseComObject(link);
  }
}
"@

$ws = New-Object -ComObject WScript.Shell
foreach ($dir in $Dirs) {
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    $path = Join-Path $dir 'Pocket Service Manager.lnk'
    $lnk = $ws.CreateShortcut($path)
    $lnk.TargetPath = Join-Path $env:WINDIR 'System32\mshta.exe'
    $lnk.Arguments = '"' + $hta + '"'
    $lnk.WorkingDirectory = $here
    $lnk.IconLocation = $ico + ',0'
    $lnk.Description = 'Pocket Service Manager'
    $lnk.Save()
    try { [LnkId]::Set($path, 'PocketNetwork.ServiceManager') } catch { Write-Warning ("Could not set the app identity on the shortcut: " + $_.Exception.Message) }
    Write-Host ("Created " + $path)
}
