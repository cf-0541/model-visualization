"""Trusted fixtures only: python -m unittest discover -s experiments/cpp -p 'test_*.py' -v.

Native tests REQUIRE g++ and Python-enabled GDB on PATH; missing tools fail rather
than silently claiming integration coverage. No repository/user code is discovered.
"""
import argparse
import json
import os
import runpy
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import run

HERE = Path(__file__).resolve().parent


def replay(report):
    values = {}
    stack = []
    for seq, event in enumerate(report['events']):
        assert event['seq'] == seq
        assert 0 <= event['line'] <= len(report['source']['text'].splitlines())
        kind = event['type']
        if kind == 'track':
            values[event['target']] = event['value']
        elif kind == 'write':
            value = values[event['target']]
            for index in event['path']:
                value = value[index]
            if 'arrayPatch' in event:
                patch = event['arrayPatch']
                assert len(value) == patch['beforeLength']
                value.extend([None] * max(0, patch['afterLength'] - len(value)))
                for change in patch['changes']:
                    if change['afterPresent']:
                        value[change['index']] = change['after']
                del value[patch['afterLength']:]
            elif not event['path']:
                values[event['target']] = event['after']
            else:
                parent = values[event['target']]
                for index in event['path'][:-1]:
                    parent = parent[index]
                assert parent[event['path'][-1]] == event['before']
                parent[event['path'][-1]] = event['after']
        elif kind == 'call':
            assert event['depth'] == len(stack)
            stack.append(event['callId'])
        elif kind == 'return':
            assert stack.pop() == event['callId']
            assert event['value'] is None  # not a captured C++ return value
    if report['status'] == 'complete':
        assert not stack
        assert report['events'][-1]['type'] == 'done'
    else:
        assert report['events'][-1]['type'] == 'error'
        assert not any(e['type'] == 'done' for e in report['events'])
    return values


