// the smallest test helper: CHECK(condition, "what is checked"); the program ends with a failure count.
#pragma once
#include <cstdio>

namespace cmrtest {
inline int& passed() { static int n = 0; return n; }
inline int& failed() { static int n = 0; return n; }
}  // namespace cmrtest

#define CHECK(cond, msg) do { if (cond) { cmrtest::passed()++; } else { cmrtest::failed()++; std::printf("  FAIL: %s  (%s:%d)\n", msg, __FILE__, __LINE__); } } while (0)
#define TEST_DONE() do { std::printf("%d ok, %d failed\n", cmrtest::passed(), cmrtest::failed()); return cmrtest::failed() ? 1 : 0; } while (0)
