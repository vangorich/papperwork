"""Windows black-box tests. Pass the compiled helper; no default/live profile is ever used."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
import unittest

HELPER = Path(sys.argv.pop(1)).resolve(strict=True)
KEY = 'paperwork-pdf'


class Registration(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='paperwork-mcp-test-')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.home = self.root / 'synthetic home'
        self.local = self.root / 'local'
        self.home.mkdir()
        self.local.mkdir()
        self.claude = self.home / '.claude.json'
        self.codex = self.home / '.codex' / 'config.toml'
        self.gemini = self.home / '.gemini' / 'settings.json'
        self.old = self.root / "纸 页 #1's.exe"
        self.new = self.root / 'new path.exe'
        for exe in (self.old, self.new):
            exe.write_bytes(b'synthetic placeholder; never executed')

    def helper(self, mode, exe=None, status=0):
        proc = subprocess.run([HELPER, mode, self.home, self.local, exe or self.old],
                              capture_output=True, timeout=15)
        self.assertEqual(proc.returncode, status, (proc.stdout, proc.stderr))
        return proc.stdout

    def configs(self):
        return [p.read_bytes() for p in (self.claude, self.codex, self.gemini)]

    def servers(self):
        return [json.loads(self.claude.read_bytes())['mcpServers'],
                tomllib.loads(self.codex.read_text(encoding='utf-8-sig'))['mcp_servers'],
                json.loads(self.gemini.read_bytes())['mcpServers']]

    def test_lifecycle_preserves_unrelated_bytes_and_stale_uninstaller_cannot_remove_upgrade(self):
        self.codex.parent.mkdir()
        self.gemini.parent.mkdir()
        self.claude.write_bytes(b'\xef\xbb\xbf{\r\n "n":9007199254740993123,\t"mcpServers" : { "other" : {"args":["}"]} }\r\n}\r\n')
        self.codex.write_bytes(b'# fixture\r\n[mcp_servers.other]\r\ncommand = \'kept\' # keep\r\n[other]\r\ntext="""\r\n[mcp_servers.paperwork-pdf]\r\n"""')
        self.gemini.write_bytes('{\n  "note":"折页", "nested":{"mcpServers":false}\n}\n'.encode())
        original = self.configs()
        self.helper('install')
        first = self.configs()
        self.helper('install')
        self.assertEqual(self.configs(), first)
        for mapping in self.servers():
            self.assertEqual(mapping[KEY]['command'], str(self.old))
            self.assertEqual(mapping[KEY]['args'], ['--pdf-mcp'])
        self.helper('refresh', self.new)
        for mapping in self.servers():
            self.assertEqual(mapping[KEY]['command'], str(self.new))
        upgraded = self.configs()
        self.helper('uninstall')
        self.assertEqual(self.configs(), upgraded)
        self.helper('uninstall', self.new)
        self.assertEqual(self.configs(), original)
        self.helper('uninstall', self.new)
        self.assertFalse(list(self.local.rglob('*.json')))

    def test_absence_detection_and_cleanup(self):
        self.helper('install')
        self.assertEqual(list(self.home.iterdir()), [])
        self.assertEqual(list(self.local.iterdir()), [])
        for dirname in ('.claude', '.codex', '.gemini'):
            (self.home / dirname).mkdir()
        self.helper('refresh')
        self.assertFalse(any(p.exists() for p in (self.claude, self.codex, self.gemini)))
        self.helper('install')
        self.assertTrue(all(KEY in s for s in self.servers()))
        self.helper('uninstall')
        self.assertFalse(any(p.exists() for p in (self.claude, self.codex, self.gemini)))
        self.assertEqual(len(list(self.home.iterdir())), 3)

    def test_bad_files_and_collisions_are_not_rewritten_or_adopted(self):
        self.codex.parent.mkdir()
        self.gemini.parent.mkdir()
        same_command = json.dumps({'command': str(self.old), 'args': ['--pdf-mcp']}).encode()
        for claude, codex, gemini in [
            (b'{broken', b'x = [', b'{"mcpServers":null}'),
            (b'{}\x00', b'\xff\xfeX\x00', b'{"mcpServers":{},"mcp\\u0053ervers":{}}'),
            (b'{"mcpServers":{"paperwork-pdf":' + same_command + b'}}',
             b'[mcp_servers."paperwork-pdf"]\ncommand = "user"\n',
             b'{"mcpServers":{"paperwork\\u002dpdf":{"command":"user"}}}'),
        ]:
            for p, data in zip((self.claude, self.codex, self.gemini), (claude, codex, gemini)):
                p.write_bytes(data)
            self.helper('install', status=2)
            self.helper('uninstall')
            self.assertEqual(self.configs(), [claude, codex, gemini])
        self.assertFalse(list(self.local.rglob('*.json')))

    def test_changed_entry_is_not_owned_and_another_client_can_still_register(self):
        self.codex.parent.mkdir()
        self.claude.write_bytes(b'{}')
        self.gemini.parent.mkdir()
        self.gemini.write_bytes(b'invalid')
        self.helper('install', status=2)
        data = json.loads(self.claude.read_bytes())
        data['mcpServers'][KEY]['disabled'] = True
        changed = json.dumps(data, indent=2).encode()
        self.claude.write_bytes(changed)
        self.codex.write_bytes(self.codex.read_bytes() + b'# unrelated\n[client]\nnew = true\n')
        self.helper('refresh', self.new, status=2)
        self.helper('uninstall', self.new)
        self.helper('uninstall', status=2)
        self.assertEqual(self.claude.read_bytes(), changed)
        self.assertEqual(self.codex.read_bytes(), b'# unrelated\n[client]\nnew = true\n')
        self.assertEqual(self.gemini.read_bytes(), b'invalid')

    def test_client_reformat_and_new_siblings_survive_uninstall(self):
        self.claude.write_bytes(b'{"mcpServers":{}}')
        self.codex.parent.mkdir()
        self.codex.write_bytes(b'# existing file\n')
        self.helper('install')
        data = json.loads(self.claude.read_bytes())
        entry = data['mcpServers'][KEY]
        data['mcpServers'] = {'first': {}, KEY: dict(reversed(entry.items())), 'last': {'x': 42}}
        self.claude.write_bytes(json.dumps(data, indent=2).encode())
        raw = self.codex.read_bytes().replace(b'command = ', b'# human note\ncommand  =  ')
        self.codex.write_bytes(raw + b'[next]\nx = 1\n')
        self.helper('uninstall')
        del data['mcpServers'][KEY]
        self.assertEqual(self.claude.read_bytes(), json.dumps(data, indent=2).encode())
        self.assertEqual(self.codex.read_bytes(), b'# existing file\n# human note\n[next]\nx = 1\n')

    def test_uninstall_preserves_new_user_whitespace_before_the_owned_entry(self):
        self.codex.parent.mkdir()
        self.codex.write_bytes(b'title = "original"')  # registration must supply a separator
        self.claude.write_bytes(b'{"mcpServers":{"other":{}}}')
        self.helper('install')
        # An editor subsequently supplied its own extra blank line, and whitespace before
        # the JSON comma. Neither is a byte that our registration owns.
        newer = b'title = "new"\n\n'
        header = b'[mcp_servers.paperwork-pdf]'
        self.codex.write_bytes(newer + header + self.codex.read_bytes().split(header, 1)[1])
        self.claude.write_bytes(self.claude.read_bytes().replace(b'"other":{},', b'"other":{} \t,'))
        self.helper('uninstall')
        self.assertEqual(self.codex.read_bytes(), newer)
        self.assertEqual(self.claude.read_bytes(), b'{"mcpServers":{"other":{} \t}}')

    def test_copy_of_owned_entry_without_its_receipt_is_still_a_collision(self):
        self.claude.write_bytes(b'{}')
        self.helper('install')
        copied = self.claude.read_bytes()
        self.gemini.parent.mkdir()
        self.gemini.write_bytes(copied)
        self.helper('install', status=2)
        self.helper('uninstall')
        self.assertEqual(self.claude.read_bytes(), b'{}')
        self.assertEqual(self.gemini.read_bytes(), copied)

    def test_corrupt_receipt_and_user_removed_entry_never_trigger_repair_by_overwrite(self):
        self.claude.write_bytes(b'{}')
        self.codex.parent.mkdir()
        self.helper('install')
        owned = self.claude.read_bytes()
        (receipt,) = self.local.rglob('claude.json')
        receipt.write_bytes(b'broken receipt')
        self.codex.write_bytes(b'# intentionally removed by another editor\n')
        before = self.codex.read_bytes()
        self.helper('refresh', self.new, status=2)
        self.helper('uninstall', status=2)
        self.assertEqual(self.claude.read_bytes(), owned)
        self.assertEqual(self.codex.read_bytes(), before)
        self.assertEqual(receipt.read_bytes(), b'broken receipt')

    def test_overlapping_writer_and_hardlink_are_left_alone(self):
        self.claude.write_bytes(b'{"private":"fixture"}')
        # The other writer has already opened the original. Our transaction must decline.
        self.gemini.parent.mkdir()
        outside = self.root / 'synthetic-unrelated-file'
        outside.write_bytes(b'{"preserve":true}')
        os.link(outside, self.gemini)
        with self.claude.open('r+b') as writer:
            self.helper('install', status=2)
            writer.write(b'{"later":true}')
            writer.truncate()
        self.assertEqual(self.claude.read_bytes(), b'{"later":true}')
        self.assertEqual(outside.read_bytes(), b'{"preserve":true}')
        self.assertFalse(list(self.local.rglob('*.json')))


if __name__ == '__main__':
    unittest.main(verbosity=2)
