"""Bounded, read-only source scanning. Edges describe imports, not runtime calls."""

from __future__ import annotations

import ast
import hashlib
import io
import os
import re
import stat
import tokenize
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

import pathspec


@dataclass(frozen=True, slots=True)
class ObservedFile:
    path: str
    kind: str
    language: str
    signature: str


@dataclass(slots=True)
class ProjectSnapshot:
    files: dict[str, ObservedFile]
    edges: list[tuple[str, str, str]]
    warnings: list[str]
    truncated: bool


_LANGUAGES = {
    ".py": "Python",
    ".pyi": "Python",
    ".js": "JavaScript",
    ".jsx": "JavaScript",
    ".mjs": "JavaScript",
    ".cjs": "JavaScript",
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".mts": "TypeScript",
    ".cts": "TypeScript",
    ".vue": "Vue",
    ".svelte": "Svelte",
    ".html": "HTML",
    ".css": "CSS",
    ".scss": "SCSS",
    ".sass": "Sass",
    ".less": "Less",
    ".json": "JSON",
    ".yaml": "YAML",
    ".yml": "YAML",
    ".toml": "TOML",
    ".ini": "INI",
    ".xml": "XML",
    ".sql": "SQL",
    ".prisma": "Prisma",
    ".graphql": "GraphQL",
    ".gql": "GraphQL",
    ".go": "Go",
    ".rs": "Rust",
    ".java": "Java",
    ".kt": "Kotlin",
    ".kts": "Kotlin",
    ".c": "C",
    ".h": "C",
    ".cpp": "C++",
    ".hpp": "C++",
    ".cc": "C++",
    ".cs": "C#",
    ".rb": "Ruby",
    ".php": "PHP",
    ".swift": "Swift",
    ".proto": "Protobuf",
    ".sh": "Shell",
    ".ps1": "PowerShell",
}
_JS_EXTENSIONS = (".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".json", ".vue", ".svelte")
_JS_LANGUAGES = {"JavaScript", "TypeScript", "Vue", "Svelte"}
_EXCLUDED_DIRS = {
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "bower_components",
    "vendor",
    ".venv",
    "venv",
    "env",
    "__pycache__",
    "dist",
    "build",
    "target",
    ".next",
    ".nuxt",
    ".output",
    ".svelte-kit",
    ".pytest_cache",
    ".ruff_cache",
    ".mypy_cache",
    ".tox",
    ".cache",
    ".npm-cache",
    ".local",
    "coverage",
    "test-results",
    "playwright-report",
    ".idea",
    ".ssh",
    ".aws",
    ".azure",
    ".kube",
    "secrets",
    ".secrets",
    "credentials",
    ".credentials",
}
_SECRET_EXTENSIONS = {".pem", ".key", ".p12", ".pfx", ".crt", ".cer", ".der", ".keystore"}
_MAX_DEPTH = 32
_MAX_WARNINGS = 50
_MAX_FILES = 5_000
_MAX_BYTES = 2_000_000
_MAX_ENTRIES = 50_000
_MAX_TOTAL_BYTES = 32_000_000


def resolve_root(path: str) -> Path:
    """Resolve an explicit project directory, rejecting missing paths and drive roots."""
    if not isinstance(path, str) or not path.strip():
        raise ValueError("Enter an existing project directory.")
    try:
        root = Path(path).expanduser().resolve(strict=True)
        if not root.is_dir():
            raise ValueError("The project path must be a directory.")
        if root.parent == root:
            raise ValueError("Choose a project directory, not a filesystem or drive root.")
        with os.scandir(root):
            pass
        return root
    except (OSError, RuntimeError) as exc:
        raise ValueError("The project directory does not exist or cannot be read.") from exc


def _is_link(path: Path, file_stat: os.stat_result) -> bool:
    # Reparse points include Windows junctions, which is_symlink alone does not cover.
    return stat.S_ISLNK(file_stat.st_mode) or bool(
        getattr(file_stat, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    )


def _inside(root: Path, path: Path) -> bool:
    try:
        path.resolve(strict=True).relative_to(root)
        return True
    except (OSError, RuntimeError, ValueError):
        return False


def _read_file(root: Path, path: Path, limit: int) -> bytes:
    """Bound reads and reject links/non-regular files, including changed identities."""
    before = path.lstat()
    if _is_link(path, before) or not stat.S_ISREG(before.st_mode) or not _inside(root, path):
        raise OSError("not a regular file inside the project")
    if before.st_size > limit:
        raise OverflowError("file exceeds the size limit")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    with os.fdopen(descriptor, "rb") as stream:
        opened = os.fstat(stream.fileno())
        if not stat.S_ISREG(opened.st_mode) or (before.st_dev, before.st_ino) != (
            opened.st_dev,
            opened.st_ino,
        ):
            raise OSError("file changed while opening")
        if not _inside(root, path):
            raise OSError("file moved outside the project")
        content = stream.read(limit + 1)
    if len(content) > limit:
        raise OverflowError("file exceeds the size limit")
    return content


def is_sensitive_name(name: str) -> bool:
    lowered = name.lower()
    return (
        lowered.startswith(".env")
        or Path(lowered).suffix in _SECRET_EXTENSIONS
        or lowered in {"id_rsa", "id_ed25519", ".npmrc", ".pypirc", ".netrc"}
        or re.match(r"(?:secrets?|credentials?)(?:[._-]|$)", lowered) is not None
        or re.search(r"[._-](?:secrets?|credentials?)(?:[._-]|$)", lowered) is not None
        or lowered in {"package-lock.json", "composer.lock", "yarn.lock", "pnpm-lock.yaml", "uv.lock"}
        or lowered.endswith((".min.js", ".min.css"))
    )


def _kind(path: str) -> str:
    file = PurePosixPath(path)
    parts = {part.lower() for part in file.parts[:-1]}
    name, suffix = file.name.lower(), file.suffix.lower()
    if parts & {"tests", "test", "__tests__", "spec", "specs", "e2e"} or (
        name.startswith("test_") or re.search(r"(?:\.test\.|\.spec\.|_test\.|_spec\.)", name)
    ):
        return "test"
    if suffix in {".css", ".scss", ".sass", ".less"}:
        return "style"
    if (
        suffix in {".json", ".yaml", ".yml", ".toml", ".ini", ".xml"}
        or ".config." in name
        or name
        in {
            "dockerfile",
            "makefile",
        }
    ):
        return "config"
    if suffix in {".sql", ".prisma"} or parts & {"migrations", "database", "db", "schema"}:
        return "database"
    if (
        parts & {"repositories", "repository", "persistence", "data_access"}
        or "repository" in file.stem.lower()
    ):
        return "repository"
    if parts & {"api", "routes", "routers", "endpoints", "controllers", "handlers"}:
        return "api"
    if parts & {"frontend", "client", "ui", "components", "views", "pages"} or suffix in {
        ".jsx",
        ".tsx",
        ".vue",
        ".svelte",
        ".html",
    }:
        return "frontend"
    if parts & {"services", "service", "backend", "server"}:
        return "service"
    return "module"


def _python_edges(path: str, source: str, files: dict[str, ObservedFile]) -> set[tuple[str, str, str]]:
    tree = ast.parse(source, filename=path)
    edges: set[tuple[str, str, str]] = set()
    parent = PurePosixPath(path).parent
    # Python commonly runs with the repository root, src/, or script directory on sys.path.
    roots = [PurePosixPath("."), PurePosixPath("src"), parent]

    def resolve(base: PurePosixPath, dotted: str) -> str | None:
        target = base.joinpath(*dotted.split(".")) if dotted else base
        for candidate in (str(target) + ".py", str(target) + ".pyi", str(target / "__init__.py")):
            candidate = str(PurePosixPath(candidate))
            if candidate in files:
                return candidate
        return None

    def add(target: str | None) -> None:
        if target and target != path:
            edges.add((path, target, "imports"))

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                for base in roots:
                    target = resolve(base, alias.name)
                    if target:
                        add(target)
                        break
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                # A relative import cannot climb above the scanned project.
                if node.level > len(parent.parts):
                    continue
                base = parent
                for _ in range(node.level - 1):
                    base = base.parent
                bases = [base]
            else:
                bases = roots
            module = node.module or ""
            for base in bases:
                module_target = resolve(base, module)
                child_targets = [
                    resolve(base, ".".join(part for part in (module, alias.name) if part))
                    for alias in node.names
                    if alias.name != "*"
                ]
                if module_target or any(child_targets):
                    add(module_target)
                    for target in child_targets:
                        add(target)
                    break
    return edges


_JS_TOKEN = re.compile(
    r"(?P<comment>//[^\r\n]*|/\*[\s\S]*?\*/)"
    r"|(?P<string>\"(?:\\[\s\S]|[^\"\\])*\"|'(?:\\[\s\S]|[^'\\])*')"
    r"|(?P<template>`(?:\\[\s\S]|[^`\\])*`)"
    r"|(?P<identifier>[A-Za-z_$][\w$]*)|(?P<punct>[^\s])"
)


def _js_imports(source: str) -> set[str]:
    # Tokenizing strings/comments prevents examples and commented-out code creating edges.
    tokens = [
        (match.lastgroup, match.group())
        for match in _JS_TOKEN.finditer(source)
        if match.lastgroup not in {"comment", "template"}
    ]
    imports: set[str] = set()
    for index, (kind, value) in enumerate(tokens):
        if kind != "identifier" or value not in {"import", "export", "require"}:
            continue
        if index and tokens[index - 1][1] in {".", "?."}:
            continue
        following = tokens[index + 1 : index + 100]
        if not following:
            continue
        candidate: str | None = None
        if value in {"import", "require"} and len(following) >= 2 and following[0][1] == "(":
            # Only literal dynamic imports/requires; concatenations are intentionally unresolved.
            if len(following) >= 3 and following[1][0] == "string" and following[2][1] in {")", ","}:
                candidate = following[1][1]
        elif value == "import" and following[0][0] == "string":
            candidate = following[0][1]
        elif value in {"import", "export"}:
            for offset, item in enumerate(following[:-1]):
                if item[1] in {";", "="}:
                    break
                if item == ("identifier", "from") and following[offset + 1][0] == "string":
                    candidate = following[offset + 1][1]
                    break
        if candidate and "\\" not in candidate:
            imports.add(candidate[1:-1])
    return imports


def _js_edges(path: str, source: str, files: dict[str, ObservedFile]) -> set[tuple[str, str, str]]:
    edges: set[tuple[str, str, str]] = set()
    for specifier in _js_imports(source):
        if not specifier.startswith(("./", "../")):
            continue
        specifier = re.split(r"[?#]", specifier, maxsplit=1)[0]
        parts: list[str] = []
        escaped = False
        for part in (PurePosixPath(path).parent / specifier).parts:
            if part == "..":
                if not parts:
                    escaped = True
                    break
                parts.pop()
            elif part != ".":
                parts.append(part)
        if escaped:
            continue
        target = "/".join(parts)
        candidates = [target]
        # TypeScript permits a .js import specifier for a .ts/.tsx source module.
        suffix = PurePosixPath(target).suffix
        if suffix in {".js", ".jsx", ".mjs", ".cjs"}:
            replacements = {".js": (".ts", ".tsx"), ".jsx": (".tsx",), ".mjs": (".mts",), ".cjs": (".cts",)}
            candidates.extend(target[: -len(suffix)] + extension for extension in replacements[suffix])
        if not suffix:
            candidates.extend(target + extension for extension in _JS_EXTENSIONS)
            candidates.extend(target + "/index" + extension for extension in _JS_EXTENSIONS)
        for candidate in candidates:
            if candidate in files:
                if candidate != path:
                    edges.add((path, candidate, "imports"))
                break
    return edges


def scan_project(root: Path, max_files: int = 500, max_bytes: int = 512_000) -> ProjectSnapshot:
    """Scan source/config files without execution; honor root-level ignore files.

    Caps are per-file bytes, file count, 32 MiB total content, 32 directory levels,
    and at most 50,000 directory entries. Python and relative JS/TS imports are
    best-effort static analysis; third-party packages and dynamic paths are omitted.
    """
    root = resolve_root(str(root))
    if not isinstance(max_files, int) or not 1 <= max_files <= _MAX_FILES:
        raise ValueError(f"max_files must be between 1 and {_MAX_FILES}.")
    if not isinstance(max_bytes, int) or not 1 <= max_bytes <= _MAX_BYTES:
        raise ValueError(f"max_bytes must be between 1 and {_MAX_BYTES}.")
    warnings: list[str] = []
    truncated = False

    def warn(message: str) -> None:
        if len(warnings) < _MAX_WARNINGS:
            warnings.append(message)

    ignore_lines: list[str] = []
    for ignore_name in (".gitignore", ".codewatchignore"):
        try:
            ignore_lines.extend(_read_file(root, root / ignore_name, 64_000).decode("utf-8-sig").splitlines())
        except FileNotFoundError:
            pass
        except (OSError, OverflowError, UnicodeError):
            # Fail closed: do not risk displaying files the unreadable rules might exclude.
            return ProjectSnapshot(
                {}, [], [f"Cannot read {ignore_name}; scan paused until ignore rules are readable."], True
            )
    try:
        ignores = pathspec.GitIgnoreSpec.from_lines(ignore_lines)
    except (ValueError, TypeError) as exc:
        return ProjectSnapshot({}, [], [f"Invalid ignore rules; scan paused: {type(exc).__name__}."], True)

    files: dict[str, ObservedFile] = {}
    sources: dict[str, str] = {}
    stack = [(root, 0)]
    entry_count = 0
    total_bytes = 0
    entry_limit = min(_MAX_ENTRIES, max(5_000, max_files * 20))
    stop = False
    while stack and not stop:
        directory, depth = stack.pop()
        try:
            info = directory.lstat()
            if _is_link(directory, info) or not _inside(root, directory):
                continue
            entries = []
            with os.scandir(directory) as iterator:
                for entry in iterator:
                    entry_count += 1
                    if entry_count > entry_limit:
                        truncated = stop = True
                        warn(
                            f"Directory entry limit ({entry_limit}) reached; narrow the project or add ignore rules."
                        )
                        break
                    entries.append(entry)
            child_dirs = []
            for entry in sorted(entries, key=lambda item: item.name.casefold()):
                path = Path(entry.path)
                relative = path.relative_to(root).as_posix()
                try:
                    info = entry.stat(follow_symlinks=False)
                    if _is_link(path, info):
                        continue
                    is_directory = stat.S_ISDIR(info.st_mode)
                    if is_sensitive_name(entry.name) or ignores.match_file(
                        relative + ("/" if is_directory else "")
                    ):
                        continue
                    if is_directory:
                        if entry.name.lower() in _EXCLUDED_DIRS:
                            continue
                        if depth >= _MAX_DEPTH:
                            truncated = True
                            warn(f"Directory depth limit reached at {relative}.")
                        else:
                            child_dirs.append((path, depth + 1))
                        continue
                    language = _LANGUAGES.get(path.suffix.lower())
                    if path.name.lower() in {"dockerfile", "makefile"}:
                        language = path.name
                    if not language or not stat.S_ISREG(info.st_mode):
                        continue
                    if len(files) >= max_files:
                        truncated = stop = True
                        warn(f"File limit ({max_files}) reached; narrow the project or add ignore rules.")
                        break
                    content = _read_file(root, path, max_bytes)
                    total_bytes += len(content)
                    if total_bytes > _MAX_TOTAL_BYTES:
                        truncated = stop = True
                        warn(
                            "Total source size limit (32 MB) reached; narrow the project or add ignore rules."
                        )
                        break
                    if (
                        b"\x00" in content
                        or sum(byte < 32 and byte not in (9, 10, 13, 12) for byte in content)
                        > len(content) * 0.02
                    ):
                        warn(f"Skipped binary content: {relative}.")
                        continue
                    if language == "Python":
                        try:
                            encoding, _ = tokenize.detect_encoding(io.BytesIO(content).readline)
                            source = content.decode(encoding)
                        except (SyntaxError, UnicodeError, LookupError):
                            source = content.decode("utf-8", errors="replace")
                            warn(f"Could not decode Python source completely: {relative}.")
                    else:
                        source = content.decode("utf-8-sig", errors="replace")
                    files[relative] = ObservedFile(
                        relative, _kind(relative), language, hashlib.sha256(content).hexdigest()
                    )
                    if language == "Python" or language in _JS_LANGUAGES:
                        sources[relative] = source
                except OverflowError:
                    truncated = True
                    warn(f"Skipped file above {max_bytes:,} bytes: {relative}.")
                except (OSError, ValueError):
                    truncated = True
                    warn(f"Could not read {relative}; it may have changed during the scan.")
            stack.extend(reversed(child_dirs))
        except OSError:
            truncated = True
            warn(f"Could not read directory: {directory.relative_to(root).as_posix()}.")

    edges: set[tuple[str, str, str]] = set()
    for path, source in sources.items():
        try:
            if files[path].language == "Python":
                edges.update(_python_edges(path, source, files))
            else:
                edges.update(_js_edges(path, source, files))
        except (SyntaxError, ValueError, RecursionError):
            warn(f"Imports unavailable for {path}; source may be incomplete or invalid.")
    return ProjectSnapshot(files, sorted(edges), warnings, truncated)
