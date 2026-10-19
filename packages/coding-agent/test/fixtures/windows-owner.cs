// Compiled by windows-owner-runtime.mjs with Windows PowerShell's installed C# compiler.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Threading;
using System.Security.Principal;

public class OwnerFixture {
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long a,b; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct LIMIT { public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr a,b,c,d; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUP { public uint cb; public string reserved,desktop,title; public uint x,y,xx,yy,cx,cy,fill,flags; public ushort show,bytes; public IntPtr data,input,output,error; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS { public IntPtr process,thread; public uint pid,tid; }
    [DllImport("kernel32", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool inside);
    [DllImport("kernel32", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref LIMIT limits, uint size);
    [DllImport("kernel32", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, out LIMIT limits, uint size, IntPtr returned);
    [DllImport("kernel32", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string exe, string cmd, IntPtr sa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUP startup, out PROCESS process);
    [DllImport("advapi32", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int cls, out int info, int bytes, out int returned);
    [StructLayout(LayoutKind.Sequential)] struct COORD { public short X,Y; }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPEX { public STARTUP startup; public IntPtr attributes; }
    [DllImport("kernel32", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, IntPtr security, uint size);
    [DllImport("kernel32")] static extern int CreatePseudoConsole(COORD size, IntPtr input, IntPtr output, uint flags, out IntPtr console);
    [DllImport("kernel32")] static extern void ClosePseudoConsole(IntPtr console);
    [DllImport("kernel32", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, UIntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="CreateProcessW")] static extern bool CreateProcessEx(string exe, string cmd, IntPtr sa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPEX startup, out PROCESS process);
    [DllImport("kernel32", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr process, uint timeout);
    [DllImport("kernel32", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    static int Conpty(string owner, bool tui) {
        IntPtr inputRead,inputWrite,outputRead,outputWrite,console;
        Check(CreatePipe(out inputRead,out inputWrite,IntPtr.Zero,0));
        Check(CreatePipe(out outputRead,out outputWrite,IntPtr.Zero,0));
        if (CreatePseudoConsole(new COORD { X=100,Y=30 },inputRead,outputWrite,0,out console) != 0) throw new Exception("CreatePseudoConsole failed");
        CloseHandle(inputRead); CloseHandle(outputWrite);
        IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
        STARTUPEX startup = new STARTUPEX(); startup.startup.cb=(uint)Marshal.SizeOf(startup); startup.attributes=Marshal.AllocHGlobal(size);
        Check(InitializeProcThreadAttributeList(startup.attributes,1,0,ref size));
        Check(UpdateProcThreadAttribute(startup.attributes,0,new UIntPtr(0x20016),console,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
        PROCESS child;
        string command=tui ? "\""+owner+"\" --no-session --no-extensions --no-skills --no-prompt-templates --no-themes" : "\""+owner+"\" supervise -- \""+Exe+"\" console";
        Check(CreateProcessEx(owner,command,IntPtr.Zero,IntPtr.Zero,false,0x80000,IntPtr.Zero,null,ref startup,out child));
        DeleteProcThreadAttributeList(startup.attributes); Marshal.FreeHGlobal(startup.attributes); CloseHandle(child.thread);
        string output=""; object sync=new object();
        FileStream reader=new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(outputRead,true),FileAccess.Read);
        Thread reading=new Thread(delegate() { byte[] bytes=new byte[4096]; try { int count; while((count=reader.Read(bytes,0,bytes.Length))>0) { lock(sync) { output+=System.Text.Encoding.UTF8.GetString(bytes,0,count); } } } catch(IOException) {} }); reading.Start();
        DateTime deadline=DateTime.UtcNow.AddSeconds(5); bool ready=false;
        while(DateTime.UtcNow<deadline) { lock(sync) { ready=output.Contains(tui ? "\u001b[?2004h" : "console-ready"); } if(ready) break; Thread.Sleep(10); }
        bool survivedCtrlC=true;
        FileStream writer=new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(inputWrite,true),FileAccess.Write);
        writer.WriteByte(3); writer.Flush();
        if(tui) {
            Thread.Sleep(150); survivedCtrlC=WaitForSingleObject(child.process,0)==258;
            byte[] quit=System.Text.Encoding.UTF8.GetBytes("/quit\r"); writer.Write(quit,0,quit.Length); writer.Flush();
        }
        bool exited=WaitForSingleObject(child.process,8000)==0; uint code=0; if(exited) Check(GetExitCodeProcess(child.process,out code)); else TerminateProcess(child.process,98);
        writer.Dispose();
        CloseHandle(child.process); ClosePseudoConsole(console); reading.Join(5000); reader.Dispose();
        Console.WriteLine(output);
        Console.WriteLine("conpty-result ready="+ready+" survivedCtrlC="+survivedCtrlC+" exited="+exited+" code="+code);
        return ready && survivedCtrlC && exited && code==(tui ? 0u : 7u) && (tui || output.Contains("ctrl-c")) && !output.Contains("cleanup unconfirmed") ? 0 : 98;
    }
    static IntPtr nested;
    static void Check(bool ok) { if (!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
    static void Mark(string directory) { File.WriteAllText(Path.Combine(directory, Process.GetCurrentProcess().Id + ".pid"), "owned"); }
    static string Exe { get { return Process.GetCurrentProcess().MainModule.FileName; } }
    static void Spawn(string args, uint flags) {
        STARTUP startup = new STARTUP(); startup.cb = (uint)Marshal.SizeOf(startup);
        PROCESS child;
        Check(CreateProcess(Exe, "\"" + Exe + "\" " + args, IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, null, ref startup, out child));
        CloseHandle(child.thread); CloseHandle(child.process);
    }
    public static int Main(string[] args) {
        try {
            Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false)) { AutoFlush=true });
            Console.SetIn(new StreamReader(Console.OpenStandardInput(), new System.Text.UTF8Encoding(false)));
            if (args[0] == "conpty") return Conpty(args[1], false);
            if (args[0] == "tui") return Conpty(args[1], true);
            if (args[0] == "console") {
                Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs e) { e.Cancel=true; Console.WriteLine("ctrl-c"); Environment.Exit(7); };
                Console.WriteLine("console-ready"); Thread.Sleep(60000); return 99;
            }
            if (args[0] == "identity") {
                IntPtr token; Check(OpenProcessToken(Process.GetCurrentProcess().Handle, 8, out token));
                int elevated, returned; Check(GetTokenInformation(token, 20, out elevated, 4, out returned)); CloseHandle(token);
                bool inside; Check(IsProcessInJob(Process.GetCurrentProcess().Handle, IntPtr.Zero, out inside));
                bool admin = new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
                Console.WriteLine("{\"elevated\":" + (elevated != 0 ? "true" : "false") + ",\"admin\":" + (admin ? "true" : "false") + ",\"inheritedJob\":" + (inside ? "true" : "false") + "}");
                return elevated == 0 && !admin ? 0 : 91;
            }
            if (args[0] == "context") { Console.WriteLine(Environment.CurrentDirectory); Console.WriteLine(Environment.GetEnvironmentVariable("PI_OWNER_CONTEXT")); Console.Write(Console.In.ReadToEnd()); return 0; }
            if (args[0] == "status") { return unchecked((int)UInt32.Parse(args[1])); }
            if (args[0] == "bytes") {
                byte[] bytes = new byte[] {0,255,10,13,0,128,65};
                Console.OpenStandardOutput().Write(bytes,0,bytes.Length);
                Array.Reverse(bytes); Console.OpenStandardError().Write(bytes,0,bytes.Length); return 7;
            }
            if (args[0] == "args") { foreach (string arg in args) Console.WriteLine(Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(arg))); return 0; }
            if (args[0] == "breakaway") {
                STARTUP si = new STARTUP(); si.cb = (uint)Marshal.SizeOf(si); PROCESS child;
                if (CreateProcess(Exe, "\""+Exe+"\" leaf \""+args[1]+"\"", IntPtr.Zero, IntPtr.Zero, false, 0x01000000, IntPtr.Zero, null, ref si, out child)) {
                    TerminateProcess(child.process, 90); CloseHandle(child.thread); CloseHandle(child.process); return 92;
                }
                return Marshal.GetLastWin32Error() == 5 ? 0 : 93;
            }
            string directory = args[1];
            Mark(directory);
            if (args[0] == "leaf") { Thread.Sleep(60000); return 94; }
            if (args[0] == "nested") {
                nested = CreateJobObject(IntPtr.Zero, null); Check(nested != IntPtr.Zero);
                LIMIT limits = new LIMIT(); limits.basic.flags = 0x2000;
                Check(SetInformationJobObject(nested,9,ref limits,(uint)Marshal.SizeOf(limits)));
                Check(AssignProcessToJobObject(nested,Process.GetCurrentProcess().Handle));
            }
            if (args[0] == "tree" || args[0] == "nested") {
                // Recursive native children, new console and process group; none grants breakaway.
                Spawn("branch \""+directory+"\"", 0x00000210);
            } else if (args[0] == "branch") { Spawn("leaf \""+directory+"\"", 0x00000210); Thread.Sleep(60000); return 94; }
            else throw new Exception("unknown fixture mode");
            DateTime deadline = DateTime.UtcNow.AddSeconds(5);
            while (Directory.GetFiles(directory,"*.pid").Length < 3 && DateTime.UtcNow < deadline) Thread.Sleep(10);
            if (Directory.GetFiles(directory,"*.pid").Length != 3) return 95;
            LIMIT policy; Check(QueryInformationJobObject(IntPtr.Zero,9,out policy,(uint)Marshal.SizeOf(typeof(LIMIT)),IntPtr.Zero));
            if ((policy.basic.flags & 0x1800) != 0 || (policy.basic.flags & 0x2000) == 0) return 96;
            if (args.Length > 2 && args[2] == "exit") return 7;
            Console.WriteLine("ready"); Thread.Sleep(60000); return 94;
        } catch (Exception error) { Console.Error.WriteLine(error); return 97; }
    }
}
