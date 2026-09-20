import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from urllib.error import HTTPError

spec = importlib.util.spec_from_file_location('download', Path(__file__).with_name('download-catalog.py'))
download = importlib.util.module_from_spec(spec)
spec.loader.exec_module(download)
SOURCE = 'https://private-source.invalid/exports/'
PASSWORD = 'fixture-credential-never-published'


def fixture(extra=None):
    files = {name: b'{}' for name in download.METADATA}
    files['search3.json'] = json.dumps({'subsonic-response': {'status': 'ok', 'searchResult3': {'song': [{'id': 'song'}]}}}).encode()
    files['assets.json'] = json.dumps({'song': {'path': 'audio/song.mp3', 'contentType': 'audio/mpeg'}}).encode()
    files['audio/song.mp3'] = b'original-audio-bytes'
    files['covers/artist.svg'] = b'<svg/>'
    files.update(extra or {})
    inventory = [{'path': name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()} for name, data in sorted(files.items())]
    release = hashlib.sha256(json.dumps(inventory, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode='w:gz') as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    raw = archive.getvalue()
    manifest = {'schemaVersion': 1, 'release': release, 'files': inventory, 'archives': {'full': {'path': 'catalog.tar.gz', 'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}}}
    responses = {'latest.json': json.dumps({'release': release}).encode(), release + '/manifest.json': json.dumps(manifest).encode(), release + '/catalog.tar.gz': raw}
    return release, files, responses


class Opener:
    def __init__(self, responses):
        self.responses = responses
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        return io.BytesIO(self.responses[request.full_url.removeprefix(SOURCE)])


class DownloadTests(unittest.TestCase):
    def test_latest_is_resolved_once_and_every_file_is_verified(self):
        release, files, responses = fixture()
        opener = Opener(responses)
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'site'
            self.assertEqual(download.download(output, SOURCE, PASSWORD, opener=opener), release)
            self.assertEqual([r.full_url.removeprefix(SOURCE) for r in opener.requests], ['latest.json', release + '/manifest.json', release + '/catalog.tar.gz'])
            for name, data in files.items(): self.assertEqual((output / name).read_bytes(), data)
            self.assertTrue(all(r.get_header('Authorization').startswith('Basic ') for r in opener.requests))
            self.assertEqual({f.relative_to(output).as_posix() for f in output.rglob('*') if f.is_file()}, set(files))

    def test_missing_secrets_bad_url_and_redirects_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'site'
            for source, password in [('', PASSWORD), (SOURCE, ''), ('http://private-source.invalid/', PASSWORD), ('https://user:secret@private-source.invalid/', PASSWORD)]:
                with self.assertRaises(download.ExportError): download.download(output, source, password)
            self.assertFalse(output.exists())
        with self.assertRaises(download.ExportError):
            download.NoRedirects().redirect_request(None, None, 302, '', {}, 'https://other.invalid/')

    def test_network_errors_do_not_disclose_source(self):
        class Failing:
            def open(self, request, timeout): raise HTTPError(request.full_url, 401, 'private error', {}, None)
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(download.ExportError) as error:
                download.download(Path(tmp) / 'site', SOURCE, PASSWORD, opener=Failing())
            self.assertIn('401', str(error.exception))
            self.assertNotIn('private-source', str(error.exception))
            self.assertNotIn(PASSWORD, str(error.exception))

    def test_corrupt_archive_never_publishes_partial_catalog(self):
        release, _, responses = fixture()
        responses[release + '/catalog.tar.gz'] += b'corrupt'
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'site'
            with self.assertRaises(download.ExportError): download.download(output, SOURCE, PASSWORD, opener=Opener(responses))
            self.assertFalse(output.exists())
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_rejects_secret_leaks_even_across_chunk_boundaries(self):
        for value in [SOURCE.encode(), b'private-source.invalid', PASSWORD.encode(), b'x' * (1024 * 1024 - 3) + PASSWORD.encode()]:
            _, _, responses = fixture({'credits.html': value})
            with tempfile.TemporaryDirectory() as tmp:
                output = Path(tmp) / 'site'
                with self.assertRaisesRegex(download.ExportError, 'private source identifier'):
                    download.download(output, SOURCE, PASSWORD, opener=Opener(responses))
                self.assertFalse(output.exists())

    def test_rejects_traversal_and_invalid_manifest_fingerprint(self):
        _, _, responses = fixture({'../escape': b'bad'})
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(download.ExportError): download.download(Path(tmp) / 'site', SOURCE, PASSWORD, opener=Opener(responses))
        release, _, responses = fixture()
        manifest = json.loads(responses[release + '/manifest.json'])
        manifest['files'][0]['size'] += 1
        responses[release + '/manifest.json'] = json.dumps(manifest).encode()
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(download.ExportError, 'fingerprint'):
                download.download(Path(tmp) / 'site', SOURCE, PASSWORD, opener=Opener(responses))

    def test_rejects_symlinks_duplicate_members_and_incomplete_archives(self):
        for mode in ['symlink', 'duplicate', 'missing']:
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                archive = root / 'bad.tar.gz'
                body = b'hello'
                files = {'credits.html': {'size': len(body), 'sha256': hashlib.sha256(body).hexdigest()}}
                with tarfile.open(archive, 'w:gz') as tar:
                    for _ in range(2 if mode == 'duplicate' else 0 if mode == 'missing' else 1):
                        info = tarfile.TarInfo('credits.html')
                        info.size = len(body)
                        if mode == 'symlink': info.type = tarfile.SYMTYPE; info.linkname = '/tmp/elsewhere'
                        tar.addfile(info, io.BytesIO(body))
                output = root / 'site'
                output.mkdir()
                with self.assertRaises(download.ExportError): download.extract(archive, output, files, [])


if __name__ == '__main__':
    unittest.main()
