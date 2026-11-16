#!/usr/bin/env python3
"""Local C++17 debugger-trace pilot. TRUSTED programs only; NOT a sandbox."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent
FORBIDDEN_NAMES = {"__proto__", "constructor", "prototype"}


class PilotError(Exception):
    pass


def identifier(value):
    if not re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*", value) or value in FORBIDDEN_NAMES:
        raise argparse.ArgumentTypeError("Use a plain, non-reserved global variable name, not an expression.")
    return value


def stop_tree(process):
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    process.wait(timeout=10)


def bounded_process(command, directory, timeout, env=None):
    """Bound diagnostics too; ordinary limits are not a hostile-code security boundary."""
    out = directory / "process.stdout"
    err = directory / "process.stderr"
    with out.open("wb") as stdout, err.open("wb") as stderr:
        process = subprocess.Popen(command, cwd=directory, stdin=subprocess.DEVNULL,
                                   stdout=stdout, stderr=stderr, env=env,
                                   start_new_session=os.name != "nt")
        started = time.monotonic()
        try:
            while process.poll() is None:
                if time.monotonic() - started > timeout:
                    raise PilotError("Process timed out; no complete trace is claimed.")
                if out.stat().st_size + err.stat().st_size > 1024 * 1024:
                    raise PilotError("Process diagnostic output exceeded 1 MiB.")
                time.sleep(0.05)
        except BaseException:
            stop_tree(process)
            raise
    if out.stat().st_size + err.stat().st_size > 1024 * 1024:
        raise PilotError("Process diagnostic output exceeded 1 MiB.")
    text = out.read_text(encoding="utf-8", errors="replace") + err.read_text(encoding="utf-8", errors="replace")
    return process.returncode, text


def run_pilot(source, watches, *, result=None, max_steps=1200, max_events=4000,
              timeout=20, compiler=None, debugger=None):
    source = Path(source).resolve()
    for name in [*watches, *([result] if result else [])]:
        identifier(name)
    if not watches or len(watches) > 8 or len(set(watches)) != len(watches):
        raise PilotError("Select 1-8 distinct global watch variables.")
    if result and result not in watches:
        raise PilotError("Result must also be one of the watched globals.")
    if not 1 <= max_steps <= 5000 or not 8 <= max_events <= 10000 or not 1 <= timeout <= 60:
        raise PilotError("Limits outside pilot bounds.")
    if source.stat().st_size > 64 * 1024:
        raise PilotError("Source exceeds 64 KiB.")
    text = source.read_text(encoding="utf-8")
    if len(text.split("\n")) > 4096:
        raise PilotError("Source exceeds 4096 lines.")
    compiler = compiler or shutil.which("g++")
    debugger = debugger or shutil.which("gdb")
    if not compiler or not debugger:
        raise PilotError("Install g++ and a GDB built with Python support; both must be on PATH.")
    with tempfile.TemporaryDirectory(prefix="algorithm-cpp-pilot-") as temp:
        work = Path(temp).resolve()
        # Work in an owned directory; never execute a pre-existing binary from the repo.
        program = work / "program.cpp"
        program.write_text(text, encoding="utf-8")
        driver = work / "gdb_capture.py"
        shutil.copyfile(HERE / "gdb_capture.py", driver)
        binary = work / ("program.exe" if os.name == "nt" else "program")
        code, log = bounded_process([compiler, "-std=c++17", "-O0", "-g", "-fno-omit-frame-pointer",
                                     str(program), "-o", str(binary)], work, timeout=30)
        if code:
            raise PilotError("C++ compilation failed:\n" + log[-12000:])
        report_path = work / "report.json"
        config = dict(source=str(program), report=str(report_path), watch=watches, result=result,
                      max_steps=max_steps, max_events=max_events, timeout=timeout)
        config_path = work / "config.json"
        config_path.write_text(json.dumps(config), encoding="utf-8")
        env = dict(os.environ, CPP_PILOT_CONFIG=str(config_path))
        # Disable init/auto-load scripts and remote debug-info lookup; the inspected
        # program itself remains unrestricted native code and MUST be trusted.
        command = [debugger, "--nx", "--batch", "-iex", "set auto-load off",
                   "-iex", "set debuginfod enabled off", "-x", str(driver), str(binary)]
        code, log = bounded_process(command, work, timeout=timeout + 10, env=env)
        if code or not report_path.is_file():
            raise PilotError("GDB did not produce a trace:\n" + log[-12000:])
        if report_path.stat().st_size > 8 * 1024 * 1024:
            raise PilotError("Trace report exceeds 8 MiB.")
        report = json.loads(report_path.read_text(encoding="utf-8"))
        report["source"]["name"] = source.name
        return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--watch", action="append", required=True, type=identifier,
                        help="Non-static global int/bool, fixed array, or libstdc++ vector<int>; repeatable")
    parser.add_argument("--result", type=identifier, help="Use this watched global as the done result")
    parser.add_argument("--trusted", action="store_true", help="Confirm this is trusted native code")
    parser.add_argument("--output", type=Path, help="New JSON path; refuses to overwrite an existing file")
    parser.add_argument("--max-steps", type=int, default=1200)
    parser.add_argument("--max-events", type=int, default=4000)
    parser.add_argument("--timeout", type=int, default=20)
    args = parser.parse_args()
    if not args.trusted:
        parser.error("Native execution is NOT sandboxed. Inspect the source and explicitly pass --trusted.")
    if args.output and args.output.exists():
        parser.error("Output exists; choose a new path or remove it yourself.")
    try:
        report = run_pilot(args.source, args.watch, result=args.result, max_steps=args.max_steps,
                           max_events=args.max_events, timeout=args.timeout)
        text = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        if args.output:
            # Exclusive create so a race cannot silently overwrite an existing artifact.
            with args.output.open("x", encoding="utf-8") as output:
                output.write(text)
            print(str(args.output.resolve()))
            print("status:", report["status"], "/ events:", len(report["events"]))
        else:
            print(text)
        return 0 if report["status"] == "complete" else 1
    except (PilotError, OSError, ValueError, argparse.ArgumentTypeError) as error:
        parser.exit(1, "C++ pilot stopped: " + str(error) + "\n")


if __name__ == "__main__":
    raise SystemExit(main())
