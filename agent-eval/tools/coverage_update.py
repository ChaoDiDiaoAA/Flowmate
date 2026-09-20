"""Compatibility entry for the relocated comprehensive coverage command."""
from pathlib import Path
import runpy
import sys

TARGET = Path(__file__).resolve().parent / "comprehensive" / "coverage_update.py"
sys.path.insert(0, str(TARGET.parent))

if __name__ == "__main__":
    runpy.run_path(str(TARGET), run_name="__main__")
else:
    globals().update({
        key: value
        for key, value in runpy.run_path(str(TARGET)).items()
        if not key.startswith("__")
    })
