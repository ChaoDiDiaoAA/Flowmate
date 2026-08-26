import subprocess

import pytest

from flowmate_mineru_mcp.curl_downloader import CurlDownloadError, download_bytes_with_curl


def test_download_uses_curl_without_a_shell() -> None:
    observed: dict[str, object] = {}

    def fake_runner(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        observed["command"] = command
        observed["kwargs"] = kwargs
        return subprocess.CompletedProcess(command, 0, stdout=b"zip-bytes", stderr=b"")

    content = download_bytes_with_curl(
        "https://cdn.example.test/result.zip?signature=secret",
        runner=fake_runner,
    )

    assert content == b"zip-bytes"
    assert isinstance(observed["command"], list)
    assert observed["command"][0] == "curl.exe"
    assert observed["kwargs"]["shell"] is False


def test_download_error_does_not_expose_signed_url() -> None:
    signed_url = "https://cdn.example.test/result.zip?signature=super-secret"

    def failing_runner(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        return subprocess.CompletedProcess(command, 35, stdout=b"", stderr=b"TLS failure")

    with pytest.raises(CurlDownloadError) as captured:
        download_bytes_with_curl(signed_url, runner=failing_runner)

    assert signed_url not in str(captured.value)
    assert "super-secret" not in str(captured.value)
    assert "curl" in str(captured.value).lower()


def test_download_timeout_does_not_expose_signed_url() -> None:
    signed_url = "https://cdn.example.test/result.zip?signature=timeout-secret"

    def timeout_runner(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        raise subprocess.TimeoutExpired(command, timeout=340)

    with pytest.raises(CurlDownloadError) as captured:
        download_bytes_with_curl(signed_url, runner=timeout_runner)

    assert signed_url not in str(captured.value)
    assert "timeout-secret" not in str(captured.value)
    assert "timed out" in str(captured.value).lower()
