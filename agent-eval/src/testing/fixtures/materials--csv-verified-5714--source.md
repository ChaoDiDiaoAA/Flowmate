# RFC 4180 Erratum 5714

Source: https://www.rfc-editor.org/errata/eid5714
Retrieved: 2026-10-11T13:39:40.987288+00:00

RFC 4180 inline-errata , "Common Format and MIME Type for Comma-Separated Values (CSV) Files", October 2005 Source of RFC: IETF - NON WORKING GROUP Updated by: RFC7111 Area assignment: app Errata-ID: 5714 Status: Verified Type: Editorial Reported By: Damon Koach Date Reported: 2019-05-01 Verified by: Barry Leiba Date Verified: 2019-05-01 Section 5, 6 says: Section 5: "aaa","bbb","ccc" CRLF Section 6: "aaa","b CRLF bb","ccc" CRLF zzz,yyy,xxx It should say: Section 5: "aaa","bbb","ccc"CRLF Section 6: "aaa","b CRLF bb","ccc"CRLF zzz,yyy,xxx Notes: As implied in the ABNF grammar, escaped (quoted) fields may not be followed by a space. The corrected text removes those spaces from the examples, making them syntactically correct.
