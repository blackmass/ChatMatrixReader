[한국어는 아래](#코드-서명-정책-한국어) | English below

# Code signing policy

> **Status:** an application for free code signing by SignPath Foundation has been submitted. Until it is approved the releases are **not** signed.
> (Remove this note when the first signed release is published.)

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/)

## What is signed

- `ChatMatrixReader.exe` inside `ChatMatrixReader-v<version>-windows-x64.zip` of every [release](https://github.com/blackmass/ChatMatrixReader/releases) of this repository.
- Nothing else is signed with this certificate: not the voice recognition engine (`cmr-stt`, built from [whisper.cpp](https://github.com/ggml-org/whisper.cpp) and downloaded apart from the program), not the macOS app, not the addon.
- The signed program is built by an automated build (GitHub Actions) from the source code of this repository, from the tagged commit of the release. The build scripts and the build configuration are in this repository too.
- The product name of the signed file is `ChatMatrixReader`; the product version is the version of the release (the same value in every file of the build).

## Team and roles

This is a project of one maintainer. All code signing roles are held by the same person:

- **Authors** (may change the source code without a review): the maintainer, [blackmass](https://github.com/blackmass).
- **Reviewers** (review changes proposed by other people, e.g. pull requests): the maintainer. A change from anybody else is only merged after the maintainer has reviewed it.
- **Approvers** (approve every signing request): the maintainer. Every release is approved by hand in SignPath; nothing is signed automatically.

The maintainer uses multi-factor authentication for GitHub and for SignPath.

## Releases

1. The version is set in one place (`app/core/version.js`) and the release is tagged with the same number.
2. The Windows program is built from the tagged commit by GitHub Actions and submitted to SignPath.
3. The maintainer checks the build and approves the signing request.
4. The signed program is put into the release zip, together with `BUILD-INFO.txt` (the SHA-256 of every file and the commit it was built from).

## Privacy policy

The program does not collect any information about its users and has no analytics or telemetry. The only things that leave the computer are the following, and each one happens only because of what the user has set up:

- **Translation:** the chat text that is to be translated is sent to the translation service the user chose in the options (Google Translate, or an AI server / custom server the user entered). Nothing is sent when translation is off.
- **Checking for a new version:** at start the program reads the release list of this repository from GitHub (can be turned off in the options). Nothing about the user is sent besides what any web request carries.
- **Voice recognition (optional):** the engine is downloaded from this repository's releases and the model from [Hugging Face](https://huggingface.co/ggerganov/whisper.cpp), when the user presses "install". The sound is processed on the computer only, unless the user chooses the "OpenAI compatible server" method and enters a server: then the sound goes to that server.

Settings, logs, the glossary and the fonts are stored only in the program's own folder. The program does not write to the registry and does not install anything.
The privacy practices of the services the user chooses (Google, the AI server, Hugging Face, GitHub) are theirs; please read them.

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

## Third-party components

The licenses of every library built into the program are in `THIRD-PARTY-NOTICES.txt` of the release. The voice recognition engine contains whisper.cpp (MIT); the models are OpenAI Whisper (MIT).

## Contact

Questions about this policy or a report of a violation: open an [issue](https://github.com/blackmass/ChatMatrixReader/issues) in this repository.

---

# 코드 서명 정책 (한국어)

> **상태:** SignPath Foundation의 무료 코드 서명을 신청했습니다. 승인되기 전까지 릴리스는 **서명되어 있지 않습니다.** (첫 서명 릴리스를 올릴 때 이 안내를 지웁니다.)

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/)

## 서명하는 것
- 이 저장소의 모든 [릴리스](https://github.com/blackmass/ChatMatrixReader/releases)에 있는 `ChatMatrixReader-v<버전>-windows-x64.zip` 안의 `ChatMatrixReader.exe`.
- 그 밖의 것은 이 인증서로 서명하지 않습니다. 음성인식 엔진(`cmr-stt`, [whisper.cpp](https://github.com/ggml-org/whisper.cpp)로 만들어 프로그램과 따로 받음), macOS 앱, 애드온은 서명 대상이 아닙니다.
- 서명하는 프로그램은 이 저장소의 소스로, 릴리스에 붙은 태그의 커밋에서 자동 빌드(GitHub Actions)로 만듭니다. 빌드 스크립트와 설정도 이 저장소에 있습니다.
- 서명 파일의 제품 이름은 `ChatMatrixReader`이고, 제품 버전은 릴리스 버전입니다.

## 팀과 역할
유지보수자 한 명의 프로젝트라서 모든 역할을 같은 사람이 맡습니다.
- **작성자**(검토 없이 소스를 바꿀 수 있는 사람): 유지보수자 [blackmass](https://github.com/blackmass).
- **검토자**(다른 사람이 제안한 변경, 예: 풀 리퀘스트를 검토): 유지보수자. 다른 사람의 변경은 유지보수자가 검토한 뒤에만 반영합니다.
- **승인자**(모든 서명 요청을 승인): 유지보수자. 릴리스마다 SignPath에서 직접 승인하고, 자동으로 서명되는 것은 없습니다.

유지보수자는 GitHub와 SignPath에 다단계 인증(MFA)을 씁니다.

## 릴리스 순서
1. 버전은 한 곳(`app/core/version.js`)에서 정하고, 같은 번호로 릴리스 태그를 붙입니다.
2. Windows 프로그램을 태그 커밋에서 GitHub Actions로 빌드해서 SignPath에 보냅니다.
3. 유지보수자가 빌드를 확인하고 서명 요청을 승인합니다.
4. 서명된 프로그램을 릴리스 zip에 넣습니다. `BUILD-INFO.txt`에 모든 파일의 SHA-256과 빌드한 커밋이 적힙니다.

## 개인정보 정책
이 프로그램은 사용자에 대한 정보를 수집하지 않고, 분석이나 원격 측정도 없습니다. 컴퓨터 밖으로 나가는 것은 아래뿐이고, 모두 사용자가 설정한 것에 따라서만 일어납니다.
- **번역:** 번역할 채팅 글이 사용자가 옵션에서 고른 번역 서비스(구글 번역, 또는 사용자가 입력한 AI 서버/직접 설정한 서버)로 갑니다. 번역을 끄면 나가지 않습니다.
- **새 버전 확인:** 시작할 때 이 저장소의 릴리스 목록을 GitHub에서 읽습니다(옵션에서 끌 수 있음). 일반 웹 요청에 따라가는 것 외에 사용자 정보는 보내지 않습니다.
- **음성인식(선택):** "설치"를 누르면 엔진은 이 저장소의 릴리스에서, 모델은 [Hugging Face](https://huggingface.co/ggerganov/whisper.cpp)에서 받습니다. 소리는 컴퓨터 안에서만 처리됩니다. 다만 "OpenAI 호환 서버" 방식을 고르고 서버를 입력하면 그 서버로 소리가 갑니다.

설정, 로그, 단어장, 글꼴은 프로그램 폴더 안에만 저장됩니다. 레지스트리에 쓰거나 무언가를 설치하지 않습니다. 사용자가 고른 서비스(구글, AI 서버, Hugging Face, GitHub)의 개인정보 정책은 그 서비스의 것이니 확인해 주세요.

## 사용된 구성 요소
프로그램에 들어 있는 모든 라이브러리의 라이선스는 릴리스의 `THIRD-PARTY-NOTICES.txt`에 있습니다. 음성인식 엔진에는 whisper.cpp(MIT)가, 모델은 OpenAI Whisper(MIT)입니다.

## 문의
이 정책에 대한 질문이나 위반 신고는 이 저장소의 [이슈](https://github.com/blackmass/ChatMatrixReader/issues)로 알려 주세요.
