import pytest

from flowmate_mineru_mcp.batch_guard import BatchLimitExceeded, validate_file_sources


def test_accepts_exactly_200_file_sources() -> None:
    sources = [f"document-{index}.pdf" for index in range(200)]

    validate_file_sources(sources, max_files_per_run=200)


def test_rejects_201_file_sources_before_mcp_execution() -> None:
    sources = [f"document-{index}.pdf" for index in range(201)]

    with pytest.raises(BatchLimitExceeded) as captured:
        validate_file_sources(sources, max_files_per_run=200)

    assert captured.value.file_count == 201
    assert captured.value.max_files_per_run == 200
    assert "201" in str(captured.value)
    assert "200" in str(captured.value)

