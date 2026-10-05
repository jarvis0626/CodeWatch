from pathlib import Path
from PyInstaller.utils.hooks import collect_submodules, copy_metadata

root = Path(SPECPATH).parent
a = Analysis(
    [str(root / 'backend' / 'desktop_entry.py')],
    pathex=[str(root)],
    datas=[(str(root / 'frontend' / 'dist'), 'frontend/dist'), *copy_metadata('mcp')],
    hiddenimports=collect_submodules('uvicorn') + collect_submodules('mcp.server') + collect_submodules('mcp.shared'),
    excludes=['pytest', 'ruff', 'tkinter', 'IPython', 'matplotlib'],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, a.binaries, a.datas, [],
    name='codewatch-helper', debug=False, bootloader_ignore_signals=False,
    strip=False, upx=False, console=True,
)
