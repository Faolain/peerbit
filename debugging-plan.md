## 2026-02-06 - Strict distributed search under churn
- Added test `strict search under churn` to validate strict completeness with churn using `remote.throwOnMissing`, increased `remote.timeout`, `remote.wait`, `remote.reach`, and harness-level retries/backoff.
- Test inserts 200 docs across two shard ranges, stops one peer, restarts it mid-retry, and asserts full result completeness (or fails with actionable error).
- Test command: `PEERBIT_TEST_SESSION=mock pnpm --filter @peerbit/document test -- --grep "strict search under churn"`.
