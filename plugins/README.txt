플러그인 넣는 곳 / Put plugins here

플러그인은 이 폴더 안에 "폴더째" 넣습니다 (plugins/<플러그인 이름>/plugin.json 이 있어야 합니다).
넣은 뒤 옵션 창의 플러그인 탭에서 목록을 새로 읽고, 요청하는 권한을 확인한 다음 켜세요.

- 믿을 수 있는 곳에서 받은 플러그인만 넣으세요. 플러그인은 격리된 곳에서 실행되고 허용한 일만 할 수 있지만, 허용한 권한(인터넷 접속, 채팅창에 글 넣기 등)은 쓸 수 있습니다.
- 플러그인이 저장하는 데이터는 이 폴더가 아니라 프로그램 폴더의 plugin-data 폴더에 따로 쌓입니다. 플러그인을 지워도 남아 있습니다.
- 이 폴더의 플러그인은 프로그램과 함께 배포되지 않습니다.

Put each plugin in this folder as a folder of its own (plugins/<plugin name>/plugin.json must exist).
Then read the list again in the Plugins tab of the options window, look at the permissions it asks for, and turn it on.

- Only add plugins from a source you trust. A plugin runs in an isolated place and can only do what you allow, but the permissions you allow (internet access, putting lines into the chat ...) can be used.
- The data a plugin saves is kept in the plugin-data folder of the program folder, not here. It stays when you delete the plugin.
- The plugins in this folder are not part of the program.
