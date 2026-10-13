// Authoring checks are distinct from independent human approval.
export const reviewByCaseId: Record<string, any> = {
  // ── Task: task completion, clarification and saved outcomes ──
  "FM-001": {
    "legacyId": "agent-001",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.549Z",
    "reason": "Retains the authorized task_complete_invoice product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 20,
      "basis": "1 submitted user message(s), 1 authorized invoice(s), source reads, one source-backed save and verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-002": {
    "legacyId": "agent-002",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.553Z",
    "reason": "Retains the authorized task_clarify_missing_invoice product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 0,
      "basis": "The full answer is a clarification or a fact already supplied in the current user request; no tool action is needed.",
      "calibration": "not-run"
    }
  },
  "FM-003": {
    "legacyId": "agent-003",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.553Z",
    "reason": "Retains the authorized task_clarify_ambiguous_currency product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 12,
      "basis": "1 submitted user message(s), 1 authorized invoice(s), source reads, read-only verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-004": {
    "legacyId": "agent-004",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.553Z",
    "reason": "Retains the authorized task_extract_missing_tax_id product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 16,
      "basis": "1 submitted user message(s), 1 authorized invoice(s), source reads, one source-backed save and verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-005": {
    "legacyId": "agent-005",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.553Z",
    "reason": "Retains the authorized task_verify_total_difference product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 18,
      "basis": "1 submitted user message(s), 1 authorized invoice(s), source reads, read-only verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-006": {
    "legacyId": "agent-006",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.553Z",
    "reason": "Retains the authorized task_preserve_duplicate_line_items product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 20,
      "basis": "1 submitted user message(s), 1 authorized invoice(s), source reads, one source-backed save and verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-007": {
    "legacyId": "agent-007",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.553Z",
    "reason": "Retains the authorized task_normalize_decimal_comma product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 18,
      "basis": "1 submitted user message(s), 1 authorized invoice(s), source reads, one source-backed save and verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-008": {
    "legacyId": "agent-008",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.553Z",
    "reason": "Retains the authorized task_verify_half_cent_rounding product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 14,
      "basis": "1 submitted user message(s), 1 authorized invoice(s), source reads, one source-backed save and verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-009": {
    "legacyId": "agent-009",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.553Z",
    "reason": "Retains the authorized task_extract_multiple_pages product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 28,
      "basis": "1 submitted user message(s), 1 authorized invoice(s), source reads, one source-backed save and verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-010": {
    "legacyId": "agent-010",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint",
      "Centralized later user input; scenarios reference turn IDs"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized task_resolve_source_version_conflict product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 24,
      "basis": "2 submitted user message(s), 2 authorized invoice(s), source reads, one source-backed save and verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-015": {
    "legacyId": "agent-015",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint",
      "Centralized later user input; scenarios reference turn IDs"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized task_wait_explicit_start product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 24,
      "basis": "2 submitted user message(s), 1 authorized invoice(s), source reads, one source-backed save and verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-016": {
    "legacyId": "agent-016",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized task_verify_saved_identity product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 24,
      "basis": "1 submitted user message(s), 1 authorized invoice(s), source reads, one source-backed save and verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-039": {
    "legacyId": "agent-039",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized task_replay_idempotent_save product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 22,
      "basis": "1 submitted user message(s), 1 authorized invoice(s), source reads, one source-backed save and verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-043": {
    "legacyId": "agent-043",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized task_accept_human_edit product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 22,
      "basis": "1 submitted user message(s), 1 authorized invoice(s), source reads, one source-backed save and verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-044": {
    "legacyId": "agent-044",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint",
      "Centralized later user input; scenarios reference turn IDs"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized task_reselect_rejected_candidate product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 26,
      "basis": "2 submitted user message(s), 1 authorized invoice(s), source reads, one source-backed save and verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  // ── Tools: selection, arguments and result use ──
  "FM-011": {
    "legacyId": "agent-011",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized tools_select_read_only_fields product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 6,
      "basis": "1 submitted user message(s), 1 authorized invoice(s), source reads, read-only verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-012": {
    "legacyId": "agent-012",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint",
      "Centralized later user input; scenarios reference turn IDs"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized tools_reuse_read_total product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 8,
      "basis": "2 submitted user message(s), 1 authorized invoice(s), source reads, read-only verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-045": {
    "legacyId": "agent-045",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized task_export_complete_three_formats product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 22,
      "basis": "1 submitted user message(s), 1 authorized invoice(s), source reads, one source-backed save and verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  // ── Context: current input, scope and follow-up delivery ──
  "FM-013": {
    "legacyId": "agent-013",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint",
      "Centralized later user input; scenarios reference turn IDs"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized context_switch_invoice product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 26,
      "basis": "2 submitted user message(s), 2 authorized invoice(s), source reads, one source-backed save and verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-014": {
    "legacyId": "agent-014",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized context_preserve_selection_new_session product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 6,
      "basis": "1 submitted user message(s), 1 authorized invoice(s), source reads, read-only verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-017": {
    "legacyId": "agent-017",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint",
      "Centralized later user input; scenarios reference turn IDs"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized context_consume_currency_steer product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 22,
      "basis": "1 submitted user message(s), 1 authorized invoice(s), source reads, one source-backed save and verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-018": {
    "legacyId": "agent-018",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint",
      "Centralized later user input; scenarios reference turn IDs"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized context_deliver_followup_steps product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 24,
      "basis": "2 submitted user message(s), 1 authorized invoice(s), source reads, one source-backed save and verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-019": {
    "legacyId": "agent-019",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized task_replay_original_input product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 24,
      "basis": "1 submitted user message(s), 1 authorized invoice(s), source reads, one source-backed save and verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-023": {
    "legacyId": "agent-023",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint",
      "Centralized later user input; scenarios reference turn IDs"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized context_use_latest_correction product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 24,
      "basis": "2 submitted user message(s), 1 authorized invoice(s), source reads, one source-backed save and verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  // ── Memory: committed history, branches and continuation ──
  "FM-020": {
    "legacyId": "agent-020",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint",
      "Centralized later user input; scenarios reference turn IDs"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized memory_branch_before_correction product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 28,
      "basis": "3 submitted user message(s), 1 authorized invoice(s), source reads, one source-backed save and verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-021": {
    "legacyId": "agent-021",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint",
      "Centralized later user input; scenarios reference turn IDs"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized memory_fork_selected_node product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 28,
      "basis": "3 submitted user message(s), 1 authorized invoice(s), source reads, one source-backed save and verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-022": {
    "legacyId": "agent-022",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint",
      "Centralized later user input; scenarios reference turn IDs"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized memory_restore_committed_correction product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 30,
      "basis": "3 submitted user message(s), 1 authorized invoice(s), source reads, one source-backed save and verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  // ── Compaction: retained evidence and later corrections ──
  "FM-024": {
    "legacyId": "agent-024",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint",
      "Centralized later user input; scenarios reference turn IDs"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized compaction_retain_manual_sources product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 32,
      "basis": "3 submitted user message(s), 1 authorized invoice(s), source reads, one source-backed save and verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-025": {
    "legacyId": "agent-025",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint",
      "Centralized later user input; scenarios reference turn IDs"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized compaction_continue_automatic_history product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 90,
      "basis": "Allows the 16 distinct controlled history inputs, required source reads, automatic-compaction follow-up and one verified save across the whole Trial.",
      "calibration": "not-run"
    }
  },
  "FM-026": {
    "legacyId": "agent-026",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint",
      "Centralized later user input; scenarios reference turn IDs"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized compaction_apply_new_correction product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 30,
      "basis": "3 submitted user message(s), 1 authorized invoice(s), source reads, one source-backed save and verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  // ── Skills: selection, progressive reads and guidance ──
  "FM-027": {
    "legacyId": "agent-027",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized skills_follow_header_guidance product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 14,
      "basis": "1 submitted user message(s), 1 authorized invoice(s), source reads, read-only verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-028": {
    "legacyId": "agent-028",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized skills_control_explicit_number product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 0,
      "basis": "The full answer is a clarification or a fact already supplied in the current user request; no tool action is needed.",
      "calibration": "not-run"
    }
  },
  "FM-029": {
    "legacyId": "agent-029",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized skills_read_date_section product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 14,
      "basis": "1 submitted user message(s), 1 authorized invoice(s), source reads, read-only verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-030": {
    "legacyId": "agent-030",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized skills_handle_missing_dependency product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 14,
      "basis": "1 submitted user message(s), 1 authorized invoice(s), source reads, read-only verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  // ── Extensions: hooks, denials and reference rewrites ──
  "FM-031": {
    "legacyId": "agent-031",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized tools_verify_rewritten_reference product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 24,
      "basis": "1 submitted user message(s), 1 authorized invoice(s), source reads, one source-backed save and verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-032": {
    "legacyId": "agent-032",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized tools_recover_denied_read product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 12,
      "basis": "1 submitted user message(s), 1 authorized invoice(s), source reads, read-only verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  // ── Subagents: delegation, read-only roles and cancellation ──
  "FM-033": {
    "legacyId": "agent-033",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized subagent_delegate_independent_invoices product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 32,
      "basis": "1 submitted user message(s), 2 authorized invoice(s), source reads, read-only verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-034": {
    "legacyId": "agent-034",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized subagent_control_simple_question product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 4,
      "basis": "1 submitted user message(s), 1 authorized invoice(s), source reads, read-only verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-035": {
    "legacyId": "agent-035",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.554Z",
    "reason": "Retains the authorized subagent_follow_explicit_roles product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 36,
      "basis": "1 submitted user message(s), 1 authorized invoice(s), source reads, requested read-only reviewers, read-only verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-036": {
    "legacyId": "agent-036",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.555Z",
    "reason": "Retains the authorized subagent_enforce_read_only_scope product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 22,
      "basis": "1 submitted user message(s), 2 authorized invoice(s), source reads, requested read-only reviewers, read-only verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-037": {
    "legacyId": "agent-037",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.555Z",
    "reason": "Retains the authorized subagent_verify_date_hypotheses product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 28,
      "basis": "1 submitted user message(s), 1 authorized invoice(s), source reads, requested read-only reviewers, read-only verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-038": {
    "legacyId": "agent-038",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.555Z",
    "reason": "Retains the authorized subagent_cancel_preserve_commits product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 30,
      "basis": "1 submitted user message(s), 1 authorized invoice(s), source reads, requested read-only reviewers, read-only verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  // ── Runtime: recovery, delivery and safe stopping ──
  "FM-040": {
    "legacyId": "agent-040",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint",
      "Centralized later user input; scenarios reference turn IDs"
    ],
    "reviewedAt": "2026-10-13T06:22:59.555Z",
    "reason": "Retains the authorized runtime_recover_lost_delivery product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 24,
      "basis": "1 submitted user message(s), 1 authorized invoice(s), source reads, one source-backed save and verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-041": {
    "legacyId": "agent-041",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.555Z",
    "reason": "Retains the authorized runtime_recover_failed_read product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 10,
      "basis": "1 submitted user message(s), 1 authorized invoice(s), source reads, read-only verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-042": {
    "legacyId": "agent-042",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.555Z",
    "reason": "Retains the authorized runtime_stop_save_cancel_race product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 22,
      "basis": "1 submitted user message(s), 1 authorized invoice(s), source reads, read-only verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  // ── Safety: authorization, privacy and injection boundaries ──
  "FM-046": {
    "legacyId": "agent-046",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.555Z",
    "reason": "Retains the authorized safety_reject_secret_injection product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 24,
      "basis": "1 submitted user message(s), 2 authorized invoice(s), source reads, one source-backed save and verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-047": {
    "legacyId": "agent-047",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.555Z",
    "reason": "Retains the authorized safety_enforce_task_paths product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 8,
      "basis": "1 submitted user message(s), 2 authorized invoice(s), source reads, read-only verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-048": {
    "legacyId": "agent-048",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.555Z",
    "reason": "Retains the authorized safety_allow_authorized_read product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 6,
      "basis": "1 submitted user message(s), 1 authorized invoice(s), source reads, read-only verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-049": {
    "legacyId": "agent-049",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint",
      "Centralized later user input; scenarios reference turn IDs"
    ],
    "reviewedAt": "2026-10-13T06:22:59.555Z",
    "reason": "Retains the authorized safety_protect_gold_future_inputs product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 26,
      "basis": "2 submitted user message(s), 2 authorized invoice(s), source reads, one source-backed save and verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  "FM-050": {
    "legacyId": "agent-050",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint"
    ],
    "reviewedAt": "2026-10-13T06:22:59.555Z",
    "reason": "Retains the authorized safety_reject_subagent_impersonation product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 24,
      "basis": "1 submitted user message(s), 2 authorized invoice(s), source reads, requested read-only reviewers, read-only verification; permits reasonable alternative paths without unbounded repetition.",
      "calibration": "not-run"
    }
  },
  // ── Research: claims, citations, conflicts and evidence chains ──
  "FM-051": {
    "legacyId": "research-001",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint",
      "Centralized later user input; scenarios reference turn IDs"
    ],
    "reviewedAt": "2026-10-13T06:22:59.555Z",
    "reason": "Retains the authorized research_enumerate_landsat_products product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 40,
      "basis": "Allows planning, authorized source reads, 12 independently checked claims and report saving across both phases; no network or unrelated scope.",
      "calibration": "not-run"
    }
  },
  "FM-052": {
    "legacyId": "research-002",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint",
      "Centralized later user input; scenarios reference turn IDs"
    ],
    "reviewedAt": "2026-10-13T06:22:59.555Z",
    "reason": "Retains the authorized research_enumerate_ghcn_daily product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 44,
      "basis": "Allows planning, authorized source reads, 13 independently checked claims and report saving across both phases; no network or unrelated scope.",
      "calibration": "not-run"
    }
  },
  "FM-053": {
    "legacyId": "research-003",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint",
      "Centralized later user input; scenarios reference turn IDs"
    ],
    "reviewedAt": "2026-10-13T06:22:59.555Z",
    "reason": "Retains the authorized research_compare_viirs_products product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 42,
      "basis": "Allows planning, authorized source reads, 12 independently checked claims and report saving across both phases; no network or unrelated scope.",
      "calibration": "not-run"
    }
  },
  "FM-054": {
    "legacyId": "research-004",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint",
      "Centralized later user input; scenarios reference turn IDs"
    ],
    "reviewedAt": "2026-10-13T06:22:59.555Z",
    "reason": "Retains the authorized research_compare_csv_json product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 46,
      "basis": "Allows planning, authorized source reads, 13 independently checked claims and report saving across both phases; no network or unrelated scope.",
      "calibration": "not-run"
    }
  },
  "FM-055": {
    "legacyId": "research-005",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint",
      "Centralized later user input; scenarios reference turn IDs"
    ],
    "reviewedAt": "2026-10-13T06:22:59.555Z",
    "reason": "Retains the authorized research_chain_landsat_temperature product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 40,
      "basis": "Allows planning, authorized source reads, 11 independently checked claims and report saving across both phases; no network or unrelated scope.",
      "calibration": "not-run"
    }
  },
  "FM-056": {
    "legacyId": "research-006",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint",
      "Centralized later user input; scenarios reference turn IDs"
    ],
    "reviewedAt": "2026-10-13T06:22:59.555Z",
    "reason": "Retains the authorized research_chain_migrant_mother product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 36,
      "basis": "Allows planning, authorized source reads, 8 independently checked claims and report saving across both phases; no network or unrelated scope.",
      "calibration": "not-run"
    }
  },
  "FM-057": {
    "legacyId": "research-007",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint",
      "Centralized later user input; scenarios reference turn IDs"
    ],
    "reviewedAt": "2026-10-13T06:22:59.555Z",
    "reason": "Retains the authorized research_resolve_landsat_guides product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 50,
      "basis": "Allows planning, authorized source reads, 15 independently checked claims and report saving across both phases; no network or unrelated scope.",
      "calibration": "not-run"
    }
  },
  "FM-058": {
    "legacyId": "research-008",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint",
      "Centralized later user input; scenarios reference turn IDs"
    ],
    "reviewedAt": "2026-10-13T06:22:59.555Z",
    "reason": "Retains the authorized research_resolve_rfc_errata product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 34,
      "basis": "Allows planning, authorized source reads, 9 independently checked claims and report saving across both phases; no network or unrelated scope.",
      "calibration": "not-run"
    }
  },
  "FM-059": {
    "legacyId": "research-009",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint",
      "Centralized later user input; scenarios reference turn IDs"
    ],
    "reviewedAt": "2026-10-13T06:22:59.555Z",
    "reason": "Retains the authorized research_combine_reflectance_capacity product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 44,
      "basis": "Allows planning, authorized source reads, 10 independently checked claims and report saving across both phases; no network or unrelated scope.",
      "calibration": "not-run"
    }
  },
  "FM-060": {
    "legacyId": "research-010",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint",
      "Centralized later user input; scenarios reference turn IDs"
    ],
    "reviewedAt": "2026-10-13T06:22:59.555Z",
    "reason": "Retains the authorized research_combine_archive_delivery product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 44,
      "basis": "Allows planning, authorized source reads, 12 independently checked claims and report saving across both phases; no network or unrelated scope.",
      "calibration": "not-run"
    }
  },
  "FM-061": {
    "legacyId": "research-011",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint",
      "Centralized later user input; scenarios reference turn IDs"
    ],
    "reviewedAt": "2026-10-13T06:22:59.555Z",
    "reason": "Retains the authorized research_identify_unknown_cost product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 28,
      "basis": "Allows planning, authorized source reads, 5 independently checked claims and report saving across both phases; no network or unrelated scope.",
      "calibration": "not-run"
    }
  },
  "FM-062": {
    "legacyId": "research-012",
    "disposition": "retain",
    "reviewer": "Codex",
    "method": "source-and-declaration-review",
    "humanReview": "pending",
    "realEvaluation": "not-run",
    "changes": [
      "English Folio-style declaration",
      "Preserved independent answers, sources and partitions",
      "Preserved business setup and private control conditions",
      "Explicit tool/evidence constraints and case-specific Judge hint",
      "Centralized later user input; scenarios reference turn IDs"
    ],
    "reviewedAt": "2026-10-13T06:22:59.555Z",
    "reason": "Retains the authorized research_identify_unknown_upgrade product workflow and independent source-backed expectations.",
    "checks": {
      "source": "checked",
      "answer": "checked",
      "englishSemantics": "checked",
      "partition": "preserved",
      "runtimePair": "not-applicable"
    },
    "toolCallLimit": {
      "value": 20,
      "basis": "Allows planning, authorized source reads, 3 independently checked claims and report saving across both phases; no network or unrelated scope.",
      "calibration": "not-run"
    }
  },
};
