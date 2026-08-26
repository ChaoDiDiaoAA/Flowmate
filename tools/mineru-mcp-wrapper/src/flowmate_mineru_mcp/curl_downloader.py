"""Schannel-backed downloads for MinerU result artifacts on Windows."""

import subprocess
from collections.abc import Callable


class CurlDownloadError(RuntimeError):
    """Raised when curl cannot download a MinerU result artifact."""


Runner = Callable[..., subprocess.CompletedProcess[bytes]]


def download_bytes_with_curl(
    url: str,
    *,
    runner: Runner = subprocess.run,
) -> bytes:
    """Download bytes with Windows curl without invoking a shell."""

    command = [
        "curl.exe",
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        "--max-time",
        "330",
        "--url",
        url,
    ]
    try:
        completed = runner(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            shell=False,
            timeout=340,
        )
    except subprocess.TimeoutExpired:
        raise CurlDownloadError("curl download timed out after 340 seconds") from None
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", errors="replace").strip()
        safe_detail = detail.replace(url, "<signed-url-redacted>")
        raise CurlDownloadError(
            f"curl download failed with exit code {completed.returncode}: {safe_detail}"
        )
    return completed.stdout


def download_text_with_curl(
    url: str,
    *,
    runner: Runner = subprocess.run,
) -> str:
    """Download UTF-8 text with the same Schannel-backed transport."""

    return download_bytes_with_curl(url, runner=runner).decode("utf-8")
