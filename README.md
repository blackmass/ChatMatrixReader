<img width="491" height="450" alt="Image" src="https://github.com/user-attachments/assets/23c26dcb-d928-4d1c-ab75-25564d7e6431" />

# ChatMatrixReader
- It does not involve DLL injection, nor does it rely on heavy, low-accuracy OCR. This is a 100% safe method for real-time translation.
- 완전 안전하게 실시간으로 와우 채팅 번역하기. 무겁고 불안정한 OCR도 아니고, DLL 삽입도 아닙니다.

- Three requirements. 필요한 3가지. (<a href="https://www.curseforge.com/wow/addons/chatmatrix">ChatMatrix</a>, <a href="https://github.com/blackmass/ChatMatrixReader/releases">ChatMatrixReader</a>, <a href="https://www.python.org/downloads/release/python-3110/">python-3.11</a> or <a href="https://www.python.org/downloads/release/python-3152/">python-3.15</a>)
- Do not click the yellow button labeled [Download Python install manager]. You need to download the 'Windows installer (64-bit)' version found further down the page.
- 위 링크로 파이썬 다운로드 시, 제발 노란버튼 누르지 말고 정상적인 하단의 설치파일을 설치하세요.
- I have now resolved all issues regarding Python version compatibility. However, should any problems arise, please try running 'run 3.11.bat' or 'run 3.15.bat'.
- 파이썬 버전 문제를 완전히 해결했기에 'run.bat'를 실행하면 되지만, , 혹시나 번역 문제가 생긴다면 run 3.11.bat 혹은 run 3.15.bat 를 실행해보시기 바랍니다.

# Addon
<a href="https://www.curseforge.com/wow/addons/chatmatrix">Addon - Chatmatrix </a>
- First, you will need an add-on. This add-on condenses in-game chat in World of Warcraft into specific color patterns, allowing this program to read it.
- 먼저 이 프로그램을 쓰려면 이 애드온이 필요합니다.
- Initially, the matrix is ​​highlighted with a green rectangle. Drag it to your desired position and enter '/cm lock'.
- 처음에는 매트릭스가 초록색 사각형으로 강조되어 있습니다. 드래그 해서 원하는 위치에 두고 '/cm lock' 을 입력하세요.

<img width="460" height="189" alt="Image" src="https://github.com/user-attachments/assets/c0b4c02d-82a6-4b79-93cb-b56c20527007" />
<img width="525" height="463" alt="Image" src="https://github.com/user-attachments/assets/a3dc52ce-0c16-4d4e-a808-a0a00a4e562b" />

# Function
- If you set the translation method to Google Translate, it will work properly without requiring any additional configuration.
- 기본적으로 구글 번역을 설정하면 별 문제 없이 작동합니다.
- When the "always on top" setting is enabled, mouse clicks will pass through the window, ensuring it does not interfere with your gameplay. (Note: You can still interact with it by holding down the Shift key.)
- 항상 위에 표시 설정을 하면 마우스 클릭이 관통 되어 게임 하는것을 방해하지 않습니다. (단 쉬프트를 누르고 있으면 상호작용이 됩니다.)
- There are some necessary items in the settings window.
- 설정창에 필요한 것들이 있습니다.
- (v1.1.0 ~) During gameplay, pressing 'Shift+Enter' opens an input box that automatically translates your messages. By default, once you type your message and press Enter, the text is saved to your clipboard; you can then paste it using 'Ctrl+V', or enable the 'auto-paste' option in the settings.
- 게임 도중 '쉬프트+엔터'를 누르면 내 채팅을 자동으로 번역해주는 입력창이 뜹니다. 기본적으로는 팝업된 입력창에 대화를 입력하고 엔터 누르면 클립보드에 저장되기 때문에, Ctrl+v를 하거나 옵션에서 자동 붙여넣기를 체크하세요.
- Claude did all of this in just half a day.
- I have only tested this on Windows.
- <b>It may not function correctly if you use features such as DLSS 5, HDR, or Windows display scaling, which alter the colors on the screen.</b>
- <b>화면의 색상을 변경하는 dlss5, hdr, 윈도우 화면 배율 등을 사용할 경우 작동하지 않을 가능성이 있습니다.</b>
- Starting with version 1.3.1, an automatic detection feature for color changes has been included. Additionally, the add-on now allows for the adjustment of matrix levels. If the colors differ from the original or if the brightness has changed, lowering the level while increasing the matrix size will improve the detection rate.
- 다만 1.3.1 버전부터 색상 변화에 대한 자동감지 기능을 넣었습니다. 애드온에서 매트릭스 레벨 단계를 조절할 수 있는 기능을 넣었습니다. 원본 색상이 아니거나 밝기가 변경되는 경우, 레벨 단계를 낮추고 매트릭스를 키우면 인지율이 올라가니다.
- If the matrix remains hidden for an extended period, it may not be immediately recognized when you shift focus to WoW; in such cases, please click the window refresh icon.
- 매트릭스가 장기간 가려지면, 와우로 초점을 옮겨도 바로 인식되지 않기, 창 새로고침 아이콘을 누르세요.

- Recommended settings (transparent background, display only over the WoW window, ignore mouse clicks—interact only while holding Shift.)
- 추천하는 세팅 (배경 투명, 와우 창 위에만 표시, 클릭 통과 후 쉬프트로만 상호작용.)
  
<img width="676" height="955" alt="image" src="https://github.com/user-attachments/assets/048bee64-077d-4e3a-a77a-f776b8a98bef" />
<img width="676" height="505" alt="image" src="https://github.com/user-attachments/assets/8ffddbb3-8917-4d62-bffd-1890a6af1042" />

# update
- 1.3.1 버전부터 색상 변화에 대한 자동감지 기능을 넣었습니다. 애드온에서 매트릭스 레벨 단계를 조절할 수 있는 기능을 넣었습니다. 원본 색상이 아니거나 밝기가 변경되는 경우, 레벨 단계를 낮추고 매트릭스를 키우면 인지율이 올라가니다.
- If the matrix remains hidden for an extended period, it may not be immediately recognized when you shift focus to WoW; in such cases, please click the window refresh icon.
