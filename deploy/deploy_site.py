#!/usr/bin/env python3
"""Deploy trusted Vite artifacts. Ubuntu server CLI; stdlib only."""
import argparse
import hashlib
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sys
import tarfile
import tempfile
import urllib.request
from urllib.parse import quote
import uuid


class DeployError(Exception):
    pass


def release_id(value):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", value):
        raise DeployError("Release ID must be 1-64 letters, digits, underscores or hyphens.")
    return value


class Site:
    def __init__(self, root, verify=None):
        self.root = Path(root).resolve()
        self.releases = self.root / "releases"
        self.assets = self.root / "shared-assets"
        self.verify = verify or self.verify_http

    def stage(self, archive, name):
        name = release_id(name)
        destination = self.releases / name
        if destination.exists():
            raise DeployError("Release already exists; choose a new release ID.")
        if Path(archive).stat().st_size > 32 * 1024 * 1024:
            raise DeployError("Archive exceeds 32 MiB.")
        self.releases.mkdir(parents=True, exist_ok=True)
        self.releases.chmod(0o755)
        with tarfile.open(archive, "r:gz") as bundle:
            members = []
            seen = set()
            total = 0
            for member in bundle:
                path = PurePosixPath(member.name)
                parts = path.parts
                safe = (member.name == str(path) and not path.is_absolute()
                        and "\\" not in member.name and ".." not in parts
                        and (member.name == "index.html" or
                             (parts and parts[0] == "assets"))
                        and (member.isfile() or member.isdir())
                        and not (member.name == "index.html" and not member.isfile())
                        and not (member.name == "assets" and not member.isdir()))
                if not safe or member.name in seen:
                    raise DeployError("Unsafe or duplicate archive member: " + member.name)
                total += member.size
                seen.add(member.name)
                members.append(member)
                if len(members) > 4096 or total > 64 * 1024 * 1024:
                    raise DeployError("Archive exceeds extraction limits.")
            if "index.html" not in seen or not any(
                    m.isfile() and m.name.startswith("assets/") for m in members):
                raise DeployError("Archive must contain index.html and assets/ files at its root.")
            incoming = Path(tempfile.mkdtemp(prefix=".incoming-", dir=self.releases))
            try:
                incoming.chmod(0o755)
                for member in members:
                    target = incoming / member.name
                    if member.isdir():
                        target.mkdir(parents=True, exist_ok=True)
                    else:
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with bundle.extractfile(member) as source, target.open("xb") as output:
                            shutil.copyfileobj(source, output)
                        target.chmod(0o644)
                # Hashed chunks are append-only: old tabs may still lazy-load them.
                for directory in incoming.rglob("*"):
                    if directory.is_dir():
                        directory.chmod(0o755)
                self.assets.mkdir(parents=True, exist_ok=True)
                self.assets.chmod(0o755)
                sources = sorted((incoming / "assets").rglob("*"))
                for source in sources:
                    if source.is_file():
                        target = self.assets / source.relative_to(incoming / "assets")
                        if target.exists() and target.read_bytes() != source.read_bytes():
                            raise DeployError("Asset name collision; do not overwrite immutable assets.")
                for source in sources:
                    if source.is_file():
                        target = self.assets / source.relative_to(incoming / "assets")
                        target.parent.mkdir(parents=True, exist_ok=True)
                        for directory in target.parents:
                            if directory == self.assets:
                                break
                            directory.chmod(0o755)
                        if not target.exists():
                            # Under the CLI's exclusive lock; only complete files become visible.
                            temporary = target.with_name(".upload-" + uuid.uuid4().hex)
                            shutil.copyfile(source, temporary)
                            temporary.chmod(0o644)
                            os.replace(temporary, target)
                os.rename(incoming, destination)
            finally:
                # Only remove this invocation's own, bounded staging directory.
                if incoming.exists() and incoming.parent.resolve() == self.releases.resolve():
                    shutil.rmtree(incoming)
        return destination

    def pointer(self, name):
        link = self.root / name
        if not link.is_symlink():
            if link.exists():
                raise DeployError(name + " must be a managed symlink, not a file/directory.")
            return None
        target = Path(os.readlink(link))
        if len(target.parts) != 2 or target.parts[0] != "releases":
            raise DeployError("Unmanaged symlink: " + name)
        release_id(target.parts[1])
        if not (self.root / target / "index.html").is_file():
            raise DeployError("Broken release pointer: " + name)
        return target.parts[1]

    def set_pointer(self, name, release):
        link = self.root / name
        if release is None:
            link.unlink(missing_ok=True)
            return
        temporary = self.root / (".link-" + uuid.uuid4().hex)
        temporary.symlink_to(Path("releases") / release, target_is_directory=True)
        try:
            os.replace(temporary, link)
        finally:
            temporary.unlink(missing_ok=True)

    def activate(self, name):
        name = release_id(name)
        if not (self.releases / name / "index.html").is_file():
            raise DeployError("Stage this release before activating it.")
        old = self.pointer("current")
        self.pointer("previous")  # Refuse to replace an unmanaged path.
        if old == name:
            self.verify(self.releases / name)
            return
        self.set_pointer("current", name)
        try:
            self.verify(self.releases / name)
            if old is not None:
                self.set_pointer("previous", old)
        except Exception as error:
            self.set_pointer("current", old)
            raise DeployError("Health check failed; current was restored: " + str(error)) from error

    def rollback(self):
        previous = self.pointer("previous")
        if previous is None:
            raise DeployError("No previous release. Nothing changed.")
        self.activate(previous)

    @staticmethod
    def verify_http(release):
        # Dedicated loopback-only Nginx listener, independent of public HTTPS redirects.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for file in [release / "index.html", *sorted((release / "assets").rglob("*"))]:
            if not file.is_file():
                continue
            relative = file.relative_to(release).as_posix()
            request = urllib.request.Request("http://127.0.0.1:8080/" + quote(relative, safe="/"),
                                             headers={"Cache-Control": "no-cache"})
            expected = file.read_bytes()
            with opener.open(request, timeout=10) as response:
                actual = response.read(len(expected) + 1)
                if response.status != 200 or hashlib.sha256(actual).digest() != hashlib.sha256(expected).digest():
                    raise DeployError("HTTP content mismatch: " + relative)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    stage = sub.add_parser("stage", help="Validate/unpack only; does not change current")
    stage.add_argument("archive")
    stage.add_argument("release")
    deploy = sub.add_parser("deploy", help="Stage, switch atomically, verify, restore on failure")
    deploy.add_argument("archive")
    deploy.add_argument("release")
    activate = sub.add_parser("activate")
    activate.add_argument("release")
    sub.add_parser("rollback")
    sub.add_parser("status")
    args = parser.parse_args()
    if sys.platform != "linux" or os.geteuid() != 0:
        parser.error("Run on the Ubuntu server with sudo python3 deploy_site.py ...")
    import fcntl
    site = Site("/var/www/algorithm-motion-lab")
    site.root.mkdir(parents=True, exist_ok=True)
    site.root.chmod(0o755)
    with (site.root / ".deploy.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            if args.action in ("stage", "deploy"):
                site.stage(args.archive, args.release)
            if args.action in ("activate", "deploy"):
                site.activate(args.release)
            if args.action == "rollback":
                site.rollback()
            print("current:", site.pointer("current"))
            print("previous:", site.pointer("previous"))
            if args.action == "stage":
                print("Staged only; live site unchanged.")
        except (DeployError, OSError, tarfile.TarError) as error:
            parser.exit(1, "Deployment stopped: " + str(error) + "\n")


if __name__ == "__main__":
    main()
