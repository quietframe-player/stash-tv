import hashlib
from pathlib import Path
import subprocess
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]


class PackageTests(unittest.TestCase):
    def test_reproducible_installable_package(self):
        subprocess.run(['python3', 'scripts/build.py'], cwd=ROOT, check=True, capture_output=True)
        first = (ROOT / 'dist/stash-tv.zip').read_bytes()
        subprocess.run(['python3', 'scripts/build.py'], cwd=ROOT, check=True, capture_output=True)
        self.assertEqual(first, (ROOT / 'dist/stash-tv.zip').read_bytes())
        self.assertIn(hashlib.sha256(first).hexdigest(), (ROOT / 'dist/index.yml').read_text())
        with zipfile.ZipFile(ROOT / 'dist/stash-tv.zip') as archive:
            self.assertEqual(set(archive.namelist()), {
                'stash-tv.yml', 'launcher.js', 'web/index.html', 'web/player.js',
                'web/style.css', 'web/LUCIDE-LICENSE.txt', 'LICENSE', 'README.md'})
            for name in archive.namelist():
                body = archive.read(name).decode()
                for private in ['PRIVATE KEY', 'ghp_', 'github_pat_']:
                    self.assertNotIn(private, body)


if __name__ == '__main__':
    unittest.main()
