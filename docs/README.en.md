[한국어](./README.md) | [English](./README.en.md)

<img width="479" height="417" alt="image" src="https://github.com/user-attachments/assets/6cb0a2e0-7340-4b8d-989f-ef7d1eb729e9" />
# ChatMatrixReader
A real-time, automated translator for World of Warcraft.

# Features
- Automatically detects and translates in-game chat in real time.
- Uses Google Translate by default. While the default service is primarily limited to basic contextual translation, it is more than sufficient for gameplay. If you encounter usage limits (though this is rare and usually stems from other issues), you can provide your own Google API key (Google offers 500,000 characters free per month, with a cost of $20 per 1 million characters).
- You can also integrate your own AI models using tools like LM Studio. (World of Warcraft typically consumes about 8GB of VRAM; allocating an additional 4GB to an AI model will result in high-quality, robust translations.)
- Includes a glossary feature that allows you to add terms in real time. The application comes pre-configured with Google Translate and a default prompt for AI integration.
- Pressing 'Shift + Enter' while in-game opens an input field below the translation window. After typing in Korean and pressing Enter, the translated English text is automatically copied to your clipboard (equivalent to Ctrl + C). (An option is available to automatically perform a 'Ctrl + V' paste, though you will still need to press Enter manually after a final review.)
- Offers two display modes: "Always on Top" and "Always on Top of WoW." The latter ensures the translation window remains visible even when you switch to other applications while playing WoW.
- Enabling the "Click-Through" option removes the window title and border, leaving only the translation window itself. In this mode, you can interact with the window by holding down the 'Shift' key while hovering your mouse over it. - You can customize the background transparency, font size, line height, font style, and drop shadows. With the right settings, the translation window can be integrated into the *World of Warcraft* interface so seamlessly that it feels like a natural part of the game.
- The tool supports multiple languages. Since it relies on text translation rather than image recognition, it can handle any language supported by Google’s language detection.
- The interface is built in Korean, with an English localization already included. Adding other languages ​​is simple—you just need to place a text file into the `locale` folder.
- You can use regular expressions (regex) to filter text. For example, you can exclude specific strings from being translated or hidden from the translation window (e.g., filtering out any text containing Korean characters).
- The tool includes "blur" and "hover" features. The blur effect softens the background rather than creating a solid, opaque block. The hover feature—useful when "click-through" mode is enabled—allows the translation window to disappear when you move your mouse cursor over it, letting you see and interact with whatever lies behind it.
- When the options window is in focus, you can use keyboard shortcuts: Ctrl+C to save and ESC to close.
- You can apply filters to ensure that only the content you want to see is displayed.
- A speech-to-text (STT) feature has been added. It can detect speech from Discord, World of Warcraft, or other programs, convert it into text, and then translate that text using your chosen translation method.

# Important Notes
- The only limitation is that, due to stricter addon censorship implemented after the *World of Warcraft* expansion *The War Within*, certain types of messages—specifically those related to guild administration, battlegrounds, and boss encounters—cannot be captured.
- A "message safety net" is in place, allowing for the collection of all other messages (provided that the "Other" category is enabled in the addon settings and your personal chat filter settings allow it). However, as noted, messages concerning guild administration, battlegrounds, and boss encounters remain inaccessible due to censorship imposed by Blizzard; the reason for this is unclear. Notably, these issues do not pose a significant problem when playing on North American servers. Furthermore, recent official API patch notes suggest the possibility of future improvements in this area.
- I have personally tested this on both the "Retail" (live) and "Forever" (Classic Era) servers; however, compatibility with other versions (such as other Classic iterations) remains unconfirmed. It is likely that simply updating the version compatibility in the `.toc` file will be sufficient.
- The software has been tested on both Windows and macOS. As the macOS version is a recent development and has only been tested on my own MacBook, there may still be some initial "trial and error" involved.
- Post-processing features that alter image colors—such as DLSS or HDR—may interfere with the addon's functionality. That said, because the system includes a color-detection feature, lowering the "level" setting within the addon from 256 to 16 generally allows for successful detection (this remains effective even when the in-game brightness is set to 100%).
- Similarly, on MacBooks, the Retina display scaling (default 2x) makes detection impossible at the 256-level setting; however, lowering it to 16 levels resolves this issue.
- On macOS, you can run the application via the `.app` file, though the initial setup process—specifically regarding permissions—can be somewhat cumbersome. (While registering as an Apple Developer and signing the application would resolve this, I have no intention of paying the annual Apple Developer fee. Instructions for macOS installation are provided further down.)

# Development Philosophy
- Lightweight: Designed to be as lightweight as possible, with minimal resource consumption and a small file size. - Text-only: It extracts text with 100% accuracy by pulling chat data directly from the add-on, without relying on image recognition (OCR or AI Vision).
- Minimalist: The interface is kept hidden as much as possible, displaying only the translated text.
- Educational: I have no intention of completely removing or replacing the original English text; that is not my goal.
- Safe: The method does not involve DLL injection or memory manipulation, ensuring there is zero risk of a ban from Blizzard.

# Requirements for Installation
- Python (<a href="https://www.python.org/downloads/release/python-3110/">python-3.11</a> or <a href="https://www.python.org/downloads/release/python-3152/">python-3.15</a>) — *Note: Do not use the "Python install manager" (the yellow button); instead, download the installer appropriate for your OS—either "macOS 64-bit universal2 installer" or "Windows installer (64-bit)."*
- Add-on: ChatMatrix (available on <a href="https://www.curseforge.com/wow/addons/chatmatrix">CurseForge</a>)
- Program: ChatMatrixReader (available on <a href="https://github.com/blackmass/ChatMatrixReader/releases">GitHub</a>) — *Note: Please download the "ChatMatrixReader.xxx.zip" file, not the source code.*
- If the latest version of the add-on is delayed in being approved on CurseForge, please check this <a href="https://drive.google.com/drive/u/0/folders/1vAJJ8w9MMW5qJzxfjg5qSktN5XhH77ow">Google Drive</a> folder. - Install the add-on into your add-ons folder, install Python on your operating system, and extract the program files to any location of your choice, then run 'run.bat'.

