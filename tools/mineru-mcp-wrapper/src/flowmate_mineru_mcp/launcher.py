"""Launch upstream MinerU MCP after installing Flowmate safety patches."""

import os

from .patches import install_batch_limit_patch, install_curl_download_patch


HARD_MAX_FILES_PER_RUN = 200
MAX_FILES_ENV_NAME = "FLOWMATE_MINERU_MAX_FILES_PER_RUN"


def get_configured_max_files_per_run() -> int:
    """Return a configured limit that can never exceed the hard ceiling."""

    raw_value = os.getenv(MAX_FILES_ENV_NAME, str(HARD_MAX_FILES_PER_RUN))
    try:
        value = int(raw_value)
    except ValueError as error:
        raise ValueError(f"{MAX_FILES_ENV_NAME} must be an integer") from error
    if not 1 <= value <= HARD_MAX_FILES_PER_RUN:
        raise ValueError(
            f"{MAX_FILES_ENV_NAME} must be between 1 and {HARD_MAX_FILES_PER_RUN}"
        )
    return value


def configure_upstream(*, max_files_per_run: int) -> None:
    """Install patches before upstream imports and registers its server."""

    if not 1 <= max_files_per_run <= HARD_MAX_FILES_PER_RUN:
        raise ValueError(
            f"max_files_per_run must be between 1 and {HARD_MAX_FILES_PER_RUN}"
        )
    install_curl_download_patch()
    install_batch_limit_patch(max_files_per_run=max_files_per_run)


def main() -> None:
    """Run the original MinerU CLI with Flowmate's narrow compatibility layer."""

    configure_upstream(max_files_per_run=get_configured_max_files_per_run())
    from mineru_open_mcp.cli import main as upstream_main

    upstream_main()


if __name__ == "__main__":
    main()

