"""Shared import roots for comprehensive evaluation-facility tests."""
from pathlib import Path
import sys

PROJECT = Path(__file__).resolve().parents[3]
for path in (
    PROJECT / "agent-eval" / "tools" / "comprehensive",
    PROJECT / "agent-eval" / "tools",
    PROJECT / "agent-eval" / "src",
):
    value = str(path)
    if value not in sys.path:
        sys.path.insert(0, value)
