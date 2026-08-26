"""Batch size validation for MinerU MCP calls."""

from collections.abc import Sequence
from typing import Any


class BatchLimitExceeded(ValueError):
    """Raised before MCP execution when a batch exceeds its configured limit."""

    def __init__(self, file_count: int, max_files_per_run: int) -> None:
        self.file_count = file_count
        self.max_files_per_run = max_files_per_run
        super().__init__(
            f"MinerU batch contains {file_count} files; maximum per run is {max_files_per_run}"
        )


def validate_file_sources(
    file_sources: Sequence[Any],
    *,
    max_files_per_run: int,
) -> None:
    """Reject oversized batches before any network or MCP work begins."""

    file_count = len(file_sources)
    if file_count > max_files_per_run:
        raise BatchLimitExceeded(file_count, max_files_per_run)

