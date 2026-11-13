# ChatMatrix STT (프로토타입 0.1.0)

음성 대화(디스코드/와우)를 인식해 문장으로 내보내는 확장입니다. 리더 본체와 별도 프로세스이고, 게임에는 손대지 않습니다.

```
리더  ──(JSON 줄)──  STT 시스템 (이 폴더)  ──  인식 엔진 (sttcore/engines: whisper, fake, 앞으로 Qwen 등)
```

## 설치
리더의 옵션 > 음성 인식 > **Whisper** 그룹에서 "CPU용 설치하기 / GPU용 설치하기" 버튼으로 설치할 수 있습니다 (창 없이 진행, 인터넷 필요).
삭제도 같은 곳에서 합니다 (GPU 지원만 삭제 / 전체 삭제, 모델 파일 삭제는 선택). 아래는 직접 설치하는 방법입니다.

## 설치 (직접, 본체와 분리)
```
cd extensions\stt
py -3.11 -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```
GPU(NVIDIA)를 쓰려면 CUDA 12용 cuBLAS/cuDNN이 필요합니다:
```
.venv\Scripts\pip install -r requirements-gpu.txt
```
설치 위치(`site-packages\nvidia\*\bin`)는 프로그램이 알아서 찾습니다. 없거나 맞지 않으면 자동으로 CPU(int8)로 내려가고 이유를 로그에 남깁니다.
(cuDNN 9 / cuBLAS 12 조합은 faster-whisper(ctranslate2) 버전에 따라 다를 수 있습니다 — 안 되면 로그의 `Whisper on cuda failed` 줄을 확인하세요.)
처음 실행에는 모델 내려받기 때문에 1분 가까이 걸립니다 (다음부터는 캐시를 씁니다).

## 어떤 소리를 들을지 (`--target`)
사용자가 고르는 것은 **프로그램 하나**입니다 (`discord`, `wow`, `chrome`, `프로그램.exe`, `pid:N`). 소리를 얻는 방법은 프로그램이 정합니다.
- `discord` = Discord의 **음성 대화만** (영상·웹 소리를 내는 보조 프로세스는 거름. 이 경우에는 항상 오디오 세션 방식을 씁니다),
  `discord-all` = Discord가 내는 **모든 소리**, `프로그램.exe` = 그 프로그램의 모든 소리, `system` = 기본 출력 장치의 모든 소리.
- `--sessions --json` 은 리더의 "목록에서 고르기"가 쓰는 출력입니다: 소리를 내는 프로그램을 프로그램별로 묶어 한 줄의 JSON(`type: sessions`)으로 냅니다.

1. Windows 10 빌드 20438 이상 / 11: 그 프로그램의 소리만 직접 캡처 (proc-tap).
2. 그보다 낮은 Windows 10 (예: 22H2 = 빌드 19045): **오디오 세션 방식** — 프로그램이 소리를 내는 출력 장치를 자동으로 찾고(pycaw),
   그 장치만 루프백으로 듣되, **그 프로그램 자신의 소리가 날 때만** 인식에 넘깁니다 (같은 장치의 게임 음악은 무음 처리).
   프로그램이 다른 장치로 옮겨 가면 따라갑니다. 소리를 낸 적이 없으면 기다립니다.
   디스코드는 음성(`renderer` 프로세스, 디스코드 설정의 출력 장치)과 영상/웹 소리(`utility/AudioService` 프로세스, 기본 장치)가
   다른 프로세스로 나뉘어 있어서(직접 측정), **음성 쪽만** 대상으로 삼습니다. 프로세스 id가 아니라 역할로 구분하므로 재시작해도 같습니다.

시험용으로 직접 지정할 수도 있습니다: `system`(기본 출력 장치 전체), `device:이름일부|번호`(`--list-devices`).

## 시험 (터미널)
```
.venv\Scripts\python stt_main.py --sessions --target discord      어느 장치에서 어떤 프로그램이 소리를 내는지 (4번 표본, 대상은 <== 표시)
.venv\Scripts\python stt_main.py --list-devices                   캡처 가능한 출력 장치 목록
.venv\Scripts\python stt_main.py --target system --meter          기본 출력 장치의 모든 소리 인식 + 소리 크기 표시
.venv\Scripts\python stt_main.py --target device:헤드셋 --meter   그 장치만
.venv\Scripts\python stt_main.py --target discord --lang ko --meter 디스코드 음성만 (한국어로 시험할 때 --lang ko) (Windows에 맞는 방법을 자동 선택)
.venv\Scripts\python stt_main.py --target discord --no-gate --meter  세션 방식에서 "프로그램 소리 때만" 거르기를 끄고 장치 전체를 인식
.venv\Scripts\python stt_main.py --target system --probe 8        8초 동안 받은 소리를 probe.wav로 저장하고 상태 점검
.venv\Scripts\python stt_main.py --wav 시험.wav --fast            WAV 파일 인식 (16-bit PCM)
.venv\Scripts\python stt_main.py --engine fake --wav 시험.wav     모델 없이 나머지만 시험
.venv\Scripts\python stt_main.py --target chrome --native-check   (프로그램별 캡처) 이 Windows에서 되는지 직접 확인
```
자주 쓰는 옵션: `--model small|medium|large-v3-turbo`, `--device cpu|cuda`, `--lang en|ko|auto`, `--end-ms 700`(문장 끝으로 보는 조용한 시간),
`--max-backlog 3`(엔진이 밀릴 때 기다릴 문장 수), `-v`(로그 자세히). 로그: 리더 폴더의 `chatmatrix_stt.log`.

