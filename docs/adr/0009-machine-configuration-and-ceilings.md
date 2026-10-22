# 0009. Machine configuration, with ceilings

Date: 2026-10-19 · Status: accepted, superseded in part by 0017 · Source: spec revision 5 on issue 1 (S4, T5, C24, C31)

An optional `config.json` in the state folder holds `maxRuns`, the default
`memory`, `cpus` and `timeoutMinutes`, `pruneDays`, and the ceilings
`maxMemory` (default `8g`), `maxCpus` (4) and `maxTimeoutMinutes` (120). Each
key is typed and validated. An unknown key or a wrong type exits 125, naming
the file and the key. `ATHANOR_MAX_RUNS` overrides `maxRuns` for one shell or
for CI. A repo value above a ceiling exits 125, naming the key and the
ceiling.
