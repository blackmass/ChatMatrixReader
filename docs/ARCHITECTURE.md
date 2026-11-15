# ChatMatrix Reader 2.0 구조 (초안)

2.0은 1.x(tkinter)를 Qt(PySide6)로 다시 만드는 버전입니다. 1.x는 `legacy` 브랜치에 그대로 있고, 이 문서는 `v2-dev`에서 단계별로 고쳐 갑니다.

## 원칙

1. **화면과 처리를 가른다.** 줄을 해석하고 걸러서 번역하는 흐름(코어)은 Qt를 모른다. 화면은 코어가 내보내는 이벤트만 그린다. 코어는 Qt 없이 테스트한다.
2. **tkinter 때문에 붙인 우회 코드는 옮기지 않는다.** 아래 "버리는 것" 목록은 Qt에서 정석으로 풀거나 없앤다. 옮겨 적고 싶은 유혹이 생기면 목록을 먼저 본다.
3. **창 하나의 규칙은 하나다.** 부모/자식을 나누지 않고 모든 창이 같은 `ChatWindow`이며 설정은 창마다 가진다 (창 1의 값을 기본으로 따르는 항목은 `winconf.opt`).
4. **OS 의존은 한 곳에.** HWND/NSWindow를 만지는 코드는 `native/` 한 곳에만 둔다 (3단계).
5. **한 번에 한 단계.** 각 단계는 단독으로 테스트가 통과하는 상태로 끝낸다.

## 지금 있는 것 (1단계 시작 시점)

Qt와 상관없는 모듈은 1.x에서 그대로 옮겼고 `python app/run_tests.py`로 전부 통과한다.

| 영역 | 모듈 |
|---|---|
| 읽기 (화면 → 줄) | `capture`, `capture_mac`, `decoder`, `proto2`, `proto3`, `scaled`, `joiner` |
| 해석·번역 | `chattext`, `translator`, `glossary`, `usage`, `outgoing` |
| 음성 | `voice`, `voiceinstall`, `voicemeter`(상태 모델만, 위젯은 Qt에서 새로) |
| 설정 | `config`, `winconf`(창 설정 규칙: 채널 키, 머리말, 정렬, 창별 옵션), `paths`, `hotkeys`, `fonts` |
| 기타 | `i18n`(+`locale/`), `credits`, `logsetup`, `updatecheck`(2.x 태그만), `resmeter`, `version`, `make_zip` |

`winconf`는 1.x `childwin.py`에서 창 코드를 뺀 순수 설정 부분이다 (`clamp_end`, `bottom_fill` 같은 Tk 텍스트 우회는 가져오지 않았다).

## 앞으로 만들 것

```
app/
  pipeline.py      (1단계) 줄 처리 코어: 줄 → 필터 → 채널 분류 → 번역 요청 → 화면 이벤트
  ui/              (2단계) ChatWindow, 입력창, 음성 표시, 트레이 (Qt)
  native/          (3단계) 게임 창 찾기, z-order 따라가기, 클릭 관통, 작업표시줄 숨김, 블러 (HWND / NSWindow)
  options/         (4단계) 옵션 창 (Qt)
  app.py           (5단계) 시작과 연결만
```

### 코어와 화면 사이의 이벤트 (초안, 1단계에서 확정)

코어는 상태를 들고 있고, 화면은 이벤트를 받아 그리기만 한다.

| 이벤트 | 담고 있는 것 |
|---|---|
| `LineAdded` | 줄 id, 채널, 보낸 사람, 원문, 어느 창들에 보일지(창 id 목록) |
| `TranslationReady` | 줄 id, 번역문(이미 용어집 적용), 번역 방식 |
| `TranslationFailed` | 줄 id, 이유 (화면에는 짧게, 자세한 것은 로그) |
| `PartialText` | 음성 인식 중간 결과 (실제 줄이 되면 사라짐) |
| `SystemNote` | 상태·오류 안내 줄 (캡처 상태, 음성 상태 등) |
| `Cleared` | 창 비우기 |

창에 보일지는 코어가 `winconf.accepts / parent_shows`로 정하고, 화면은 필터를 다시 계산하지 않는다.

## 버리는 것 (tkinter 우회)

Qt에서는 이유가 없어지거나 정석 기능으로 대체되므로 옮기지 않는다.

| 1.x의 우회 | Qt에서 |
|---|---|
| 글자 창 + 배경 창 두 장 (색 키로 배경을 투명하게 뚫음) | 창 한 장, `WA_TranslucentBackground` + 배경 직접 그리기 |
| 그림자용 별도 창과 `_shadow_refresh`(글을 복사해 따라가게 함) | 그림자를 같은 위젯에서 그리거나 검은 뷰를 아래에 하나 둠 (프로토타입에서 확인) |
| 마지막 빈 줄 처리 (`end-2c`, `clamp_end`, `bottom_fill`의 spacing 태그) | `QTextDocument`에는 없는 문제. "글 아래 붙이기"는 레이아웃으로 |
| 번역을 끼워 넣는 마크(`tr{token}`, `trb`, `trl`)와 태그 지정 | 줄 id를 가진 블록(`QTextBlock`) 단위 갱신 |
| z-order 따라가기 타이머, `FORCE_TWO_WINDOW`, `RESHOW_FOR_TASKBAR`, `POLL_RESIZE`, `RESIZE_CURSOR`, `RIGHT_CLICKS` | `Qt.Tool` + `native/`의 한 곳, 크기 조절은 Qt의 시스템 리사이즈 |
| 옵션 창의 `_scrollable` (캔버스 + fit + rewrap + 150 ms 폴링) | 레이아웃과 `QScrollArea` |
| 화면 이동/표시에서의 1프레임 깜빡임 보정 | 프로토타입에서 확인된 정석 호출로 |
| 부모/자식 창 코드가 둘로 나뉜 것 (`plat` 믹스인을 비바운드로 재사용) | 하나의 `ChatWindow` |

## 블러·창 효과 결정 (프로토타입 결과)

- Windows 10/11: `SetWindowCompositionAttribute` 상태 3(약함) / 4(강함). Win11 아크릴(5)은 옵션으로 두되 아직 시험하지 않았다.
- macOS: 비공개 `CGSSetWindowBackgroundBlurRadius`, 약함 14 / 강함 40. 공개 API(NSVisualEffectView)로는 같은 효과가 나오지 않았다.
- DPI 배율은 이번 버전에서 다루지 않는다.

## 단계

0. (끝) 1.8.1, 업데이트 확인을 같은 메이저로 제한.
1. 줄 처리 코어 분리 (`pipeline.py` + Qt 없는 테스트).
2. `ChatWindow` (창 1개의 표시, 정렬, 번역 줄, 스크롤, 창별 설정).
3. `native/` (게임 창 따라가기, 클릭 관통, 블러, 작업표시줄).
4. 옵션 창.
5. 입력창, 음성 표시, 트레이, 단축키, 설정 이전(`config.1x.json` 백업, `windows` 목록).
6. 베타 (`v2.0.0-beta`는 GitHub pre-release), 맥/윈도우 시험, 정식 `v2.0.0`.

## 아직 고쳐야 할 문서

`docs/MAC.md`, `extensions/stt/README.md`는 1.x 기준이다. 실행 방식이 정해지면 고친다.
