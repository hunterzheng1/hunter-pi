export const windowsJobHelperSource = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$source = @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace HunterPi
{
    public static class ManagedJobHost
    {
        private const uint CREATE_SUSPENDED = 0x00000004;
        private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        private const uint CREATE_NO_WINDOW = 0x08000000;
        private const uint STARTF_USESTDHANDLES = 0x00000100;
        private const uint HANDLE_FLAG_INHERIT = 0x00000001;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private const int JobObjectBasicAccountingInformation = 1;
        private const int JobObjectExtendedLimitInformation = 9;
        private const long PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
        private const long PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x0002000D;
        private const uint GENERIC_READ = 0x80000000;
        private const uint GENERIC_WRITE = 0x40000000;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint OPEN_EXISTING = 3;
        private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
        private const uint STILL_ACTIVE = 259;
        private const uint RESUME_THREAD_FAILED = 0xFFFFFFFF;

        private static readonly object EventLock = new object();

        [StructLayout(LayoutKind.Sequential)]
        private struct SECURITY_ATTRIBUTES
        {
            public int nLength;
            public IntPtr lpSecurityDescriptor;
            [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO
        {
            public uint cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public uint dwX;
            public uint dwY;
            public uint dwXSize;
            public uint dwYSize;
            public uint dwXCountChars;
            public uint dwYCountChars;
            public uint dwFillAttribute;
            public uint dwFlags;
            public ushort wShowWindow;
            public ushort cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFOEX
        {
            public STARTUPINFO StartupInfo;
            public IntPtr lpAttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public uint dwProcessId;
            public uint dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
        {
            public long TotalUserTime;
            public long TotalKernelTime;
            public long ThisPeriodTotalUserTime;
            public long ThisPeriodTotalKernelTime;
            public uint TotalPageFaultCount;
            public uint TotalProcesses;
            public uint ActiveProcesses;
            public uint TotalTerminatedProcesses;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct FILETIME
        {
            public uint dwLowDateTime;
            public uint dwHighDateTime;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetInformationJobObject(
            IntPtr job,
            int informationClass,
            IntPtr information,
            uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool QueryInformationJobObject(
            IntPtr job,
            int informationClass,
            out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information,
            uint informationLength,
            IntPtr returnLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool InitializeProcThreadAttributeList(
            IntPtr attributeList,
            int attributeCount,
            int flags,
            ref IntPtr size);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UpdateProcThreadAttribute(
            IntPtr attributeList,
            uint flags,
            IntPtr attribute,
            IntPtr value,
            IntPtr size,
            IntPtr previousValue,
            IntPtr returnSize);

        [DllImport("kernel32.dll")]
        private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateProcessW(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref STARTUPINFOEX startupInfo,
            out PROCESS_INFORMATION processInformation);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            ref SECURITY_ATTRIBUTES securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsProcessInJob(
            IntPtr process,
            IntPtr job,
            [MarshalAs(UnmanagedType.Bool)] out bool result);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetProcessTimes(
            IntPtr process,
            out FILETIME creation,
            out FILETIME exit,
            out FILETIME kernel,
            out FILETIME user);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        private static void Require(bool value, string code)
        {
            if (!value)
            {
                throw new InvalidOperationException(code + "_" + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture));
            }
        }

        private static void Emit(string json)
        {
            lock (EventLock)
            {
                Console.Out.WriteLine(json);
                Console.Out.Flush();
            }
        }

        private static void EmitError(string code)
        {
            Emit("{\"type\":\"error\",\"code\":\"" + code + "\"}");
        }

        private static string QuoteArgument(string value)
        {
            if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '\"' }) < 0)
            {
                return value;
            }
            StringBuilder result = new StringBuilder();
            result.Append('\"');
            int backslashes = 0;
            foreach (char character in value)
            {
                if (character == '\\')
                {
                    backslashes += 1;
                    continue;
                }
                if (character == '\"')
                {
                    result.Append('\\', backslashes * 2 + 1);
                    result.Append('\"');
                    backslashes = 0;
                    continue;
                }
                result.Append('\\', backslashes);
                backslashes = 0;
                result.Append(character);
            }
            result.Append('\\', backslashes * 2);
            result.Append('\"');
            return result.ToString();
        }

        private static string BuildCommandLine(string executable, string[] arguments)
        {
            StringBuilder command = new StringBuilder(QuoteArgument(executable));
            foreach (string argument in arguments)
            {
                command.Append(' ');
                command.Append(QuoteArgument(argument));
            }
            return command.ToString();
        }

        private static IntPtr BuildEnvironment(IDictionary<string, string> environment)
        {
            List<string> keys = new List<string>(environment.Keys);
            keys.Sort(StringComparer.OrdinalIgnoreCase);
            StringBuilder block = new StringBuilder();
            foreach (string key in keys)
            {
                block.Append(key);
                block.Append('=');
                block.Append(environment[key]);
                block.Append('\0');
            }
            block.Append('\0');
            return Marshal.StringToHGlobalUni(block.ToString());
        }

        private static uint ActiveProcesses(IntPtr job)
        {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
            Require(
                QueryInformationJobObject(
                    job,
                    JobObjectBasicAccountingInformation,
                    out accounting,
                    (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)),
                    IntPtr.Zero),
                "QUERY_JOB");
            return accounting.ActiveProcesses;
        }

        private static int? ExitCode(IntPtr process)
        {
            uint code;
            Require(GetExitCodeProcess(process, out code), "QUERY_EXIT");
            return code == STILL_ACTIVE ? (int?)null : unchecked((int)code);
        }

        private static ulong CreationTime(IntPtr process)
        {
            FILETIME creation;
            FILETIME exit;
            FILETIME kernel;
            FILETIME user;
            Require(GetProcessTimes(process, out creation, out exit, out kernel, out user), "QUERY_IDENTITY");
            return ((ulong)creation.dwHighDateTime << 32) | creation.dwLowDateTime;
        }

        private static async Task ReadPipe(
            AnonymousPipeServerStream pipe,
            string stream)
        {
            byte[] buffer = new byte[16384];
            while (true)
            {
                int length = await pipe.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false);
                if (length == 0)
                {
                    return;
                }
                byte[] chunk = new byte[length];
                Buffer.BlockCopy(buffer, 0, chunk, 0, length);
                Emit(
                    "{\"type\":\"output\",\"stream\":\"" + stream +
                    "\",\"dataBase64\":\"" + Convert.ToBase64String(chunk) + "\"}");
            }
        }

        private static string JsonNumber(int? value)
        {
            return value.HasValue ? value.Value.ToString(CultureInfo.InvariantCulture) : "null";
        }

        private static void EmitState(
            string phase,
            string cause,
            int? exitCode,
            uint activeProcesses,
            Task stdoutTask,
            Task stderrTask)
        {
            Emit(
                "{\"type\":\"state\",\"phase\":\"" + phase +
                "\",\"terminationCause\":\"" + cause +
                "\",\"exitCode\":" + JsonNumber(exitCode) +
                ",\"treeState\":\"" + (activeProcesses == 0 ? "EMPTY" : "ACTIVE") +
                "\",\"stdoutState\":\"" + (stdoutTask.IsCompleted ? "CLOSED" : "OPEN") +
                "\",\"stderrState\":\"" + (stderrTask.IsCompleted ? "CLOSED" : "OPEN") + "\"}");
        }

        public static int Run(
            string executable,
            string[] arguments,
            string currentDirectory,
            IDictionary<string, string> environment,
            int timeoutMilliseconds)
        {
            IntPtr job = IntPtr.Zero;
            IntPtr nullHandle = IntPtr.Zero;
            IntPtr attributeList = IntPtr.Zero;
            IntPtr jobValue = IntPtr.Zero;
            IntPtr handleList = IntPtr.Zero;
            IntPtr environmentBlock = IntPtr.Zero;
            PROCESS_INFORMATION process = new PROCESS_INFORMATION();
            AnonymousPipeServerStream stdoutPipe = null;
            AnonymousPipeServerStream stderrPipe = null;
            bool stdoutClientDisposed = false;
            bool stderrClientDisposed = false;
            bool targetCreated = false;
            try
            {
                job = CreateJobObjectW(IntPtr.Zero, null);
                Require(job != IntPtr.Zero, "CREATE_JOB");
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                IntPtr limitsPointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
                try
                {
                    Marshal.StructureToPtr(limits, limitsPointer, false);
                    Require(
                        SetInformationJobObject(
                            job,
                            JobObjectExtendedLimitInformation,
                            limitsPointer,
                            (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))),
                        "SET_JOB_LIMIT");
                }
                finally
                {
                    Marshal.FreeHGlobal(limitsPointer);
                }

                stdoutPipe = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable, 16384);
                stderrPipe = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable, 16384);
                IntPtr stdoutClient = stdoutPipe.ClientSafePipeHandle.DangerousGetHandle();
                IntPtr stderrClient = stderrPipe.ClientSafePipeHandle.DangerousGetHandle();

                SECURITY_ATTRIBUTES security = new SECURITY_ATTRIBUTES();
                security.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
                security.bInheritHandle = true;
                nullHandle = CreateFileW(
                    "NUL",
                    GENERIC_READ | GENERIC_WRITE,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    ref security,
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    IntPtr.Zero);
                Require(nullHandle != IntPtr.Zero && nullHandle != new IntPtr(-1), "OPEN_NUL");
                Require(SetHandleInformation(nullHandle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT), "INHERIT_NUL");

                IntPtr attributeSize = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeSize);
                Require(attributeSize != IntPtr.Zero, "SIZE_ATTRIBUTES");
                attributeList = Marshal.AllocHGlobal(attributeSize);
                Require(InitializeProcThreadAttributeList(attributeList, 2, 0, ref attributeSize), "INIT_ATTRIBUTES");
                jobValue = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(jobValue, job);
                Require(
                    UpdateProcThreadAttribute(
                        attributeList,
                        0,
                        new IntPtr(PROC_THREAD_ATTRIBUTE_JOB_LIST),
                        jobValue,
                        new IntPtr(IntPtr.Size),
                        IntPtr.Zero,
                        IntPtr.Zero),
                    "SET_JOB_ATTRIBUTE");
                handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
                Marshal.WriteIntPtr(handleList, 0, nullHandle);
                Marshal.WriteIntPtr(handleList, IntPtr.Size, stdoutClient);
                Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, stderrClient);
                Require(
                    UpdateProcThreadAttribute(
                        attributeList,
                        0,
                        new IntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST),
                        handleList,
                        new IntPtr(IntPtr.Size * 3),
                        IntPtr.Zero,
                        IntPtr.Zero),
                    "SET_HANDLE_ATTRIBUTE");

                STARTUPINFOEX startup = new STARTUPINFOEX();
                startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
                startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
                startup.StartupInfo.hStdInput = nullHandle;
                startup.StartupInfo.hStdOutput = stdoutClient;
                startup.StartupInfo.hStdError = stderrClient;
                startup.lpAttributeList = attributeList;
                environmentBlock = BuildEnvironment(environment);
                StringBuilder commandLine = new StringBuilder(BuildCommandLine(executable, arguments));
                uint creationFlags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT |
                    EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW;
                Require(
                    CreateProcessW(
                        executable,
                        commandLine,
                        IntPtr.Zero,
                        IntPtr.Zero,
                        true,
                        creationFlags,
                        environmentBlock,
                        currentDirectory,
                        ref startup,
                        out process),
                    "CREATE_PROCESS");
                targetCreated = true;
                stdoutPipe.DisposeLocalCopyOfClientHandle();
                stdoutClientDisposed = true;
                stderrPipe.DisposeLocalCopyOfClientHandle();
                stderrClientDisposed = true;

                bool isInJob;
                Require(IsProcessInJob(process.hProcess, job, out isInJob), "QUERY_JOB_MEMBERSHIP");
                Require(isInJob, "JOB_MEMBERSHIP_FALSE");
                ulong creationTime = CreationTime(process.hProcess);
                Task stdoutTask = ReadPipe(stdoutPipe, "STDOUT");
                Task stderrTask = ReadPipe(stderrPipe, "STDERR");
                Require(ResumeThread(process.hThread) != RESUME_THREAD_FAILED, "RESUME_PROCESS");
                CloseHandle(process.hThread);
                process.hThread = IntPtr.Zero;
                Emit(
                    "{\"type\":\"ready\",\"pid\":" +
                    process.dwProcessId.ToString(CultureInfo.InvariantCulture) +
                    ",\"creationTime\":\"" + creationTime.ToString(CultureInfo.InvariantCulture) + "\"}");

                ConcurrentQueue<string> controls = new ConcurrentQueue<string>();
                bool inputClosed = false;
                Task.Run(delegate
                {
                    string line;
                    while ((line = Console.In.ReadLine()) != null)
                    {
                        controls.Enqueue(line);
                    }
                    inputClosed = true;
                });

                Stopwatch elapsed = Stopwatch.StartNew();
                string cause = "NONE";
                string lastState = null;
                while (true)
                {
                    if (stdoutTask.IsFaulted || stderrTask.IsFaulted)
                    {
                        throw new InvalidOperationException("PIPE_READ_FAILED");
                    }
                    uint active = ActiveProcesses(job);
                    int? exitCode = ExitCode(process.hProcess);
                    string control;
                    if (cause == "NONE" && controls.TryDequeue(out control))
                    {
                        cause = String.Equals(control, "TIMEOUT", StringComparison.Ordinal) ? "TIMEOUT" : "CANCEL";
                        Require(TerminateJobObject(job, 1), "TERMINATE_JOB");
                        Emit("{\"type\":\"terminationAcknowledged\",\"cause\":\"" + cause + "\"}");
                    }
                    else if (cause == "NONE" && inputClosed && active > 0)
                    {
                        cause = "CANCEL";
                        Require(TerminateJobObject(job, 1), "TERMINATE_PARENT_LOST");
                    }
                    else if (cause == "NONE" && elapsed.ElapsedMilliseconds >= timeoutMilliseconds && active > 0)
                    {
                        cause = "TIMEOUT";
                        Require(TerminateJobObject(job, 1), "TERMINATE_TIMEOUT");
                        Emit("{\"type\":\"terminationAcknowledged\",\"cause\":\"TIMEOUT\"}");
                    }

                    active = ActiveProcesses(job);
                    exitCode = ExitCode(process.hProcess);
                    string phase = cause != "NONE" && active > 0
                        ? "TERMINATING"
                        : (exitCode.HasValue ? "EXITED" : "RUNNING");
                    string state = phase + "|" + cause + "|" + JsonNumber(exitCode) + "|" +
                        active.ToString(CultureInfo.InvariantCulture) + "|" +
                        stdoutTask.IsCompleted.ToString() + "|" + stderrTask.IsCompleted.ToString();
                    if (!String.Equals(state, lastState, StringComparison.Ordinal))
                    {
                        EmitState(phase, cause, exitCode, active, stdoutTask, stderrTask);
                        lastState = state;
                    }
                    if (active == 0 && exitCode.HasValue && stdoutTask.IsCompleted && stderrTask.IsCompleted)
                    {
                        Task.WaitAll(stdoutTask, stderrTask);
                        Emit(
                            "{\"type\":\"terminal\",\"terminationCause\":\"" + cause +
                            "\",\"exitCode\":" + JsonNumber(exitCode) + "}");
                        return 0;
                    }
                    Thread.Sleep(20);
                }
            }
            catch (Exception error)
            {
                if (job != IntPtr.Zero)
                {
                    TerminateJobObject(job, 1);
                }
                string code = error.Message;
                EmitError(code.Replace("\"", String.Empty));
                return 70;
            }
            finally
            {
                if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
                if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
                if (attributeList != IntPtr.Zero)
                {
                    DeleteProcThreadAttributeList(attributeList);
                    Marshal.FreeHGlobal(attributeList);
                }
                if (jobValue != IntPtr.Zero) Marshal.FreeHGlobal(jobValue);
                if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
                if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
                if (nullHandle != IntPtr.Zero && nullHandle != new IntPtr(-1)) CloseHandle(nullHandle);
                if (stdoutPipe != null)
                {
                    if (!stdoutClientDisposed && targetCreated)
                    {
                        try { stdoutPipe.DisposeLocalCopyOfClientHandle(); } catch { }
                    }
                    stdoutPipe.Dispose();
                }
                if (stderrPipe != null)
                {
                    if (!stderrClientDisposed && targetCreated)
                    {
                        try { stderrPipe.DisposeLocalCopyOfClientHandle(); } catch { }
                    }
                    stderrPipe.Dispose();
                }
                if (job != IntPtr.Zero) CloseHandle(job);
            }
        }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp
$requestLine = [Console]::In.ReadLine()
if ([string]::IsNullOrWhiteSpace($requestLine)) {
  exit 64
}
$request = $requestLine | ConvertFrom-Json
$environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
foreach ($property in $request.environment.PSObject.Properties) {
  $environment.Add([string]$property.Name, [string]$property.Value)
}
$arguments = [string[]]@($request.argv)
$result = [HunterPi.ManagedJobHost]::Run(
  [string]$request.executable,
  $arguments,
  [string]$request.cwd,
  $environment,
  [int]$request.timeoutMs
)
exit $result
`;
