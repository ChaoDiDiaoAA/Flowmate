# P0 Memory

`memory/` is the runtime boundary for the first Pi integration. It reads the
active Pi `SessionManager` history, applies the P0 policy (automatic compaction
and automatic retry disabled), reports the SDK's context capacity, and releases
the binding with the owning session.

P0 does not implement long-term memory, vector retrieval, or compaction. A
capacity that Pi has not measured is reported as `unknown`; callers choose the
explicit `unknownCapacity` policy instead of silently dropping context.
