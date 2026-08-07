param(
  [Parameter(Mandatory=$true)][string]$Executable,
  [Parameter(Mandatory=$true)][string]$Record,
  [int]$TimeoutMilliseconds = 7000
)
$ErrorActionPreference = "Stop"

if (-not ('PiConPty.Native' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace PiConPty {
  public static class Native {
    public const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    public const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    public const int PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016;
    public const uint WAIT_OBJECT_0 = 0;
    public const uint WAIT_TIMEOUT = 258;

    [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X; public short Y; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }
    [StructLayout(LayoutKind.Sequential)] public struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }

    [DllImport("kernel32.dll", SetLastError=true)] public static extern int CreatePseudoConsole(COORD size, IntPtr input, IntPtr output, uint flags, out IntPtr pseudoConsole);
    [DllImport("kernel32.dll")] public static extern void ClosePseudoConsole(IntPtr pseudoConsole);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] public static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);

    public static void Check(bool result, string operation) { if (!result) { int code = Marshal.GetLastWin32Error(); throw new Win32Exception(code, operation + " failed with Win32 error " + code); } }
  }
}
'@
}

$started = [Diagnostics.Stopwatch]::StartNew()
$inputServer = $null; $inputClient = $null; $outputServer = $null; $outputClient = $null
$pseudoConsole = [IntPtr]::Zero; $attributeList = [IntPtr]::Zero
$process = New-Object PiConPty.Native+PROCESS_INFORMATION
try {
  $inputServer = New-Object IO.Pipes.AnonymousPipeServerStream([IO.Pipes.PipeDirection]::Out, [IO.HandleInheritability]::None)
  $inputClient = New-Object IO.Pipes.AnonymousPipeClientStream([IO.Pipes.PipeDirection]::In, $inputServer.GetClientHandleAsString())
  $outputServer = New-Object IO.Pipes.AnonymousPipeServerStream([IO.Pipes.PipeDirection]::In, [IO.HandleInheritability]::None)
  $outputClient = New-Object IO.Pipes.AnonymousPipeClientStream([IO.Pipes.PipeDirection]::Out, $outputServer.GetClientHandleAsString())
  $size = New-Object PiConPty.Native+COORD; $size.X = 120; $size.Y = 40
  $hr = [PiConPty.Native]::CreatePseudoConsole($size, $inputClient.SafePipeHandle.DangerousGetHandle(), $outputClient.SafePipeHandle.DangerousGetHandle(), 0, [ref]$pseudoConsole)
  if ($hr -ne 0) { [Runtime.InteropServices.Marshal]::ThrowExceptionForHR($hr) }
  $attributeBytes = [IntPtr]::Zero
  [void][PiConPty.Native]::InitializeProcThreadAttributeList([IntPtr]::Zero, 1, 0, [ref]$attributeBytes)
  $attributeList = [Runtime.InteropServices.Marshal]::AllocHGlobal($attributeBytes)
  [PiConPty.Native]::Check([PiConPty.Native]::InitializeProcThreadAttributeList($attributeList, 1, 0, [ref]$attributeBytes), "InitializeProcThreadAttributeList")
  $pseudoValue = [Runtime.InteropServices.Marshal]::AllocHGlobal([IntPtr]::Size)
  [Runtime.InteropServices.Marshal]::WriteIntPtr($pseudoValue, $pseudoConsole)
  try { [PiConPty.Native]::Check([PiConPty.Native]::UpdateProcThreadAttribute($attributeList, 0, [IntPtr][PiConPty.Native]::PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, $pseudoValue, [IntPtr][IntPtr]::Size, [IntPtr]::Zero, [IntPtr]::Zero), "UpdateProcThreadAttribute") }
  finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($pseudoValue) }
  $startupInfo = New-Object PiConPty.Native+STARTUPINFO
  $startupInfo.cb = [Runtime.InteropServices.Marshal]::SizeOf([type][PiConPty.Native+STARTUPINFOEX])
  $startup = New-Object PiConPty.Native+STARTUPINFOEX
  $startup.StartupInfo = $startupInfo
  $startup.lpAttributeList = $attributeList
  $commandLine = New-Object Text.StringBuilder
  [void]$commandLine.Append('"').Append($Executable).Append('"')
  [PiConPty.Native]::Check([PiConPty.Native]::CreateProcessW($null, $commandLine, [IntPtr]::Zero, [IntPtr]::Zero, $false, [PiConPty.Native]::EXTENDED_STARTUPINFO_PRESENT -bor [PiConPty.Native]::CREATE_UNICODE_ENVIRONMENT, [IntPtr]::Zero, (Split-Path $Executable), [ref]$startup, [ref]$process), "CreateProcessW")
  [void][PiConPty.Native]::CloseHandle($process.hThread)
  $inputClient.Dispose(); $inputClient = $null; $outputClient.Dispose(); $outputClient = $null
  $firstByte = New-Object byte[] 1
  $firstRead = $outputServer.ReadAsync($firstByte, 0, 1)
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
  while (-not $firstRead.IsCompleted -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 25 }
  if (-not $firstRead.IsCompleted -or $firstRead.Result -ne 1) { throw "ConPTY produced no observable terminal output" }
  $reader = New-Object IO.StreamReader($outputServer, [Text.Encoding]::UTF8, $true, 4096, $true)
  $readTask = $reader.ReadToEndAsync()
  $input = [Text.Encoding]::UTF8.GetBytes("/exit`r")
  $inputServer.Write($input, 0, $input.Length); $inputServer.Flush()
  $remaining = [Math]::Max(1, $TimeoutMilliseconds - [int]$started.ElapsedMilliseconds)
  $wait = [PiConPty.Native]::WaitForSingleObject($process.hProcess, [uint32]$remaining)
  if ($wait -ne [PiConPty.Native]::WAIT_OBJECT_0) { throw "ConPTY child did not exit within ${TimeoutMilliseconds}ms" }
  $exitCode = 0
  [PiConPty.Native]::Check([PiConPty.Native]::GetExitCodeProcess($process.hProcess, [ref]$exitCode), "GetExitCodeProcess")
  $inputServer.Dispose(); $inputServer = $null
  [PiConPty.Native]::ClosePseudoConsole($pseudoConsole); $pseudoConsole = [IntPtr]::Zero
  [void]$readTask.Wait(1000)
  $output = [Text.Encoding]::UTF8.GetString($firstByte) + $(if ($readTask.IsCompleted) { $readTask.Result } else { "" })
  if ($exitCode -ne 0 -or $output.Length -eq 0) { throw "ConPTY acceptance failed: exit=$exitCode output=$($output.Length)" }
  $result = [ordered]@{ harness="Win32 ConPTY API"; elapsedMs=[int]$started.ElapsedMilliseconds; outputBytes=[Text.Encoding]::UTF8.GetByteCount($output); input="/exit\r"; childExitCode=[int]$exitCode; observedOutput=$true; exitSent=$true; cleanExit=$true }
  $result | ConvertTo-Json -Compress | Set-Content -LiteralPath $Record -Encoding utf8
  $result | ConvertTo-Json -Compress
} finally {
  if ($process.hProcess -ne [IntPtr]::Zero) { if ([PiConPty.Native]::WaitForSingleObject($process.hProcess, 0) -eq [PiConPty.Native]::WAIT_TIMEOUT) { [void][PiConPty.Native]::TerminateProcess($process.hProcess, 1) }; [void][PiConPty.Native]::CloseHandle($process.hProcess) }
  if ($attributeList -ne [IntPtr]::Zero) { [PiConPty.Native]::DeleteProcThreadAttributeList($attributeList); [Runtime.InteropServices.Marshal]::FreeHGlobal($attributeList) }
  if ($pseudoConsole -ne [IntPtr]::Zero) { [PiConPty.Native]::ClosePseudoConsole($pseudoConsole) }
  foreach ($stream in @($inputServer,$inputClient,$outputServer,$outputClient)) { if ($null -ne $stream) { $stream.Dispose() } }
}