출력 한 줄: `(소리 3.2초, 인식 410 ms, 말이 끝나고 1.5초 뒤)  문장` — 마지막 숫자가 체감 지연입니다.

## 시험하며 볼 것
- `--meter`에서 말할 때 SPEECH가 켜지는지(안 켜지면 `--min-rms` 조정, 소리가 안 들어오면 8초 뒤 경고).
- 지연과 인식 시간(GPU/CPU, 모델 크기별), 엉뚱한 문장(환각)이 나오는지(`chatmatrix_stt.log`의 `dropped` 줄).
- 프로그램 지정 시 프로세스가 여럿이면(크롬, 디스코드) 본체(`--type=` 없는 것) 중 가장 오래된 것을 고릅니다. `--list --target 이름`으로 선택 근거를 볼 수 있습니다.
- 장치 전체 캡처에서는 그 장치로 나가는 모든 소리가 들어갑니다. 소리가 아예 안 나올 때는 데이터가 오지 않으므로(정상) 문장 끝은 프로그램이 스스로 판단합니다.

## 리더와의 약속 (`--json`)
stdout에 JSON 한 줄씩: `status`(loading/ready/listening/done/stopped/error), `text`, `partial`, `warn`, `level`. 리더가 stdin에 `{"cmd":"stop"}`을 쓰거나 stdin을 닫으면 종료합니다. 자세한 형식은 `sttcore/protocol.py`.

## 리더에서 쓰기
리더의 옵션 → "음성 인식" 탭에서 켭니다 (이 폴더에 `.venv`가 있어야 합니다). 리더가 이 프로그램을 숨김 창으로 실행하고, 들은 문장은 번역창에 `(음성)` 줄로 나타나 번역됩니다. 이 확장이 없거나 고장 나도 리더의 다른 기능에는 영향이 없습니다.

## 실시간(live) 모드
`--partial-ms 1000`: 말하는 동안 N ms마다 "지금까지의 문장"을 `partial`로 내보냅니다 (문장이 끝나면 `text`가 그것을 대신합니다). 번역은 `text`에서만 합니다.
엔진 클래스의 `streaming` 값이 False(Whisper)이면 매번 문장 전체를 다시 인식하므로 그래픽카드 부담이 늘고 끝부분이 계속 바뀌어서, 켜면 "권장하지 않음" 경고(`warn`)를 냅니다. 스트리밍이 되는 엔진은 `streaming = True`로 두면 경고가 없습니다.

## 인식 방식 (엔진)
- `whisper` (기본): 이 PC에서 faster-whisper로 인식합니다.
- `openai`: OpenAI의 음성 인식 API(`POST <주소>/audio/transcriptions`)를 쓰는 서버에 문장마다 요청합니다 (OpenAI, vLLM, LocalAI 등). **소리가 그 서버로 전송됩니다.**
  `--engine openai --url http://localhost:8000/v1 [--model 이름] [--response-format json|verbose_json] [--timeout 30]`
  API 키는 명령줄이 아니라 환경변수 `CHATMATRIX_STT_API_KEY`로 넘깁니다 (명령줄은 다른 프로그램이 볼 수 있습니다).
  `--check`는 서버에 무음 1초를 보내 주소/키/모델 이름을 시험하고 결과를 `check` 메시지로 냅니다 (리더의 "연결 시험" 버튼).
  이 방식에는 실시간(`--partial-ms`)이 없습니다: 긴 말은 `--max-s`(한 번에 보낼 최대 길이)에서 끊어 보냅니다.

## 엔진 추가
`sttcore/engines/`에 `Engine`을 상속한 파일을 만들고 `__init__.py`에 등록하면 됩니다 (`load()`, `transcribe(audio, language, prompt)`, `close()`).

## 시험 (자동)
`python3 test_openai.py` — 가짜 서버로 openai 엔진의 요청 형식, 키, 오류 처리, `--check`를 확인합니다.
`python3 test_stt.py` — 모델/마이크/Windows 없이 분절, 변환, 필터, 프로세스 전체(가짜 엔진)를 확인합니다.
