---
license: cc-by-4.0
pretty_name: Invoice Extraction Benchmark v1
language:
  - en
task_categories:
  - image-to-text
  - document-question-answering
tags:
  - invoice
  - invoice-extraction
  - ocr
  - document-ai
  - idp
  - accounts-payable
  - benchmark
  - synthetic
size_categories:
  - n<1K
configs:
  - config_name: default
    data_files:
      - split: test
        path: corpus/v1/metadata.jsonl
---

# Invoice Extraction Benchmark v1

A synthetic test set for invoice data extraction (invoice OCR, intelligent document
processing, accounts-payable capture): **181 documents with answer keys and a scorer**.
Run any invoice reader over the documents, write its output as one JSON file, and score it
field by field.

Source, scorer and generator: https://github.com/DrewKraken/invoice-extraction-benchmark
(this dataset is a mirror of `corpus/v1/` there; the GitHub repository is canonical).

**Who made it.** The set was made by [InvoiceParser Pro](https://invoiceparserpro.com) (IPP),
a company that sells an invoice extraction product. It is not an independent benchmark;
weigh IPP's own results below with that in mind.

## Contents

- `corpus/v1/documents/`: 181 documents. 113 PDF (digital, with a text layer), 53 JPEG
  (phone photos and handwritten), 15 PNG (scans). 220 pages in all.
- `corpus/v1/answers/<doc_id>.json`: the answer key for each document.
- `corpus/v1/manifest.json`: every document with category, difficulty, damage, sha256 and
  answer key.
- `corpus/v1/metadata.jsonl`: the same, one row per document (`file_name` is relative to
  `corpus/v1/`). This is what the dataset viewer shows.

| Category | Docs | What it tests |
|---|---:|---|
| clean | 31 | Digital PDFs: varied headers and tables, US/UK/EU/ZA date and number formats |
| currency | 19 | USD, ZAR, NAD, EUR, GBP, ZMW; bare `$` on a Namibian invoice; dual-currency payable boxes; lines in several currencies |
| tax | 14 | VAT columns, VAT-inclusive totals, "Sub Total" after VAT, zero-rated, percentage lines, withholding |
| credit | 10 | Credit notes printed with minus, `R -`, brackets, `CR`, or no sign at all |
| multipage | 10 | 2 to 8 pages, carried/brought-forward rows |
| freight | 16 | Carrier and clearing & forwarding invoices, trip/load references |
| scan | 15 | 5 scan looks x 3 grades (grayscale, noise, fax, punch holes, stamps) |
| photo | 45 | 15 phone-photo problems x 3 grades (blur, perspective, rotation, low light, shadow, JPEG, crumples, stains, pen marks, crops, screen photo...) |
| handwritten | 8 | Invoice books filled in by hand, three legibility grades |
| hard | 13 | Several invoices in one file, statements, order number beside invoice number, no invoice number, totals that do not add up |

Every vendor, customer, number and amount is generated; no customer document was read,
copied or imitated. Company names are built from common words (place + trade + legal form)
and may coincide with a real business by accident. 10 documents of the original 191 (a
document type that is not public yet) are withheld; IPP's published figures leave them out
too.

## Scoring

```bash
git clone https://github.com/DrewKraken/invoice-extraction-benchmark
cd invoice-extraction-benchmark
pip install -r requirements.txt
python -m scorer.evaluate predictions.json --markdown scores.md
```

Amounts exact to the cent, dates as ISO dates, vendor names after normalising legal forms,
invoice numbers after normalising case and labels, line items by greedy match (F1 per
document), and a flag that should fire on inconsistent invoices and multi-invoice files. A
document is fully correct when every key header field it is scored on is right. Full rules
and the predictions format are in the GitHub README.

## Results

| System | Date | Docs | Every key header field right | Key header fields right | Line items, mean F1 | Inconsistent invoices flagged |
|---|---|---:|---|---|---:|---|
| InvoiceParser Pro (production) | 2026-10-03 | 181 | 96.1% (174 of 181) | 98.7% (1,555 of 1,576) | 0.983 | 5 of 5 |

IPP's own measurement through its live production service; details and every miss at
https://invoiceparserpro.com/accuracy. Results from other tools are welcome as pull requests
on GitHub.

## Limitations

Synthetic documents from one layout engine, so far less layout variety than real supplier
invoices; mostly English with Southern African, UK, US and EU conventions; simulated (not
photographed) damage; small per-category counts.

## License and citation

Data CC BY 4.0; code (on GitHub) MIT.

```bibtex
@misc{ipp_invoice_extraction_benchmark_2026,
  title        = {Invoice Extraction Benchmark v1: 181 synthetic invoices, photos, scans and handwritten documents with answer keys},
  author       = {{InvoiceParser Pro}},
  year         = {2026},
  month        = oct,
  howpublished = {\url{https://github.com/DrewKraken/invoice-extraction-benchmark}},
  note         = {Synthetic corpus, seed 42; results at https://invoiceparserpro.com/accuracy}
}
```
