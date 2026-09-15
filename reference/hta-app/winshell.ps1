<#
Window-shell helper for PocketServiceManager.hta.

The app draws its own title bar. In IE11 document mode (which the app needs for
its scripting and layout) mshta ignores the hta:application caption/border
attributes, so the native frame is removed here with Win32 after the window
exists. The taskbar icon and identity are set through the window's property
store (AppUserModelID + relaunch icon), which is what Windows uses for pinned
apps and survives this helper exiting. Minimise and maximise are here too
because an HTA cannot minimise itself and needs the monitor work area to
maximise correctly on multi-monitor setups.

  winshell.ps1 -Op frameless   strip the native frame, set identity and icon, then stay
                               alive hidden to keep the icon handle valid (-NoHold to skip)
  winshell.ps1 -Op minimize    minimise the app window
  winshell.ps1 -Op maximize    fill the work area of the monitor the window is on
  winshell.ps1 -Op props       print the identity properties (diagnostics)
#>
param([Parameter(Mandatory = $true)][ValidateSet('frameless', 'minimize', 'maximize', 'props')][string]$Op, [string]$Title = 'Pocket Service Manager', [switch]$NoHold)

$AppId = 'PocketNetwork.ServiceManager'

Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
[StructLayout(LayoutKind.Sequential, Pack = 4)] public struct PROPERTYKEY { public Guid fmtid; public uint pid; public PROPERTYKEY(Guid f, uint p) { fmtid = f; pid = p; } }
[StructLayout(LayoutKind.Explicit, Size = 24)] public struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; [FieldOffset(16)] public IntPtr p2; }
[ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore {
  int GetCount(out uint c); int GetAt(uint i, out PROPERTYKEY k); int GetValue(ref PROPERTYKEY k, out PROPVARIANT v);
  int SetValue(ref PROPERTYKEY k, ref PROPVARIANT v); int Commit();
}
public class PSMShell {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l); delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int idx, int val);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr h, ref Guid iid, out IPropertyStore ps);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr LoadImage(IntPtr hinst, string name, uint type, int cx, int cy, uint load);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT v);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public uint cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  static readonly Guid AppModel = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
  public static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (found != IntPtr.Zero || !IsWindowVisible(h)) return true;
      var t = new StringBuilder(256); GetWindowText(h, t, 256);
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      if (t.ToString() == title && c.ToString() == "HTML Application Host Window Class") found = h;
      return true;
    }, IntPtr.Zero);
    return found;
  }
  static IPropertyStore Store(IntPtr h) {
    Guid iid = typeof(IPropertyStore).GUID; IPropertyStore ps;
    int hr = SHGetPropertyStoreForWindow(h, ref iid, out ps);
    if (hr != 0) throw new Exception("SHGetPropertyStoreForWindow failed: 0x" + hr.ToString("X"));
    return ps;
  }
  public static void SetProp(IntPtr h, uint pid, string value) {
    var ps = Store(h);
    var key = new PROPERTYKEY(AppModel, pid);
    var v = new PROPVARIANT(); v.vt = 31; v.p = Marshal.StringToCoTaskMemUni(value);
    try { int hr = ps.SetValue(ref key, ref v); if (hr != 0) throw new Exception("SetValue failed: 0x" + hr.ToString("X")); ps.Commit(); }
    finally { PropVariantClear(ref v); Marshal.ReleaseComObject(ps); }
  }
  public static string GetProp(IntPtr h, uint pid) {
    var ps = Store(h);
    var key = new PROPERTYKEY(AppModel, pid);
    PROPVARIANT v;
    try { ps.GetValue(ref key, out v); string s = v.vt == 31 ? Marshal.PtrToStringUni(v.p) : "(vt=" + v.vt + ")"; PropVariantClear(ref v); return s; }
    finally { Marshal.ReleaseComObject(ps); }
  }
}
"@

$h = [IntPtr]::Zero
for ($i = 0; $i -lt 40 -and $h -eq [IntPtr]::Zero; $i++) { $h = [PSMShell]::Find($Title); if ($h -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100 } }
if ($h -eq [IntPtr]::Zero) { Write-Output "window not found"; exit 1 }

# AppUserModel property ids: 2 RelaunchCommand, 3 RelaunchIconResource, 4 RelaunchDisplayNameResource, 5 ID
$hta = Join-Path $PSScriptRoot 'PocketServiceManager.hta'
$ico = Join-Path $PSScriptRoot 'assets\pocket.ico'