# Add-on Features
- Upon the first launch, a green "matrix box" will appear. Drag it to a clearly visible area and use the command `/cm lock` to secure it in place. Ensure it is not obstructed by other interface elements.
- Access various settings via `Esc` > `Settings` > `AddOns`. Here, you can lock or unlock the matrix box and precisely filter which chat channels you wish to have translated.
- If changes to brightness, contrast, or scaling result in lower recognition accuracy, you can typically resolve this by lowering the "color level" and increasing the "matrix size" within the add-on settings.
- When playing on a server in a different language using a different game client, the add-on automatically replaces links (for items, quests, skills, etc.) to match the language of the client you are currently using.
- Since the add-on displays all types of messages—including gold gains, item acquisitions, and experience points—it can serve as a complete replacement for the default World of Warcraft chat window. (Note: Text generated by other separate add-ons will not be displayed.)
- The add-on precisely filters specific chat messages for the user to read—covering all visible chat tabs, newly created tabs, and custom user-defined chat tabs.

# How to Update
- As the `config.json` file is not included in the release archive, you can simply overwrite the existing files whenever you update the add-on or the program.

# Use LM Studio to translate with local AI models for free.
- <a href="https://github.com/blackmass/ChatMatrixReader/blob/main/LM%20Studio.md">(link)</a> A brief user guide is available here.

# Installation on Mac
- Download and extract the files as you would with any standard application.
- Open your terminal, navigate to the directory, and run the following command to remove the quarantine attribute: `xattr -dr com.apple.quarantine ~/Documents/ChatMatrixReader` (You may need to repeat this step after each update.)
- Launch `ChatMatrix Reader.app` from within the folder. The first time you run it, a terminal window will appear to set up the virtual environment, and you will be prompted to grant permissions. Accept these requests, close the app completely, and relaunch it. You may encounter additional permission prompts—repeat this process (closing and relaunching) about three times. Once no further prompts appear, the environment is correctly configured.
- While all my source code is open-source, if you have any concerns, it is best not to run the application. (To be frank, I don’t have a particular attachment to the Mac platform.)
- Many features remain untested, though the core functionality has been verified. (Known issues or untested areas include potential problems with the top menu bar display, font-related issues, etc.)

# Feedback
- Feel free to suggest new features, provided they align with the project's overall direction.
- If the text in the translation window appears strange, or if certain messages fail to be captured, please enable the two "debug" options in the add-on settings. You can then retrieve the logs by clicking the icon added to your minimap or by checking the "Log" tab within the reader's options.

# Why local AI is not built into the program.
- I have no intention of integrating local AI directly into this software, as such technologies are constantly evolving and subject to replacement.
- This is why features like local AI for translation or STT (speech-to-text) are designed to rely on external connections, with the software simply providing guidance to the user.
- In these fields, better models and more efficient operating methods emerge almost daily; the only thing that remains constant is the method of connection.
- Since I cannot predict when I might stop updating this program, I have prioritized external connectivity—allowing users to adapt to new developments as technology progresses.

# Frequently Asked Questions
- Which server do you play on? : North America Retail (Tichondrius), North America Classic (Forever) PvP
- Google Translate is restricted: I’ve kept the program running for an entire week without any issues, so I haven’t encountered this myself—it’s highly likely that the cause is something else. Please try installing Python 3.11 and 3.15, then run the 'run 3.11' and 'run 3.15' scripts respectively; let me know if either of them works. If Google Translate were truly restricted for your IP, you would also be blocked from using Google Translate in your web browser. If that’s not the case, it’s likely due to Google’s security policies, which change frequently. I am currently looking for a 100% legitimate, standardized solution—rather than relying on "hacks" or workarounds—to ensure everything runs smoothly using only the 'run.bat' file.
- How can I get the official WoW font?: Due to copyright restrictions, I cannot include the official font in my releases. (For Korean users, try searching for the "Yoon 2002" or "WoW 2002" font.)
- "Matrix" detection isn't working: First, we need to verify whether it’s actually failing to detect the matrix. Many users claim this without having installed the add-on correctly. Please ensure the add-on is installed and placed in a clearly visible area, then click "Refresh" in the translation window. If it still isn't detected, try lowering the sensitivity setting by one step and refresh again.
- The "Send" input (Shift+Enter) isn't working: This can happen if one program (the translator or WoW) is running with administrator privileges while the other is not. It’s also possible that the feature is simply disabled in the settings; please check the "Send" tab in the options menu. - Is there a word list available?: I likely won’t be sharing a word list myself. However, I will continue to provide better rules for filtering. Feel free to share lists with one another or create your own!
- I only want to see specific things: The add-on and the reader both offer detailed filtering options. Since this tool was designed to fully replace the default World of Warcraft chat window—and follows the structure of the game’s standard chat tabs—you may initially see content you’d prefer to filter out.
- Something just isn’t working: Try providing a link to my GitHub page to an AI like GPT or Gemini and ask for assistance. Everything is 100% open source, and I’ve even included the protocol documentation. Furthermore, because the project avoids heavy frameworks and image files—keeping the total size of both the add-on and the program under 1MB—any AI should be able to analyze it effectively.