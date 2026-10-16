import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import server


class FourSourcePipelineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.paths = mock.patch.multiple(
            server,
            DATA_DIR=root,
            DATA=root / 'usage.json',
            CLI_STATE=root / 'cli_state.json',
            QUOTA=root / 'quota.json',
        )
        self.paths.start()
        self.addCleanup(self.paths.stop)
        self.scan = mock.patch.object(server, 'scan_cli')
        self.scan.start()
        self.addCleanup(self.scan.stop)

    def test_snapshot_contains_time_and_tokens_for_all_four_sources(self):
        day = dt.date.today().isoformat()
        server.save(server.DATA, {'days': {day: {
            'claude': {'ms': 60_000, 'tok': 101},
            'chatgpt': {'ms': 120_000, 'tok': 202},
        }}})
        server.save(server.CLI_STATE, {'days': {day: {
            'claude_code': {'ms': 180_000, 'tok': 303, 'cache': 30},
            'codex': {'ms': 240_000, 'tok': 404, 'cache': 40},
        }}})

        snapshot = server.public_snapshot(days=1)
        period = snapshot['periods']['day']
        expected = {
            'claude': (1.0, 101),
            'chatgpt': (2.0, 202),
            'claude_code': (3.0, 303),
            'codex': (4.0, 404),
        }
        for source, (minutes, tokens) in expected.items():
            self.assertEqual(period[source]['minutes'], minutes)
            self.assertEqual(period[source]['tokens'], tokens)
            self.assertIn(source, snapshot['daily'][0])
        self.assertEqual(period['web_total'], {'minutes': 3.0, 'tokens': 303})
        self.assertEqual(period['cli_total']['minutes'], 7.0)
        self.assertEqual(period['cli_total']['tokens'], 707)

        payload = json.dumps(snapshot)
        for private_name in ('conversation', 'project_path', 'session_id'):
            self.assertNotIn(private_name, payload)

    def test_workbench_marks_web_tokens_as_estimates(self):
        html = server.PAGE.read_text('utf-8')
        self.assertIn("name: 'Claude 网页', tag: 'Token 估算'", html)
        self.assertIn("name: 'ChatGPT / Codex 网页', tag: 'Token 估算'", html)
        self.assertIn("name: 'Claude Code CLI', tag: 'Token 实际'", html)
        self.assertIn("name: 'Codex CLI', tag: 'Token 实际'", html)
if __name__ == '__main__':
    unittest.main()
