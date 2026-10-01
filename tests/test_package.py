import hashlib
from html.parser import HTMLParser
from pathlib import Path
import subprocess
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]


class PackageTests(unittest.TestCase):
    def test_published_landing_has_all_resources(self):
        subprocess.run(['python3', 'scripts/build.py'], cwd=ROOT, check=True, capture_output=True)
        html = (ROOT / 'dist/index.html').read_text()
        self.assertNotIn('{{', html)

        class Links(HTMLParser):
            def handle_starttag(parser, tag, attributes):
                for name, value in attributes:
                    if name in ['src', 'href'] and value and not value.startswith(('https:', '#')):
                        self.assertTrue((ROOT / 'dist' / value).is_file(), f'Missing published resource: {value}')

        Links().feed(html)

    def test_reproducible_installable_package(self):
        subprocess.run(['python3', 'scripts/build.py'], cwd=ROOT, check=True, capture_output=True)
        first = (ROOT / 'dist/stash-tv.zip').read_bytes()
        subprocess.run(['python3', 'scripts/build.py'], cwd=ROOT, check=True, capture_output=True)
        self.assertEqual(first, (ROOT / 'dist/stash-tv.zip').read_bytes())
        self.assertIn(hashlib.sha256(first).hexdigest(), (ROOT / 'dist/index.yml').read_text())
        with zipfile.ZipFile(ROOT / 'dist/stash-tv.zip') as archive:
            self.assertEqual(set(archive.namelist()), {
                'stash-tv.yml', 'launcher.js', 'web/index.html', 'web/player.js',
                'web/style.css', 'web/LUCIDE-LICENSE.txt', 'LICENSE', 'README.md',
                'web/buffering.js', 'web/prepare-worker.js', 'web/media-worker.js',
                'web/mp4box-parser.js', 'web/MP4BOX-LICENSE.txt'})
            for name in archive.namelist():
                body = archive.read(name).decode()
                for private in ['PRIVATE KEY', 'ghp_', 'github_pat_']:
                    self.assertNotIn(private, body)


if __name__ == '__main__':
    unittest.main()
