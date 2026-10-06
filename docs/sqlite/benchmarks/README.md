# SQLite workload observations

CURRENT measurements from the synthetic Milestone 6 harness. Each JSON file is
raw successful-run output, with hardware/runtime, workload counts, operation
latencies, errors, durable queue completion and sampled file sizes. A run cleans
up only its own newly generated temporary installation.

`pre-index-1000.json` and `pre-index-5000.json` use schema through 0065. They
identified retention scans that delayed other commands on the serialized worker.
`indexed-5000.json` uses the forward-only 0066 index migration; its runtime
metadata identifies that exact final migration. `indexed-1000.json`
records the smaller final-schema run. Both preserve all expected job, call and
population counts without recorded operation errors.

The 65-second wait respects the production freeze lag and is reported explicitly;
it is not workload processing time. Main-thread event-loop samples reset after
that maturation period; import latencies are measured separately. Disk maxima
are samples at 25 ms, not exact allocation high-water marks. Latencies include
worker-RPC queueing. Other local qualification tests and container builds were
running on this development machine; this is not an isolated performance lab.

The workload uses 4,096-character synthetic context, eight import clients,
50 human review submissions, one mature population freeze, 30 pairs of dashboard
and population reads, three retention sweeps, 100 overlapping imports, and 100
5 ms local-mock evaluations through the real durable queue. All 100 jobs must
settle durably and use exactly 100 mock calls. The controlled writer-lock probe
holds a maintenance connection for 100 ms before the overlapping phase; it is
not a second application instance. `retentionProtectedRows` sums three sweeps,
so it counts repeated protection observations rather than distinct cases.

Reproduce from a built source checkout:

```sh
pnpm build
pnpm exec tsx tools/bench/sqlite-workload.ts 1000 /tmp/rubrist-1000-new.json
pnpm exec tsx tools/bench/sqlite-workload.ts 5000 /tmp/rubrist-5000-new.json
```

The output path must be new. No real provider calls, deployment secrets or
existing databases are used. These observations do not establish user-count or
throughput guarantees. Container correctness uses pinned Node 24.21.0; these
host workload measurements use Node 24.15.0, as recorded in each file.
