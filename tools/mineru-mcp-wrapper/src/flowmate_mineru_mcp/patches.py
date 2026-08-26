"""Narrow runtime patches applied before MinerU registers its MCP tools."""

from typing import Any

from pydantic import Field

from .batch_guard import validate_file_sources
from .curl_downloader import download_bytes_with_curl, download_text_with_curl


def install_batch_limit_patch(*, max_files_per_run: int) -> None:
    """Add schema and runtime enforcement before upstream parsing begins."""

    from mineru_open_mcp.tools import tools as mineru_tools

    original_normalize = getattr(
        mineru_tools,
        "_flowmate_original_normalize_file_sources",
        mineru_tools._normalize_file_sources,
    )
    mineru_tools._flowmate_original_normalize_file_sources = original_normalize

    def guarded_normalize(file_sources: list[Any]):
        validate_file_sources(file_sources, max_files_per_run=max_files_per_run)
        return original_normalize(file_sources)

    mineru_tools._normalize_file_sources = guarded_normalize
    mineru_tools._FILE_SOURCES_FIELD = Field(
        description=mineru_tools._FILE_SOURCES_FIELD.description,
        max_length=max_files_per_run,
    )


def install_curl_download_patch() -> None:
    """Use curl/Schannel only for MinerU result artifact downloads."""

    from mineru._api import ApiClient
    from mineru._flash_api import FlashApiClient

    def download_bytes(_client: ApiClient, url: str) -> bytes:
        return download_bytes_with_curl(url)

    def download_text(_client: FlashApiClient, url: str) -> str:
        return download_text_with_curl(url)

    ApiClient.download = download_bytes
    FlashApiClient.download_text = download_text

