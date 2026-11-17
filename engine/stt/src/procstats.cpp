#include "procstats.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <initializer_list>
#include <map>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#ifndef NOMINMAX
#define NOMINMAX                     // (windows.h would define min / max as macros and break std::min / std::max)
#endif
#include <windows.h>
#include <psapi.h>
#include <dxgi1_4.h>
#include <pdh.h>
#include <pdhmsg.h>
#else
#include <fstream>
#include <unistd.h>
#endif

namespace cmr {

namespace {
double wallSeconds() { return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count(); }

#ifdef _WIN32
double cpuSeconds() {
    FILETIME c, e, k, u;
    if (!GetProcessTimes(GetCurrentProcess(), &c, &e, &k, &u)) return 0;
    auto t = [](FILETIME f) { return ((static_cast<unsigned long long>(f.dwHighDateTime) << 32) | f.dwLowDateTime) / 1e7; };
    return t(k) + t(u);
}
double ramMb() {
    PROCESS_MEMORY_COUNTERS pmc;
    if (!GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof pmc)) return 0;
    return pmc.WorkingSetSize / 1048576.0;
}
int cores() { SYSTEM_INFO si; GetSystemInfo(&si); return static_cast<int>(si.dwNumberOfProcessors); }
#else
double cpuSeconds() {                       // (for development on Linux: the same numbers from /proc)
    std::ifstream f("/proc/self/stat"); std::string all; std::getline(f, all);
    size_t p = all.rfind(')'); if (p == std::string::npos) return 0;
    std::string rest = all.substr(p + 2); long ut = 0, st = 0; int field = 3;
    size_t pos = 0;
    while (pos < rest.size() && field <= 15) {
        size_t sp = rest.find(' ', pos); std::string tok = rest.substr(pos, sp == std::string::npos ? std::string::npos : sp - pos);
        if (field == 14) ut = std::atol(tok.c_str());
        if (field == 15) st = std::atol(tok.c_str());
        if (sp == std::string::npos) break;
        pos = sp + 1;
        field++;
    }
    return static_cast<double>(ut + st) / sysconf(_SC_CLK_TCK);
}
double ramMb() {
    std::ifstream f("/proc/self/statm"); long size = 0, res = 0; f >> size >> res;
    return res * sysconf(_SC_PAGESIZE) / 1048576.0;
}
int cores() { long n = sysconf(_SC_NPROCESSORS_ONLN); return n > 0 ? static_cast<int>(n) : 1; }
#endif
}  // namespace

