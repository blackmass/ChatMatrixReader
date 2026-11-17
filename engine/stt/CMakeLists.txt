cmake_minimum_required(VERSION 3.16)
cmake_policy(SET CMP0091 NEW)                    # (lets the Visual C++ runtime be chosen below)
project(cmr_stt LANGUAGES C CXX)
# Windows: the runtime is linked into the program, so a user needs no "Visual C++ Redistributable"
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release)
endif()

# Whisper (whisper.cpp, fetched at a fixed version when this is on; see engine/stt/README.md). Off = the pieces without it (tests, development).
option(CMR_WITH_WHISPER "Link whisper.cpp" OFF)

# Everything of the engine except the recogniser: sound -> sentences -> filter -> JSON lines
add_library(cmrstt_core STATIC
  src/segmenter.cpp src/filters.cpp src/config.cpp src/protocol.cpp src/pipeline.cpp src/bench.cpp src/procstats.cpp)
find_package(Threads REQUIRED)
target_link_libraries(cmrstt_core PUBLIC Threads::Threads)
if(MSVC)
  target_compile_options(cmrstt_core PUBLIC /W4 /utf-8)
else()
  target_compile_options(cmrstt_core PUBLIC -Wall -Wextra)
endif()
if(WIN32)
  target_link_libraries(cmrstt_core PUBLIC psapi pdh dxgi)
endif()

if(CMR_WITH_WHISPER)
  include(whisper.cmake)
else()
  set(CMR_RECOGNIZER_SOURCES src/whisper_stub.cpp)
endif()

add_executable(cmr-stt src/main.cpp ${CMR_RECOGNIZER_SOURCES})
target_link_libraries(cmr-stt PRIVATE cmrstt_core)
if(CMR_WITH_WHISPER)
  target_link_libraries(cmr-stt PRIVATE ${CMR_WHISPER_LIBS})
  target_compile_definitions(cmr-stt PRIVATE ${CMR_WHISPER_DEFS})
endif()

# tests: ctest   (the golden files come from the 2.x Python code, see tools/make_golden_stt.py)
enable_testing()
foreach(t test_golden test_pipeline test_config test_protocol)
  add_executable(${t} tests/${t}.cpp)
  target_link_libraries(${t} PRIVATE cmrstt_core)
endforeach()
add_test(NAME golden COMMAND test_golden ${CMAKE_CURRENT_SOURCE_DIR}/tests/golden)
add_test(NAME pipeline COMMAND test_pipeline)
add_test(NAME config COMMAND test_config)
add_test(NAME protocol COMMAND test_protocol)
