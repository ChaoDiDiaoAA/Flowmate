from flowmate_mineru_mcp.launcher import configure_upstream


def test_configure_upstream_installs_download_and_batch_patches() -> None:
    from mineru._api import ApiClient
    from mineru_open_mcp.tools import tools as mineru_tools

    configure_upstream(max_files_per_run=200)

    assert ApiClient.download.__module__ == "flowmate_mineru_mcp.patches"

    sources = [f"document-{index}.pdf" for index in range(201)]
    try:
        mineru_tools._normalize_file_sources(sources)
    except Exception as error:
        assert error.__class__.__name__ == "BatchLimitExceeded"
    else:
        raise AssertionError("launcher did not install the 200-file guard")