switch ($Op) {
  'frameless' {
    $GWL_STYLE = -16
    $WS_CAPTION = 0x00C00000; $WS_THICKFRAME = 0x00040000; $WS_MAXIMIZEBOX = 0x00010000; $WS_SYSMENU = 0x00080000
    $style = [PSMShell]::GetWindowLong($h, $GWL_STYLE)
    # Keep MINIMIZEBOX so the taskbar button can still minimise the window.
    $style = $style -band (-bnot ($WS_CAPTION -bor $WS_THICKFRAME -bor $WS_MAXIMIZEBOX -bor $WS_SYSMENU))
    [void][PSMShell]::SetWindowLong($h, $GWL_STYLE, $style)
    [void][PSMShell]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 0x0027)   # NOSIZE|NOMOVE|NOZORDER|FRAMECHANGED
    # Nudge the size so the document re-lays out into the space the frame occupied.
    $r = New-Object PSMShell+RECT; [void][PSMShell]::GetWindowRect($h, [ref]$r)
    $w = $r.R - $r.L; $hh = $r.B - $r.T
    [void][PSMShell]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, $w + 1, $hh + 1, 0x0006)  # NOMOVE|NOZORDER
    [void][PSMShell]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, $w, $hh, 0x0006)
    # Identity: the taskbar shows the relaunch icon for this window and groups it with the shortcut of the same ID.
    try {
      [PSMShell]::SetProp($h, 5, $AppId)
      [PSMShell]::SetProp($h, 2, ('"' + (Join-Path $env:WINDIR 'System32\mshta.exe') + '" "' + $hta + '"'))
      [PSMShell]::SetProp($h, 3, ($ico + ',0'))
      [PSMShell]::SetProp($h, 4, 'Pocket Service Manager')
      Write-Output "identity set"
    } catch { Write-Output ("identity failed: " + $_.Exception.Message) }
    Write-Output "frameless"
    # Taskbar icon. In IE11 document mode the visible HTA window is a popup owned by a
    # hidden host window, and the taskbar reads the icon from that owner, so the icon
    # goes on both. An icon handle dies with the process that loaded it, so this
    # process stays alive (hidden, idle) until the window is gone.
    if (Test-Path $ico) {
      $IMAGE_ICON = 1; $LR_LOADFROMFILE = 0x10; $WM_SETICON = 0x80
      $small = [PSMShell]::LoadImage([IntPtr]::Zero, $ico, $IMAGE_ICON, [PSMShell]::GetSystemMetrics(49), [PSMShell]::GetSystemMetrics(50), $LR_LOADFROMFILE)
      $big = [PSMShell]::LoadImage([IntPtr]::Zero, $ico, $IMAGE_ICON, [PSMShell]::GetSystemMetrics(11), [PSMShell]::GetSystemMetrics(12), $LR_LOADFROMFILE)
      $targets = @($h)
      $owner = [PSMShell]::GetWindow($h, 4)   # GW_OWNER
      if ($owner -ne [IntPtr]::Zero) { $targets += $owner }
      foreach ($t in $targets) {
        if ($small -ne [IntPtr]::Zero) { [void][PSMShell]::SendMessage($t, $WM_SETICON, [IntPtr]0, $small) }
        if ($big -ne [IntPtr]::Zero) { [void][PSMShell]::SendMessage($t, $WM_SETICON, [IntPtr]1, $big) }
      }
      Write-Output ("icon " + $(if ($small -ne [IntPtr]::Zero -and $big -ne [IntPtr]::Zero) { 'set on ' + $targets.Count + ' windows, holding' } else { 'failed to load' }))
      if (-not $NoHold) { while ([PSMShell]::IsWindow($h)) { Start-Sleep -Seconds 2 } }
    }
  }
  'minimize' {
    [void][PSMShell]::ShowWindow($h, 6)
    Write-Output "minimized"
  }
  'maximize' {
    $m = [PSMShell]::MonitorFromWindow($h, 2)   # MONITOR_DEFAULTTONEAREST
    $mi = New-Object PSMShell+MONITORINFO; $mi.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($mi)
    [void][PSMShell]::GetMonitorInfo($m, [ref]$mi)
    $wa = $mi.rcWork
    [void][PSMShell]::SetWindowPos($h, [IntPtr]::Zero, $wa.L, $wa.T, ($wa.R - $wa.L), ($wa.B - $wa.T), 0x0004)   # NOZORDER
    Write-Output ("maximized to " + $wa.L + "," + $wa.T + " " + ($wa.R - $wa.L) + "x" + ($wa.B - $wa.T))
  }
  'props' {
    foreach ($k in 5, 2, 3, 4) { Write-Output ("pid " + $k + " = " + [PSMShell]::GetProp($h, [uint32]$k)) }
  }
}
