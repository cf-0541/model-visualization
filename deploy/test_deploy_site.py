import io
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from deploy_site import DeployError, Site


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.site = Site(self.base / "site", verify=lambda release: None)

    def bundle(self, name="bundle", members=None):
        archive = self.base / (name + ".tar.gz")
        if members is None:
            members = [("index.html", b"<html>ok</html>"), ("assets/main-abc.js", b"console.log(1)")]
        with tarfile.open(archive, "w:gz") as bundle:
            for name, content in members:
                entry = tarfile.TarInfo(name)
                entry.size = len(content)
                bundle.addfile(entry, io.BytesIO(content))
        return archive

    def first_release(self):
        self.site.stage(self.bundle(), "r1")
        self.site.activate("r1")

    def test_stage_does_not_switch_live_site(self):
        release = self.site.stage(self.bundle(), "r1")
        self.assertEqual((release / "index.html").read_bytes(), b"<html>ok</html>")
        self.assertIsNone(self.site.pointer("current"))
        self.assertTrue((self.site.assets / "main-abc.js").is_file())

    @unittest.skipUnless(os.name == "posix", "Requires POSIX symlink semantics; run on Linux before deployment")
    def test_activate_and_rollback_keep_both_releases(self):
        self.first_release()
        self.site.stage(self.bundle("next", [("index.html", b"next"), ("assets/new-def.js", b"new")]), "r2")
        self.site.activate("r2")
        self.assertEqual(self.site.pointer("previous"), "r1")
        self.site.rollback()
        self.assertEqual(self.site.pointer("current"), "r1")
        self.assertEqual(self.site.pointer("previous"), "r2")
        self.assertTrue((self.site.assets / "main-abc.js").is_file())
        self.assertTrue((self.site.assets / "new-def.js").is_file())

    @unittest.skipUnless(os.name == "posix", "Requires POSIX symlink semantics; run on Linux before deployment")
    def test_failed_health_check_restores_current_and_previous(self):
        self.first_release()
        self.site.stage(self.bundle("next"), "r2")
        self.site.verify = lambda release: (_ for _ in ()).throw(DeployError("bad HTTP"))
        with self.assertRaisesRegex(DeployError, "current was restored"):
            self.site.activate("r2")
        self.assertEqual(self.site.pointer("current"), "r1")
        self.assertIsNone(self.site.pointer("previous"))

    @unittest.skipUnless(os.name == "posix", "Requires POSIX symlink semantics; run on Linux before deployment")
    def test_first_activation_failure_leaves_no_live_pointer(self):
        self.site.stage(self.bundle(), "r1")
        self.site.verify = lambda release: (_ for _ in ()).throw(DeployError("bad HTTP"))
        with self.assertRaises(DeployError):
            self.site.activate("r1")
        self.assertFalse((self.site.root / "current").exists())
        self.assertFalse((self.site.root / "current").is_symlink())

    def test_existing_release_cannot_be_overwritten(self):
        archive = self.bundle()
        self.site.stage(archive, "r1")
        with self.assertRaises(DeployError):
            self.site.stage(archive, "r1")

    @unittest.skipUnless(os.name == "posix", "Requires POSIX symlink semantics; run on Linux before deployment")
    def test_asset_collision_is_rejected_without_switching(self):
        self.first_release()
        archive = self.bundle("collision", [("index.html", b"new"), ("assets/main-abc.js", b"different")])
        with self.assertRaisesRegex(DeployError, "collision"):
            self.site.stage(archive, "r2")
        self.assertEqual((self.site.assets / "main-abc.js").read_bytes(), b"console.log(1)")
        self.assertFalse((self.site.releases / "r2").exists())
        self.assertEqual(self.site.pointer("current"), "r1")

    def test_rejects_unsafe_members(self):
        for path in ("../escape", "/tmp/escape", "assets/../../escape", "assets\\escape", ".env", "assets//bad.js"):
            with self.subTest(path=path), self.assertRaises(DeployError):
                self.site.stage(self.bundle(members=[("index.html", b"ok"), (path, b"bad")]), "r1")
        self.assertFalse((self.base / "escape").exists())

    def test_rejects_symlinks_and_hardlinks(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
            with self.subTest(kind=kind):
                archive = self.bundle()
                with tarfile.open(archive, "w:gz") as bundle:
                    entry = tarfile.TarInfo("assets/escape")
                    entry.type = kind
                    entry.linkname = "/etc/passwd"
                    bundle.addfile(entry)
                with self.assertRaises(DeployError):
                    self.site.stage(archive, "r1")

    def test_requires_root_index_and_assets_and_rejects_duplicate(self):
        for members in ([('index.html', b'ok')], [('assets/a.js', b'ok')],
                        [('index.html', b'ok'), ('index.html', b'bad'), ('assets/a.js', b'ok')]):
            with self.subTest(members=members), self.assertRaises(DeployError):
                self.site.stage(self.bundle(members=members), "r1")

    def test_rejects_unsafe_release_id(self):
        for name in ("../other", "/tmp/test", "..", "r 1", "r;whoami", "a" * 65):
            with self.subTest(name=name), self.assertRaises(DeployError):
                self.site.stage(self.bundle(), name)

    @unittest.skipUnless(os.name == "posix", "Requires POSIX symlink semantics; run on Linux before deployment")
    def test_rollback_without_previous_does_not_change_current(self):
        self.first_release()
        with self.assertRaises(DeployError):
            self.site.rollback()
        self.assertEqual(self.site.pointer("current"), "r1")

    def test_refuses_unmanaged_current(self):
        self.site.stage(self.bundle(), "r1")
        (self.site.root / "current").mkdir()
        with self.assertRaises(DeployError):
            self.site.activate("r1")
        self.assertTrue((self.site.root / "current").is_dir())

    def test_http_check_verifies_index_and_every_asset(self):
        release = self.site.stage(self.bundle(), "r1")
        requested = []

        class Response(io.BytesIO):
            status = 200

        class Opener:
            def open(inner, request, timeout):
                relative = request.full_url.removeprefix("http://127.0.0.1:8080/")
                requested.append(relative)
                return Response((release / relative).read_bytes())

        with patch("deploy_site.urllib.request.build_opener", return_value=Opener()):
            Site.verify_http(release)
        self.assertEqual(requested, ["index.html", "assets/main-abc.js"])

    def test_http_check_encodes_asset_paths(self):
        release = self.site.stage(self.bundle(members=[
            ("index.html", b"ok"), ("assets/a #b.js", b"code")]), "r1")
        requested = []

        class Response(io.BytesIO):
            status = 200

        class Opener:
            def open(inner, request, timeout):
                requested.append(request.full_url)
                return Response(b"ok" if request.full_url.endswith("index.html") else b"code")

        with patch("deploy_site.urllib.request.build_opener", return_value=Opener()):
            Site.verify_http(release)
        self.assertEqual(requested[-1], "http://127.0.0.1:8080/assets/a%20%23b.js")

    def test_http_check_rejects_wrong_content(self):
        release = self.site.stage(self.bundle(), "r1")

        class Response(io.BytesIO):
            status = 200

        class Opener:
            def open(inner, request, timeout):
                return Response(b"Welcome to nginx")

        with patch("deploy_site.urllib.request.build_opener", return_value=Opener()):
            with self.assertRaisesRegex(DeployError, "mismatch"):
                Site.verify_http(release)


if __name__ == "__main__":
    unittest.main()