// ---- the graphics card (Windows). Every call that can fail makes the number "not known" (-1), nothing else.
struct ProcSampler::Gpu {
#ifdef _WIN32
    PDH_HQUERY query = nullptr; PDH_HCOUNTER counter = nullptr; bool primed = false;
    static std::string hex(long long v) { char b[32]; snprintf(b, sizeof b, "0x%08llX", static_cast<unsigned long long>(v) & 0xFFFFFFFFull); return b; }
    ~Gpu() { if (query) PdhCloseQuery(query); }
    // The counter is added when the first sample is taken, and again at every sample until it works: the engines of this program (pid_<pid>_...) exist only
    // once the program has a context on the card, and a wildcard that matches nothing yet cannot be added.
    bool attach(std::string& why) {
        if (counter) return true;
        if (!query && PdhOpenQueryW(nullptr, 0, &query) != ERROR_SUCCESS) { query = nullptr; why = "pdh open"; return false; }
        wchar_t path[128];
        swprintf(path, 128, L"\\GPU Engine(pid_%lu*)\\Utilization Percentage", static_cast<unsigned long>(GetCurrentProcessId()));
        // (the English name works in every language of Windows)
        PDH_STATUS st = PdhAddEnglishCounterW(query, path, 0, &counter);
        if (st != ERROR_SUCCESS) { counter = nullptr; why = "pdh add " + hex(st); return false; }
        primed = false;
        return true;
    }
    double percent(std::string& why) {
        if (!attach(why)) return -1;
        PDH_STATUS st = PdhCollectQueryData(query);
        if (st != ERROR_SUCCESS) { why = "pdh collect " + hex(st); return -1; }
        if (!primed) { primed = true; why = "first sample"; return -1; }          // (a rate needs two samples)
        DWORD size = 0, count = 0;
        st = PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &size, &count, nullptr);
        if (st == static_cast<PDH_STATUS>(PDH_CSTATUS_NO_INSTANCE)) return 0;      // (this program has not used the card yet)
        if (st != static_cast<PDH_STATUS>(PDH_MORE_DATA) || !size) { why = "pdh read " + hex(st); return -1; }
        std::vector<char> buf(size);
        auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(buf.data());
        st = PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &size, &count, items);
        if (st != ERROR_SUCCESS) { why = "pdh read " + hex(st); return -1; }
        std::map<std::wstring, double> by_type;            // the engines of one kind add up; the task manager shows the busiest kind
        for (DWORD i = 0; i < count; i++) {
            if (items[i].FmtValue.CStatus != PDH_CSTATUS_VALID_DATA && items[i].FmtValue.CStatus != PDH_CSTATUS_NEW_DATA) continue;
            std::wstring n = items[i].szName ? items[i].szName : L"";
            size_t p = n.find(L"engtype_");
            by_type[p == std::wstring::npos ? L"" : n.substr(p + 8)] += items[i].FmtValue.doubleValue;
        }
        double best = 0;
        for (auto& kv : by_type) best = (std::max)(best, kv.second);
        return (std::min)(100.0, (std::max)(0.0, best));
    }
    double vramMb(std::string& why) {                       // what this program holds in graphics memory, on all cards (the one that is used has it)
        IDXGIFactory1* f = nullptr;
        HRESULT hr = CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void**>(&f));
        if (FAILED(hr) || !f) { why = "dxgi factory " + hex(hr); return -1; }
        double total = 0; bool any = false; HRESULT last = S_OK; int cards = 0;
        IDXGIAdapter1* a = nullptr;
        for (UINT i = 0; f->EnumAdapters1(i, &a) != DXGI_ERROR_NOT_FOUND; i++) {
            cards++;
            IDXGIAdapter3* a3 = nullptr;
            hr = a->QueryInterface(__uuidof(IDXGIAdapter3), reinterpret_cast<void**>(&a3));
            if (SUCCEEDED(hr) && a3) {
                for (DXGI_MEMORY_SEGMENT_GROUP g : {DXGI_MEMORY_SEGMENT_GROUP_LOCAL, DXGI_MEMORY_SEGMENT_GROUP_NON_LOCAL}) {
                    DXGI_QUERY_VIDEO_MEMORY_INFO info{};
                    hr = a3->QueryVideoMemoryInfo(0, g, &info);
                    if (SUCCEEDED(hr)) { total += info.CurrentUsage / 1048576.0; any = true; } else last = hr;
                }
                a3->Release();
            } else last = hr;
            a->Release();
        }
        f->Release();
        if (!any) why = cards ? "dxgi query " + hex(last) : "dxgi: no card";
        return any ? total : -1;
    }
#else
    double percent(std::string& why) { why = "not Windows"; return -1; }
    double vramMb(std::string& why) { why = "not Windows"; return -1; }
#endif
};

ProcSampler::ProcSampler(bool gpu) : last_cpu_(cpuSeconds()), last_wall_(wallSeconds()), gpu_(gpu ? new Gpu : nullptr) {}
ProcSampler::~ProcSampler() = default;

ProcStats ProcSampler::sample() {
    double cpu = cpuSeconds(), wall = wallSeconds();
    ProcStats s;
    double dw = wall - last_wall_;
    if (dw > 0.05) s.cpu_percent = (cpu - last_cpu_) / dw / cores() * 100.0;
    if (s.cpu_percent < 0) s.cpu_percent = 0;
    if (s.cpu_percent > 100) s.cpu_percent = 100;
    s.ram_mb = ramMb();
    if (gpu_) { s.gpu_percent = gpu_->percent(s.gpu_why); s.vram_mb = gpu_->vramMb(s.vram_why); }
    last_cpu_ = cpu; last_wall_ = wall;
    return s;
}

}  // namespace cmr
