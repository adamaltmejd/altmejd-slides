#!/usr/bin/env python3
"""Repository entry point for the renderer shipped with the extension."""

import importlib.util
import sys
from pathlib import Path

source = (
    Path(__file__).resolve().parents[1]
    / "_extensions/altmejd-slides/tools/pdf/render_revealjs_pdfs.py"
)
module_name = __name__ if __name__ != "__main__" else "_altmejd_pdf_renderer"
spec = importlib.util.spec_from_file_location(module_name, source)
assert spec is not None and spec.loader is not None
renderer = importlib.util.module_from_spec(spec)
sys.modules[module_name] = renderer
spec.loader.exec_module(renderer)

if __name__ == "__main__":
    raise SystemExit(renderer.main())
