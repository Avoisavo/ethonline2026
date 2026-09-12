# Notes on benchmark tasks 01 to 10

These notes record gaps in SPEC.md. I filled each gap with the smallest reasonable choice.

1. SPEC.md §10.12 gives one line per task. It does not give the exported names or the
   signatures for tasks 02 to 10. I chose them and wrote them into each `task.json`:
   - 02 `encode`, `decode`
   - 03 `toRoman`, `fromRoman`
   - 04 `isBalanced`
   - 05 `deepEqual`
   - 06 `toposort`
   - 07 `parseCsv`
   - 08 `compare`
   - 09 `createCache`
   - 10 `createDebouncer`
   Task 01 follows the worked example in §10.4 byte for byte.

2. SPEC.md does not say how many tests each task needs. §10.12 only fixes the
   difficulty. I used 8 tests for the easy tasks and 10 for the medium ones.
   `task.json.testCount` matches the number of top-level `test(...)` calls, as
   §10.3 requires.

3. SPEC.md does not fix the run-length format for task 02. A format such as `3a1b`
   cannot be decoded when the input holds digits. `encode('112233')` and
   `encode('1a11b')` both become ambiguous. I added a separator, so a run is written
   as `<count>x<char>`. PROMPT.md states the format in full.

4. SPEC.md §10.2 lists an `answers/` directory with five graded answers per task, and
   §11.5 uses them. I did not write them. A reference solution inside the repository
   can be read by the harness. The task directories keep their empty `answers/` and
   `starter/` directories.

5. Every task uses the default `timeoutMs` of 5000. §10.12 raises it only for tasks
   13, 15 and 19, which I do not own.
