from flowmate_mineru_mcp.patches import install_batch_limit_patch


def test_batch_patch_rejects_201_sources_in_normalization() -> None:
    from mineru_open_mcp.tools import tools as mineru_tools

    install_batch_limit_patch(max_files_per_run=200)

    sources = [f"document-{index}.pdf" for index in range(201)]

    try:
        mineru_tools._normalize_file_sources(sources)
    except Exception as error:
        assert error.__class__.__name__ == "BatchLimitExceeded"
    else:
        raise AssertionError("201 sources reached MinerU normalization")


def test_batch_patch_advertises_max_items_200() -> None:
    from typing import Annotated

    from mineru_open_mcp.tools import tools as mineru_tools
    from pydantic import TypeAdapter

    install_batch_limit_patch(max_files_per_run=200)

    schema = TypeAdapter(
        Annotated[list[str], mineru_tools._FILE_SOURCES_FIELD]
    ).json_schema()

    assert schema["maxItems"] == 200
