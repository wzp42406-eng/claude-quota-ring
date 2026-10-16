import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import server
import collect
import desktop_usage


class UsagePipelineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.paths = mock.patch.multiple(
            server,
            DATA_DIR=root,
            DATA=root / 'usage.json',
            CLI_STATE=root / 'cli_state.json',
            DESKTOP_STATE=root / 'desktop_state.json',
            QUOTA=root / 'quota.json',
        )
        self.paths.start()
        self.addCleanup(self.paths.stop)
        self.scan = mock.patch.object(server, 'scan_cli')
        self.scan.start()
        self.addCleanup(self.scan.stop)

    def test_snapshot_contains_web_cli_and_desktop_aggregates(self):
        day = dt.date.today().isoformat()
        server.save(server.DATA, {'days': {day: {
            'claude': {'ms': 60_000, 'tok': 101},
            'chatgpt': {'ms': 120_000, 'tok': 202},
        }}})
        server.save(server.CLI_STATE, {'days': {day: {
            'claude_code': {'ms': 180_000, 'tok': 303, 'cache': 30},
            'codex': {'ms': 240_000, 'tok': 404, 'cache': 40},
            'claude_desktop_code': {'ms': 0, 'tok': 505, 'cache': 50},
            'codex_desktop_code': {'ms': 0, 'tok': 606, 'cache': 60},
        }}})
        server.save(server.DESKTOP_STATE, {'days': {day: {
            'claude_desktop': {'ms': 300_000},
            'chatgpt_desktop': {'ms': 360_000},
        }}})

        snapshot = server.public_snapshot(days=1)
        period = snapshot['periods']['day']
        expected = {
            'claude': (1.0, 101),
            'chatgpt': (2.0, 202),
            'claude_code': (3.0, 303),
            'codex': (4.0, 404),
            'claude_desktop': (5.0, None),
            'chatgpt_desktop': (6.0, None),
            'claude_desktop_code': (0.0, 505),
            'codex_desktop_code': (0.0, 606),
        }
        for source, (minutes, tokens) in expected.items():
            self.assertEqual(period[source]['minutes'], minutes)
            self.assertEqual(period[source]['tokens'], tokens)
            self.assertIn(source, snapshot['daily'][0])
        self.assertEqual(period['web_total'], {'minutes': 3.0, 'tokens': 303})
        self.assertEqual(period['cli_total']['minutes'], 7.0)
        self.assertEqual(period['cli_total']['tokens'], 707)
        self.assertEqual(period['desktop_total']['minutes'], 11.0)
        self.assertEqual(period['desktop_total']['tokens'], 1111)
        self.assertEqual(period['total'], {'minutes': 21.0, 'tokens': 2121})

        payload = json.dumps(snapshot)
        for private_name in ('conversation', 'project_path', 'session_id'):
            self.assertNotIn(private_name, payload)

    def test_workbench_renders_all_sources_in_three_sections(self):
        html = server.PAGE.read_text('utf-8')
        self.assertIn('id="web-section"', html)
        self.assertIn('id="cli-section"', html)
        self.assertIn('id="desktop-section"', html)
        self.assertIn('id="web-rows"', html)
        self.assertIn('id="cli-rows"', html)
        self.assertIn('id="desktop-rows"', html)
        self.assertIn("name: 'Claude 网页', tag: 'Token 估算'", html)
        self.assertIn("name: 'ChatGPT / Codex 网页', tag: 'Token 估算'", html)
        self.assertIn("name: 'Claude Code', tag: 'Token 精确'", html)
        self.assertIn("name: 'Codex CLI', tag: 'Token 精确'", html)
        self.assertIn("name: 'Claude 桌面'", html)
        self.assertIn("name: 'ChatGPT 桌面'", html)
        self.assertIn("name: 'Claude Code 标签页'", html)
        self.assertIn("{ id: 'web_total', name: '网页端'", html)
        self.assertIn("{ id: 'cli_total', name: '终端 CLI'", html)
        self.assertIn("{ id: 'desktop_total', name: '桌面软件'", html)

    def test_workbench_has_mobile_layout_single_quota_ring_and_freshness_warning(self):
        html = server.PAGE.read_text('utf-8')
        self.assertIn('@media (max-width: 560px)', html)
        self.assertIn('.overview, .source-grid { grid-template-columns: minmax(0, 1fr); }', html)
        self.assertIn("circle('five'", html)
        self.assertNotIn("circle('seven'", html)
        self.assertNotIn('外圈 5h · 内圈 7d', html)
        self.assertIn('.seg button { flex: 1;', html)
        self.assertIn('details.data table { width: 100%; table-layout: fixed;', html)
        self.assertNotIn('.source-stat { min-width', html)
        self.assertIn("document.createElementNS(ns, 'circle')", html)
        self.assertIn('已超过 2 小时，请检查同步', html)

    def test_update_status_does_not_append_null(self):
        html = server.PAGE.read_text('utf-8')
        self.assertIn("status.replaceChildren(document.createTextNode", html)
        self.assertIn("if (stale) status.append", html)
        self.assertNotIn("stale ? el('b', {}, '已超过 2 小时，请检查同步') : null", html)

    def test_desktop_sampler_counts_only_active_unlocked_short_intervals(self):
        state = {}
        start = 1_800_000_000_000
        self.assertEqual(desktop_usage.record_sample(
            state, start, 'com.anthropic.claudefordesktop', 0, False), 0)
        self.assertEqual(desktop_usage.record_sample(
            state, start + 60_000, 'com.anthropic.claudefordesktop', 10_000_000_000, False), 60_000)
        self.assertEqual(desktop_usage.record_sample(
            state, start + 120_000, 'com.openai.codex', desktop_usage.IDLE_LIMIT_NS + 1, False), 0)
        self.assertEqual(desktop_usage.record_sample(
            state, start + 180_000, 'com.openai.codex', 0, True), 0)
        self.assertEqual(desktop_usage.record_sample(
            state, start + 400_000, 'com.openai.codex', 0, False), 0)
        self.assertEqual(desktop_usage.record_sample(
            state, start + 460_000, 'com.openai.codex', 0, False), 60_000)
        rows = next(iter(state['days'].values()))
        self.assertEqual(rows['claude_desktop']['ms'], 60_000)
        self.assertEqual(rows['chatgpt_desktop']['ms'], 60_000)

    def test_desktop_sampler_parses_front_app_idle_and_lock_state(self):
        with mock.patch.object(desktop_usage, '_run', side_effect=[
            '[ ASN:0x0-0x1234: ]',
            '"bundleID"="com.anthropic.claudefordesktop"',
        ]):
            self.assertEqual(desktop_usage.front_bundle_id(), 'com.anthropic.claudefordesktop')
        with mock.patch.object(desktop_usage, '_run', return_value='"HIDIdleTime" = 123456789'):
            self.assertEqual(desktop_usage.hid_idle_ns(), 123456789)
        with mock.patch.object(desktop_usage, '_run', return_value='"IOConsoleLocked" = Yes'):
            self.assertTrue(desktop_usage.screen_locked())

    def test_desktop_code_tokens_are_split_and_deduplicated(self):
        days = {}
        desktop_state = {}
        cli_state = {}
        base = {
            'type': 'assistant', 'timestamp': '2026-10-17T01:00:00+08:00',
            'message': {'id': 'same', 'usage': {
                'input_tokens': 10, 'cache_creation_input_tokens': 20,
                'cache_read_input_tokens': 30, 'output_tokens': 40,
            }},
        }
        collect._claude_line({**base, 'entrypoint': 'claude-desktop'}, days, desktop_state, {})
        collect._claude_line({**base, 'entrypoint': 'claude-desktop'}, days, desktop_state, {})
        collect._claude_line({**base, 'entrypoint': 'cli', 'message': {**base['message'], 'id': 'cli'}}, days, cli_state, {})
        row = days['2026-10-17']
        self.assertEqual(row['claude_desktop_code'], {'ms': 0, 'tok': 70, 'cache': 30})
        self.assertEqual(row['claude_code']['tok'], 70)

        codex_days = {}
        codex_state = {}
        collect._codex_line({
            'type': 'session_meta', 'timestamp': '2026-10-17T01:00:00+08:00',
            'payload': {'originator': 'Codex Desktop'},
        }, codex_days, codex_state, {})
        token_event = {
            'type': 'event_msg', 'timestamp': '2026-10-17T01:01:00+08:00',
            'payload': {'type': 'token_count', 'info': {
                'total_token_usage': {'total_tokens': 130},
                'last_token_usage': {'input_tokens': 100, 'cached_input_tokens': 20, 'output_tokens': 30},
            }},
        }
        collect._codex_line(token_event, codex_days, codex_state, {})
        collect._codex_line(token_event, codex_days, codex_state, {})
        self.assertEqual(codex_days['2026-10-17']['codex_desktop_code'],
                         {'ms': 0, 'tok': 110, 'cache': 20})

    def test_collector_upgrade_discards_old_mixed_cli_aggregate(self):
        state = {'days': {'2026-10-17': {'claude_code': {'tok': 999}}}, 'files': {'old': {'offset': 1}}}
        with mock.patch.object(collect, 'SOURCES', {}):
            self.assertTrue(collect.scan(state))
        self.assertEqual(state['collector_version'], collect.COLLECTOR_VERSION)
        self.assertEqual(state['days'], {})
        self.assertEqual(state['files'], {})

    def test_publish_launchd_interval_is_one_hour(self):
        install = (Path(__file__).parent / 'install.sh').read_text('utf-8')
        self.assertIn('<key>StartInterval</key><integer>3600</integer>', install)
        self.assertNotIn('<integer>43200</integer>', install)

if __name__ == '__main__':
    unittest.main()