class GuardTests(unittest.TestCase):
    def test_identifiers_reject_expressions_and_prototype_names(self):
        for name in ('a[0]', 'x.y', 'f()', '__proto__', 'constructor', 'prototype', 'x;exit(0)', ''):
            with self.subTest(name=name), self.assertRaises(argparse.ArgumentTypeError):
                run.identifier(name)
        self.assertEqual(run.identifier('numbers_1'), 'numbers_1')

    def test_limits_and_watch_contract_checked_before_compilation(self):
        for watches, options in [([], {}), (['x', 'x'], {}), (['x'], {'result': 'y'}),
                                 (['x'], {'max_steps': 0}), (['x'], {'max_events': 7}),
                                 (['x'], {'timeout': 61})]:
            with self.subTest(options=options), self.assertRaises(run.PilotError):
                run.run_pilot(HERE / 'fixtures/bubble.cpp', watches, **options)

    def test_cli_requires_trusted_and_refuses_overwrite(self):
        base = [sys.executable, str(HERE / 'run.py'), str(HERE / 'fixtures/bubble.cpp'), '--watch', 'numbers']
        result = subprocess.run(base, capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('NOT sandboxed', result.stderr)
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'trace.json'
            output.write_text('keep me', encoding='utf-8')
            result = subprocess.run(base + ['--trusted', '--output', str(output)],
                                    capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(output.read_text(encoding='utf-8'), 'keep me')

    def test_source_size_guard(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'oversize.cpp'
            source.write_text(' ' * (65536 + 1), encoding='utf-8')
            with self.assertRaisesRegex(run.PilotError, '64 KiB'):
                run.run_pilot(source, ['x'])

    def test_source_line_guard(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'many-lines.cpp'
            source.write_text('\n' * 4097, encoding='utf-8')
            with self.assertRaisesRegex(run.PilotError, '4096 lines'):
                run.run_pilot(source, ['x'])

    def test_parent_process_timeout_and_diagnostic_quota(self):
        cases = [('import time; time.sleep(10)', 0.1, 'timed out'),
                 ('import sys; sys.stdout.write("x" * (1024 * 1024 + 1))', 10, '1 MiB')]
        for code, timeout, message in cases:
            with self.subTest(message=message), tempfile.TemporaryDirectory() as temp:
                with self.assertRaisesRegex(run.PilotError, message):
                    run.bounded_process([sys.executable, '-c', code], Path(temp), timeout)


class DebuggerTypeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Load only definitions; no debugger, native program or report is started.
        gdb = mock.Mock(TYPE_CODE_STRUCT=3)
        with mock.patch.dict(sys.modules, {'gdb': gdb}):
            driver = runpy.run_path(str(HERE / 'gdb_capture.py'))
        cls.is_int_vector = staticmethod(driver['is_int_vector'])

    def debug_type(self, tag, display, code=3):
        type_ = mock.MagicMock()
        type_.tag, type_.code = tag, code
        type_.__str__.return_value = display
        return type_

    def test_vector_recognition_ignores_gdb_class_display_prefix(self):
        tag = 'std::vector<int, std::allocator<int> >'
        # Ubuntu GDB emitted "class ..." while Windows emitted "std::vector...".
        for prefix in ('', 'class ', 'struct '):
            with self.subTest(prefix=prefix):
                self.assertTrue(self.is_int_vector(self.debug_type(tag, prefix + tag)))

    def test_vector_recognition_does_not_expand_supported_types(self):
        for tag, code in [(None, 3), ('std::vector<double, std::allocator<double> >', 3),
                          ('std::vector<bool, std::allocator<bool> >', 3),
                          ('other::vector<int, allocator<int> >', 3),
                          ('std::vector<int, std::allocator<int> >', 1)]:
            with self.subTest(tag=tag, code=code):
                self.assertFalse(self.is_int_vector(self.debug_type(tag, str(tag), code)))


class NativeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which('g++') or not shutil.which('gdb'):
            raise RuntimeError('Native regression requires g++ and Python-enabled GDB on PATH.')

    def capture(self, name, watches, **options):
        report = run.run_pilot(HERE / 'fixtures' / name, watches, **options)
        # replay mutates state; work on a JSON copy, just like a transport boundary.
        values = replay(json.loads(json.dumps(report)))
        return report, values

    def source(self, text, **options):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'case.cpp'
            path.write_text(text, encoding='utf-8')
            return run.run_pilot(path, ['value'], **options)

    def test_all_fixtures_and_export_replay_samples(self):
        cases = [('bubble.cpp', ['numbers'], {'numbers': [1, 3, 5, 7]}, {}),
                 ('grid.cpp', ['dp'], {'dp': [[1, 1, 1], [1, 2, 3], [1, 3, 6]]}, {}),
                 ('recursion.cpp', ['answer'], {'answer': 120}, {'result': 'answer'}),
                 ('vector.cpp', ['numbers'], {'numbers': [2, 1, 3]}, {})]
        for name, watches, expected, options in cases:
            with self.subTest(name=name):
                report, values = self.capture(name, watches, **options)
                self.assertEqual(report['status'], 'complete', report['reason'])
                self.assertEqual(values, expected)
                if name == 'recursion.cpp':
                    self.assertEqual(report['events'][-1]['result'], 120)
                    self.assertEqual([e['args']['n'] for e in report['events']
                                      if e['type'] == 'call' and 'n' in e['args']], [5, 4, 3, 2, 1])
                if name == 'vector.cpp':
                    self.assertEqual([(e['arrayPatch']['beforeLength'], e['arrayPatch']['afterLength'])
                                      for e in report['events'] if 'arrayPatch' in e], [(3, 4), (4, 3)])
                # Opt-in regeneration for portable TS/browser replay regression fixtures.
                if os.environ.get('CPP_PILOT_EXPORT') == '1':
                    samples = HERE / 'samples'
                    samples.mkdir(exist_ok=True)
                    for event in report['events']:
                        if event['type'] == 'done':
                            event['duration'] = 0  # stable stored sample, not a performance measurement
                    (samples / (Path(name).stem + '.json')).write_text(
                        json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    def test_vector_alias_and_empty_storage_keep_length_patches(self):
        report = self.source(
            '#include <vector>\nusing Numbers = std::vector<int>;\nNumbers value;\n'
            'int main(){\n value.push_back(9);\n value.pop_back();\n return 0;\n}\n',
            result='value')
        self.assertEqual(report['status'], 'complete', report['reason'])
        self.assertEqual(replay(report), {'value': []})
        self.assertEqual(report['events'][-1]['result'], [])
        self.assertEqual([(e['arrayPatch']['beforeLength'], e['arrayPatch']['afterLength'])
                          for e in report['events'] if 'arrayPatch' in e], [(0, 1), (1, 0)])

    def test_event_and_step_limits_are_explicitly_incomplete(self):
        for options in ({'max_events': 8}, {'max_steps': 2}):
            with self.subTest(options=options):
                report, _ = self.capture('bubble.cpp', ['numbers'], **options)
                self.assertEqual(report['status'], 'truncated')
                self.assertLessEqual(len(report['events']), options.get('max_events', 4000))

    def test_missing_or_unsupported_global_is_error(self):
        for source in ('int main(){return 0;}', 'double value=1.5; int main(){return 0;}',
                       'long long value=1; int main(){return 0;}', 'int* value=nullptr; int main(){return 0;}',
                       '#include <vector>\nstd::vector<double> value; int main(){return 0;}',
                       '#include <vector>\nstd::vector<bool> value; int main(){return 0;}'):
            with self.subTest(source=source):
                report = self.source(source)
                replay(report)
                self.assertEqual(report['status'], 'error')

    def test_nonzero_exit_is_not_success(self):
        report = self.source('int value=0; int main(){value=2; return 3;}')
        replay(report)
        self.assertEqual(report['status'], 'error')
        self.assertIn('nonzero', report['reason'])

    def test_same_line_reverting_writes_are_not_fabricated(self):
        report = self.source('int value=0;\nint main(){\n value=1; value=0;\n return 0;\n}\n')
        self.assertEqual(report['status'], 'complete', report['reason'])
        self.assertFalse(any(e['type'] in ('read', 'branch') for e in report['events']))
        self.assertFalse(any(e['type'] == 'write' for e in report['events']))

    def test_signal_is_error_not_done(self):
        report = self.source('int value=0; int main(){__builtin_trap(); return 0;}')
        replay(report)
        self.assertEqual(report['status'], 'error')
        self.assertIn('signal', report['reason'])

    def test_native_stdout_does_not_corrupt_report(self):
        report = self.source('#include <cstdio>\nint value=0;\nint main(){\n std::puts("not JSON {hello}");\n value=7;\n return 0;\n}\n', result='value')
        self.assertEqual(report['status'], 'complete', report['reason'])
        self.assertEqual(report['events'][-1]['result'], 7)

    def test_compile_error_is_a_cli_failure_not_done(self):
        with self.assertRaisesRegex(run.PilotError, 'compilation failed'):
            self.source('this is not C++')


if __name__ == '__main__':
    unittest.main()
