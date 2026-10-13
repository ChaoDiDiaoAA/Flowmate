# RFC 4180 Erratum 5345

Source: https://www.rfc-editor.org/errata/eid5345
Retrieved: 2026-10-11T13:39:41.615381+00:00

RFC 4180 inline-errata , "Common Format and MIME Type for Comma-Separated Values (CSV) Files", October 2005 Source of RFC: IETF - NON WORKING GROUP Updated by: RFC7111 Area assignment: app Errata-ID: 5345 Status: Held for Document Update Type: Technical Reported By: Abed BenBrahim Date Reported: 2018-04-30 Held for Document Update by: Andy Newton Date Held for Document Update: 2025-11-02 Section 2 says: 6. Fields containing line breaks (CRLF), double quotes, and commas should be enclosed in double-quotes. It should say: 6. Fields containing line breaks (CRLF), double quotes, and commas must be enclosed in double-quotes. Notes: CSV is clearly unparsable if commas are not enclosed in double quotes.
