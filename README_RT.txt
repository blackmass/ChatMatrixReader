v32_rtlines2 - 검열 메시지 번호(!RT) + !CS 확장 + 파랑 막대는 초록으로 통일 (JS + 애드온, Rust 재빌드 필요 없음)
================================================================================================
v32_rtlines.zip 을 대신합니다 (같은 파일에 "파랑 막대 숨김"이 더해졌습니다). addon_tagbars.zip 내용도 포함합니다. 같은 경로의 파일을 덮어쓰세요.
  addon\ChatMatrix\ChatMatrix.lua, PROTOCOL.md
  app\core\pipeline.js, ocr_ledger.js, ocr_state.js
  tests\test_ocr_scan.mjs, test_ocr_bars_host.mjs
  docs\HANDOFF.md  (4-0h: 이번 설계와 메모)

이번에 바뀐 것 (이전 v32_rtlines 대비)
  - 막대는 빨강(검열)과 초록(읽을 수 있는 글)만 그립니다. 수집 설정이 뺀 글도 초록입니다.
    파랑 판정(필터가 글에 코드를 심고 읽어서 구별하는 부분)은 그대로 살아 있고, /cm marks blue 로 시험 삼아 파랑을 켤 수 있습니다(세션 한정).

애드온이 하는 일 (막대 옵션이 켜져 있을 때)
  - 첫 채팅창(ChatFrame1)이 메시지를 받을 때마다 번호 t를 하나씩 올립니다 (애드온 자신의 출력도 셈).
  - 글이 비밀값(검열된 메시지)이면, 매트릭스 필터와 상관없이 제어 줄 "!RT"(본문 = t)를 리더로 보냅니다.
  - 상태 줄 "!CS" 끝에 필드 두 개: t(최신 메시지 수), session(로드할 때마다 바뀌는 번호).
리더는: !RT 를 채팅 줄로 보여 주지 않고, !CS 의 새 필드는 읽어만 둡니다(다음 단계에서 번호로 짝짓기). 이전 애드온/리더와도 섞어 쓸 수 있습니다.

확인할 것
  1. /cm marks test  -> 막대가 빨강/초록만 나오는가 (수집 설정에서 뺀 종류의 글도 초록).
  2. 검열 중에 리더 창에 "!RT" 같은 줄이 안 보이는가.
  3. /cm marks  -> "messages of the first window counted (t) N, censored ones told to the reader (!RT) M | session S"
     검열 구간이 지난 뒤 M 이 검열된 메시지 수와 비슷한지, t 가 채팅창 줄 수와 비슷하게 늘어나는지.
  4. 번역/OCR 은 이전과 똑같이 동작하는가 (이번 판은 OCR 동작을 바꾸지 않았습니다).
