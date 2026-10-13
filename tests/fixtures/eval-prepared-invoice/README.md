# Prepared invoice engineering fixture

`three-pages.pdf` is an independent synthetic PDF created for the prepared Document registration tests. It has three pages, with the respective text `Page one synthetic item A`, `Page two synthetic item B`, and `Page three synthetic total 3.00`.

Creation and verification used the configured pypdf runtime: PdfWriter with three text streams and a Helvetica font; PdfReader verified three pages and the exact extracted text. No business dataset, Gold, or holdout material was copied into this fixture. The registration tests supply this frozen extraction; the Host does not run a PDF parser or fetch external content.
