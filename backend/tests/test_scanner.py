from pathlib import Path

import pytest

from backend.observer import scanner
from backend.observer.scanner import resolve_root, scan_project


def write(root: Path, path: str, content: str = "") -> Path:
    file = root / path
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(content, encoding="utf-8")
    return file


def test_python_imports_resolve_packages_relative_modules_and_src_layout(tmp_path):
    write(tmp_path, "src/app/__init__.py")
    write(tmp_path, "src/app/service.py", "from . import repository\nfrom .models import User\nimport os\n")
    write(tmp_path, "src/app/repository.py", "from ..shared import helper\n")
    write(tmp_path, "src/app/models.py", "class User: pass\n")
    write(tmp_path, "src/shared.py", "def helper(): pass\n")
    write(tmp_path, "main.py", "import app.service\nfrom app import repository\n")
    result = scan_project(tmp_path)
    assert set(result.edges) == {
        ("main.py", "src/app/service.py", "imports"),
        ("main.py", "src/app/__init__.py", "imports"),
        ("main.py", "src/app/repository.py", "imports"),
        ("src/app/service.py", "src/app/__init__.py", "imports"),
        ("src/app/service.py", "src/app/repository.py", "imports"),
        ("src/app/service.py", "src/app/models.py", "imports"),
        ("src/app/repository.py", "src/shared.py", "imports"),
    }
    assert not result.warnings
    assert not result.truncated


def test_javascript_imports_exports_require_index_and_typescript_js_specifiers(tmp_path):
    write(
        tmp_path,
        "src/App.tsx",
        """
import { Client } from './client.js'
import './styles.css'
export { button } from './components'
const lazy = import('./lazy')
const config = require('../config.json')
import React from 'react'
import unknownAlias from '@/not-configured'
// import fake from './commented'
/* export { ignored } from './commented' */
const docs = "import fake from './commented'";
const example = `require('./commented')`;
const notLiteral = require('./commented' + variable);
someObject.require('./commented');
""",
    )
    for path in (
        "src/client.ts",
        "src/styles.css",
        "src/components/index.ts",
        "src/lazy.ts",
        "config.json",
        "src/commented.ts",
    ):
        write(tmp_path, path)
    result = scan_project(tmp_path)
    assert set(result.edges) == {
        ("src/App.tsx", target, "imports")
        for target in (
            "src/client.ts",
            "src/styles.css",
            "src/components/index.ts",
            "src/lazy.ts",
            "config.json",
        )
    }
    assert result.files["src/App.tsx"].kind == "frontend"
    assert result.files["src/styles.css"].kind == "style"
    assert result.files["config.json"].kind == "config"


def test_root_ignore_rules_negations_and_builtin_safety_exclusions(tmp_path):
    write(tmp_path, ".gitignore", "generated/\n*.skip.ts\n!keep.skip.ts\nroot-only.py\n")
    write(tmp_path, ".codewatchignore", "private/\nkeep.skip.ts\n")
    for path in (
        "main.py",
        "generated/output.py",
        "deep/a.skip.ts",
        "keep.skip.ts",
        "root-only.py",
        "private/internal.py",
        "node_modules/dependency/index.js",
        ".venv/lib/library.py",
        ".local/state.json",
        ".env",
        ".env.production",
        "secrets.json",
        "local.credentials.json",
        "secrets/hidden.py",
        "server.key",
        "package-lock.json",
        "dist/bundle.js",
    ):
        write(tmp_path, path)
    assert set(scan_project(tmp_path).files) == {"main.py"}


def test_ignore_negation_can_restore_a_nonexcluded_file(tmp_path):
    write(tmp_path, ".gitignore", "*.ts\n!keep.ts\n")
    write(tmp_path, "keep.ts")
    write(tmp_path, "drop.ts")
    assert set(scan_project(tmp_path).files) == {"keep.ts"}


def test_changes_and_deletions_update_signatures_and_dependency_graph(tmp_path):
    first = write(tmp_path, "first.py", "import second\n")
    second = write(tmp_path, "second.py", "x = 1\n")
    initial = scan_project(tmp_path)
    second.write_text("x = 2\n", encoding="utf-8")
    updated = scan_project(tmp_path)
    assert initial.files["first.py"].signature == updated.files["first.py"].signature
    assert initial.files["second.py"].signature != updated.files["second.py"].signature
    second.unlink()
    removed = scan_project(tmp_path)
    assert set(removed.files) == {"first.py"}
    assert removed.edges == []
    assert first.read_text(encoding="utf-8") == "import second\n"


def test_invalid_python_partial_writes_and_binary_data_do_not_crash(tmp_path):
    write(tmp_path, "incomplete.py", "from . import (")
    write(tmp_path, "valid.py", "import incomplete\n")
    (tmp_path / "binary.ts").write_bytes(b"\x00\x01\x02import 'valid'")
    result = scan_project(tmp_path)
    assert set(result.files) == {"incomplete.py", "valid.py"}
    assert result.edges == [("valid.py", "incomplete.py", "imports")]
    assert any("incomplete.py" in warning for warning in result.warnings)
    assert any("binary" in warning for warning in result.warnings)


