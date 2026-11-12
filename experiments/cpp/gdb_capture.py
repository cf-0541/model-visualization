"""GDB's embedded Python entrypoint. Never imported by the frontend."""
import json
import os
import time
from pathlib import Path

import gdb


class PilotError(Exception):
    pass


class LimitReached(Exception):
    pass


def is_int_vector(type_):
    # Type.tag is the declaration name, unlike the platform-dependent display
    # string (Ubuntu GDB may prepend "class " to str(type_)).
    return type_.code == gdb.TYPE_CODE_STRUCT and (type_.tag or "").startswith("std::vector<int,")


def run(config):
    events = []
    last_values = {}
    frames = []
    next_call_id = 0
    last_line = 0
    steps = 0
    exit_codes = []
    signals = []
    main_returned = [False]
    source_path = Path(config["source"]).resolve()
    started = time.monotonic()

    def emit(kind, line, **fields):
        # Reserve one slot for an explicit terminal error on truncation.
        if len(events) >= config["max_events"] - 1:
            raise LimitReached("Event limit reached; line-sampled trace is incomplete.")
        events.append(dict(seq=len(events), type=kind, line=line, **fields))

    def read_value(value, budget, depth=0):
        budget[0] -= 1
        if budget[0] < 0 or depth > 3:
            raise PilotError("Watched value exceeds the pilot snapshot budget.")
        type_ = value.type.strip_typedefs()
        if type_.code in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_BOOL, gdb.TYPE_CODE_ENUM):
            if type_.sizeof > 4:
                raise PilotError("Only bool and integral values up to 32 bits are supported.")
            return bool(value) if type_.code == gdb.TYPE_CODE_BOOL else int(value)
        if type_.code == gdb.TYPE_CODE_ARRAY:
            low, high = type_.range()
            if low != 0 or high + 1 > 120:
                raise PilotError("Only zero-based arrays with at most 120 entries per dimension are supported.")
            return [read_value(value[i], budget, depth + 1) for i in range(high + 1)]
        # Deliberately read libstdc++ storage, not operator[]/size() or pretty-printers.
        # This is an explicit implementation-specific pilot contract, not arbitrary STL support.
        if is_int_vector(type_):
            start = value["_M_impl"]["_M_start"]
            finish = value["_M_impl"]["_M_finish"]
            size = int(finish - start) if int(start) != 0 else 0
            if size < 0 or size > 120:
                raise PilotError("Only libstdc++ vector<int> of at most 120 entries is supported.")
            return [read_value(start[i], budget, depth + 1) for i in range(size)]
        raise PilotError("Unsupported watched type: " + str(type_))

    def snapshot():
        values = {}
        for name in config["watch"]:
            symbol = gdb.lookup_global_symbol(name)
            if symbol is None:
                raise PilotError("Watch must name a non-static global variable: " + name)
            values[name] = read_value(symbol.value(), [1024])
        return values

    def differences(target, before, after, line, path=None):
        path = [] if path is None else path
        if before == after:
            return
        if isinstance(before, list) and isinstance(after, list):
            if len(before) != len(after):
                changes = []
                for index in range(max(len(before), len(after))):
                    old = before[index] if index < len(before) else None
                    new = after[index] if index < len(after) else None
                    if index >= min(len(before), len(after)) or old != new:
                        changes.append(dict(index=index, beforePresent=index < len(before),
                                            afterPresent=index < len(after), before=old, after=new))
                emit("write", line, target=target, path=path,
                     arrayPatch=dict(beforeLength=len(before), afterLength=len(after), changes=changes))
            else:
                for index, (old, new) in enumerate(zip(before, after)):
                    differences(target, old, new, line, path + [index])
        else:
            emit("write", line, target=target, path=path, before=before, after=after)

    def sample_values():
        values = snapshot()
        for name, value in values.items():
            if name not in last_values:
                emit("track", last_line, target=name, value=value)
            else:
                differences(name, last_values[name], value, last_line)
        last_values.update(values)

    def user_frames():
        found = []
        frame = gdb.newest_frame()
        while frame is not None:
            sal = frame.find_sal()
            if sal.symtab and Path(sal.symtab.fullname()).resolve() == source_path:
                found.append((frame, sal.line))
            frame = frame.older()
        return list(reversed(found))

    def reconcile(stack):
        nonlocal next_call_id
        common = 0
        while common < min(len(frames), len(stack)) and frames[common]["name"] == stack[common][0].name():
            common += 1
        while len(frames) > common:
            old = frames.pop()
            # Return values are NOT evaluated or guessed. null means not captured.
            emit("return", last_line, value=None, **old)
        for frame, line in stack[common:]:
            args = {}
            for symbol in frame.block():
                if symbol.is_argument:
                    try:
                        value = read_value(frame.read_var(symbol), [1024])
                        if not isinstance(value, list):
                            args[symbol.name] = value
                    except (PilotError, gdb.error):
                        pass  # Pointer/reference args are not dereferenced implicitly.
            next_call_id += 1
            data = dict(name=frame.name(), callId=next_call_id, depth=len(frames), args=args)
            frames.append(data)
            emit("call", line, **data)

    def on_exit(event):
        exit_codes.append(getattr(event, "exit_code", None))

    def on_stop(event):
        if isinstance(event, gdb.SignalEvent):
            signals.append(event.stop_signal)

    class MainReturn(gdb.FinishBreakpoint):
        def stop(self):
            main_returned[0] = True
            return True

    status = "error"
    reason = None
    gdb.events.exited.connect(on_exit)
    gdb.events.stop.connect(on_stop)
    try:
        gdb.execute("set confirm off")
        gdb.execute("set pagination off")
        gdb.execute("set print elements 120")
        gdb.execute("set step-mode off")
        gdb.execute("set backtrace past-main on")
        # Inferior stdout is diagnostic only; not confused with the JSON protocol.
        gdb.execute("start", to_string=True)
        if signals or exit_codes:
            raise PilotError("Program did not stop normally at main.")
        MainReturn(gdb.newest_frame(), internal=True)
        while not exit_codes:
            if signals:
                raise PilotError("Native program stopped on signal: " + signals[-1])
            if steps >= config["max_steps"]:
                raise LimitReached("Debugger step limit reached; trace is incomplete.")
            if time.monotonic() - started > config["timeout"]:
                raise LimitReached("Debugger wall-clock limit reached; trace is incomplete.")
            # Observe after the preceding step, BEFORE reporting the next source line.
            sample_values()
            stack = user_frames()
            reconcile(stack)
            if main_returned[0]:
                gdb.execute("continue", to_string=True)
                break
            if not stack:
                raise PilotError("Execution left user code before normal main return.")
            current = gdb.newest_frame()
            sal = current.find_sal()
            if sal.symtab and Path(sal.symtab.fullname()).resolve() == source_path:
                last_line = sal.line
                emit("line", last_line)
                gdb.execute("step", to_string=True)
            else:
                # Library internals are intentionally not traced. Callbacks executed
                # wholly inside this finish can be missed: documented pilot limitation.
                gdb.execute("finish", to_string=True)
            steps += 1
        if signals:
            raise PilotError("Native program stopped on signal: " + signals[-1])
        if not main_returned[0] or not exit_codes or exit_codes[-1] is None:
            raise PilotError("No normal main return / exit code was observed.")
        if exit_codes[-1] != 0:
            raise PilotError("Program exited with nonzero status: " + str(exit_codes[-1]))
        result = last_values[config["result"]] if config.get("result") else dict(exitCode=exit_codes[-1])
        emit("done", last_line, result=result, duration=(time.monotonic() - started) * 1000)
        status = "complete"
    except LimitReached as error:
        status, reason = "truncated", str(error)
    except Exception as error:
        reason = str(error)
    finally:
        if status != "complete":
            events.append(dict(seq=len(events), type="error", line=last_line, message=reason))
        try:
            if gdb.selected_inferior().pid:
                gdb.execute("kill", to_string=True)
        except gdb.error:
            pass
        gdb.events.exited.disconnect(on_exit)
        gdb.events.stop.disconnect(on_stop)
    report = dict(schemaVersion=1, language="cpp", capture="debugger-line-sampling", status=status,
                  reason=reason, events=events, steps=steps,
                  limits=dict(maxSteps=config["max_steps"], maxEvents=config["max_events"]),
                  source=dict(name=source_path.name, text=source_path.read_text(encoding="utf-8")))
    Path(config["report"]).write_text(json.dumps(report, ensure_ascii=False, allow_nan=False), encoding="utf-8")


if __name__ == "__main__":
    with open(os.environ["CPP_PILOT_CONFIG"], encoding="utf-8") as config_file:
        run(json.load(config_file))
