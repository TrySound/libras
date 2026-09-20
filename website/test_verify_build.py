import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('verify', Path(__file__).with_name('verify-build.py'))
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class BuildTests(unittest.TestCase):
    def fixture(self, root):
        (root / 'index.html').write_text('normal app')
        (root / 'sw.js').write_text('normal service worker')
        catalog = root / 'demo/catalog'
        catalog.mkdir(parents=True)
        (root / 'demo/index.html').write_text('<svg><symbol id="icon-brand"></symbol></svg>')
        for name in ['credits.html', 'credits.json', 'dates.json', 'sources.json']:
            (catalog / name).write_text('{}')
        (catalog / 'assets.json').write_text(json.dumps({'song': {'path': 'audio/song.mp3'}}))
        (catalog / 'audio').mkdir()
        (catalog / 'audio/song.mp3').write_bytes(b'original audio')
        (catalog / 'search3.json').write_text(json.dumps({'subsonic-response': {'searchResult3': {'song': [{'id': 'song'}]}}}))
        return catalog

    def test_combined_site_keeps_regular_pwa_and_complete_demo(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.fixture(root)
            self.assertEqual(verify.verify(root)[0], 1)
            (root / 'demo/sw.js').write_text('unwanted worker')
            with self.assertRaisesRegex(ValueError, 'PWA artifacts'): verify.verify(root)
            (root / 'demo/sw.js').unlink()
            (root / 'sw.js').unlink()
            with self.assertRaisesRegex(ValueError, 'Regular application'): verify.verify(root)

    def test_missing_audio_or_credits_fails_publication(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            catalog = self.fixture(root)
            (catalog / 'audio/song.mp3').unlink()
            with self.assertRaisesRegex(ValueError, 'Missing demo audio'): verify.verify(root)
            (catalog / 'credits.html').unlink()
            with self.assertRaisesRegex(ValueError, 'incomplete'): verify.verify(root)


if __name__ == '__main__':
    unittest.main()
