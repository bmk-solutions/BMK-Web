# Batch upload performance

The previous browser flow uploaded one original, waited for all server-side variants and its commit, and only then started the next file. A read-only audit of the latest 100 completed sessions found 5,042 MiB of originals and 52 minutes between first/last session creation (not a measurement of total completion time).

The shared uploader now reserves at most three files at a time before any commit, transfers those originals concurrently, and finalizes them in selection order using each newly returned tour revision. This overlaps network transfer with image preparation without racing scene commits or changing order. Local-mode uploads remain serial. Each batch waits for all its transfers and saves before reserving the next batch.

Successful TUS chunk responses provide the next offset, so a HEAD request is only needed after an uncertain/failed PATCH. Recovery still validates offsets before replaying a chunk. Session capability is fetched once per selection rather than once per file. Server processing uses the direct Storage host and overlaps up to two variant writes with sequential encoding; resolutions and quality parameters are unchanged.

Progress distinguishes bytes transferred from files completed and shows the preparation phase. A completed file can have failed; failures remain listed for retry. Originals are neither recompressed nor replaced.

Validation: 100-file mocked batch exercises bounded concurrency, out-of-order network completion, preserved commit ordering/revisions and one capability lookup. Transport tests cover offset recovery and token destination validation; cloud route tests run actual Sharp variant generation and atomic commit. This is not a benchmark of a live 5 GB upload. Actual duration still depends on upload bandwidth, image size and server encoding.
