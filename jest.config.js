// Jest's default per-test timeout is 5000ms - fine for the pure-function
// tests (tests/utils/), but too tight for this suite as a whole: every
// DB-backed test hits the real live database (see tests/README.md - there
// is no separate test one), and a normally-fast query can occasionally take
// longer under the cumulative load of running 50+ sequential DB operations
// in one --runInBand pass. Confirmed live: searchModel.searchAll('a')
// against real production data normally takes ~50-400ms in isolation, but
// was observed exceeding the 5000ms default often enough under full-suite
// load to be a real, recurring flake - not a correctness bug, just not
// enough margin. 15s gives real headroom without letting an actual hang
// run forever.
module.exports = {
  testTimeout: 15000,
};