def test_python_source_encoding_is_respected(tmp_path):
    (tmp_path / "encoded.py").write_bytes("# coding: latin-1\n# café\nimport other\n".encode("latin-1"))
    write(tmp_path, "other.py")
    assert scan_project(tmp_path).edges == [("encoded.py", "other.py", "imports")]


def test_file_and_byte_caps_are_explicit(tmp_path):
    write(tmp_path, "a.py", "x = 1\n")
    write(tmp_path, "b.py", "x = 2\n")
    result = scan_project(tmp_path, max_files=1)
    assert len(result.files) == 1
    assert result.truncated and any("File limit" in warning for warning in result.warnings)
    large = scan_project(tmp_path, max_bytes=3)
    assert not large.files and large.truncated
    assert len(large.warnings) == 2
    for invalid in (0, -1, 50_001):
        with pytest.raises(ValueError):
            scan_project(tmp_path, max_files=invalid)


def test_directory_depth_and_total_byte_limits(tmp_path, monkeypatch):
    monkeypatch.setattr(scanner, "_MAX_DEPTH", 1)
    write(tmp_path, "first/second/deep.py")
    assert scan_project(tmp_path).truncated
    write(tmp_path, "a.py", "x = 1")
    monkeypatch.setattr(scanner, "_MAX_TOTAL_BYTES", 2)
    result = scan_project(tmp_path)
    assert result.truncated and any("Total source size" in warning for warning in result.warnings)


def test_directory_traversal_is_bounded_even_for_unsupported_files(tmp_path, monkeypatch):
    monkeypatch.setattr(scanner, "_MAX_ENTRIES", 3)
    for number in range(6):
        write(tmp_path, f"{number}.txt")
    result = scan_project(tmp_path)
    assert result.truncated
    assert any("Directory entry limit" in warning for warning in result.warnings)


def test_files_disappearing_or_becoming_unreadable_are_nonfatal(tmp_path, monkeypatch):
    write(tmp_path, "gone.py")
    write(tmp_path, "safe.py")
    original = scanner._read_file

    def read(root, path, limit):
        if path.name == "gone.py":
            raise PermissionError("temporarily inaccessible")
        return original(root, path, limit)

    monkeypatch.setattr(scanner, "_read_file", read)
    result = scan_project(tmp_path)
    assert set(result.files) == {"safe.py"}
    assert result.truncated
    assert any("Could not read gone.py" in warning for warning in result.warnings)


def test_unreadable_ignore_rules_pause_scan_instead_of_exposing_ignored_files(tmp_path, monkeypatch):
    write(tmp_path, "private.py")
    original = scanner._read_file

    def read(root, path, limit):
        if path.name == ".gitignore":
            raise PermissionError("cannot read ignore rules")
        return original(root, path, limit)

    monkeypatch.setattr(scanner, "_read_file", read)
    result = scan_project(tmp_path)
    assert result.files == {} and result.truncated
    assert "scan paused" in result.warnings[0]


def test_symlink_files_and_directories_are_never_followed(tmp_path):
    project = tmp_path / "project"
    outside = tmp_path / "outside"
    project.mkdir()
    outside.mkdir()
    target = write(outside, "private.py", "x = 'outside'\n")
    safe = write(project, "safe.py")
    try:
        (project / "linked.py").symlink_to(target)
        (project / "linked_dir").symlink_to(outside, target_is_directory=True)
        (project / "internal.py").symlink_to(safe)
    except OSError:
        pytest.skip("This Windows account cannot create symlinks")
    assert set(scan_project(project).files) == {"safe.py"}


def test_windows_reparse_points_are_treated_as_links():
    from types import SimpleNamespace

    metadata = SimpleNamespace(st_mode=0o040755, st_file_attributes=0x400)
    assert scanner._is_link(Path("junction"), metadata)


def test_imports_cannot_escape_project_or_reach_ignored_files(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    write(tmp_path, "outside.ts")
    write(project, ".codewatchignore", "hidden.ts\n")
    write(project, "hidden.ts")
    write(project, "main.ts", "import '../outside'; import './hidden'; import './ok';")
    write(project, "ok.ts")
    assert scan_project(project).edges == [("main.ts", "ok.ts", "imports")]


def test_other_languages_are_nodes_without_invented_import_edges(tmp_path):
    write(tmp_path, "main.go", 'package main\nimport "helper"\n')
    write(tmp_path, "helper.go", "package helper\n")
    write(tmp_path, "tests/test_api.py")
    write(tmp_path, "backend/routes/users.py")
    write(tmp_path, "backend/repositories/users.py")
    write(tmp_path, "db/schema.sql")
    result = scan_project(tmp_path)
    assert result.files["main.go"].language == "Go"
    assert result.files["tests/test_api.py"].kind == "test"
    assert result.files["backend/routes/users.py"].kind == "api"
    assert result.files["backend/repositories/users.py"].kind == "repository"
    assert result.files["db/schema.sql"].kind == "database"
    assert result.edges == []


def test_resolve_root_requires_a_readable_project_directory(tmp_path):
    assert resolve_root(str(tmp_path)) == tmp_path.resolve()
    file = write(tmp_path, "file.py")
    for invalid in ("", str(file), str(tmp_path / "missing"), str(tmp_path.anchor)):
        with pytest.raises(ValueError):
            resolve_root(invalid)
