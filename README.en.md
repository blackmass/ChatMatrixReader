[한국어](./README.md) | [English](./README.en.md)

<img width="479" height="417" alt="image" src="https://github.com/user-attachments/assets/6cb0a2e0-7340-4b8d-989f-ef7d1eb729e9" />

# ChatMatrixReader
A real-time, automated translator for World of Warcraft.

# Features
- Automatically detects and translates in-game chat in real time.
- Uses Google Translate by default. While the default service is primarily limited to basic contextual translation, it is more than sufficient for gameplay. If you encounter usage limits (though this is rare and usually stems from other issues), you can provide your own Google API key (Google offers 500,000 characters free per month, with a cost of $20 per 1 million characters).
- You can also integrate your own AI models using tools like LM Studio. (World of Warcraft typically consumes about 8GB of VRAM; allocating an additional 4GB to an AI model will result in high-quality, robust translations.)
- Includes a glossary feature that allows you to add terms in real time. The software comes pre-configured with Google Translate and the necessary prompts for AI integration.
- Pressing 'Shift + Enter' while in-game opens an input field below the translation window. After typing in Korean and pressing Enter, the translated English text is automatically copied to your clipboard (equivalent to Ctrl+C). (An option is available to automatically perform a 'Ctrl+V' paste, though you will still need to press Enter manually after a final review.)
- Offers "Always on Top" and "Always on Top of WoW" display modes. The latter ensures the translation window remains visible even when you switch to other applications while playing WoW.
- Enabling the "Click-Through" option removes the window title and borders, leaving only the translation text visible. In this mode, you can interact with the window by holding the Shift key while hovering your mouse over it. - You can customize the background transparency, font size, line height, font style, and shadows, or even swap fonts entirely. With the right settings, the interface can blend seamlessly into your *World of Warcraft* game screen.
- The tool supports multiple languages. Since it relies on pure text translation rather than image recognition, it can handle any language supported by Google’s language detection.
- The interface is built in Korean by default, with an English localization already included. Adding other languages ​​is simple—you just need to place a text file into the `locale` folder.
- You can use regular expressions to check strings. This allows you to exclude specific content from translation or hide it from the translation window (e.g., excluding text that contains Korean characters).
- It includes 'blur' and 'hover' features. The 'blur' effect renders the background as a blurred image rather than a solid color, ensuring that the content behind the translation window is not completely obscured. The 'hover' feature—available when 'click-through' mode is enabled—allows the translation window to disappear whenever you move your mouse cursor over it, revealing the content underneath and enabling you to interact with it.
- When the options window is in focus, you can use keyboard shortcuts to save (Ctrl+C) or close (ESC) it.

# Important Notes
- The tool has been tested on *World of Warcraft: Retail* and *WoW Classic: Forever* (the versions I currently play). Compatibility with other versions (such as *WoW Classic*) is not yet confirmed, though it may simply require an update to the version compatibility field in the `.toc` file.
- It has been tested on both Windows and macOS. As the macOS version is a recent development and has only been tested on my own MacBook, you may encounter some initial issues.
- Post-processing features that alter image colors—such as DLSS or HDR—may interfere with the tool's functionality. However, because the tool includes a color-detection adjustment feature, you can usually resolve this by lowering the "level" setting from 256 to 16. (Detection remains functional even with the in-game brightness set to 100%.)
- On MacBooks, due to the nature of Retina displays, the default setting (x2 scale) makes detection impossible at the "256 level" configuration; lowering this to "16" will enable proper detection.
- To run the application on a MacBook, you simply launch the `.app` file, though please note that the initial setup process requires configuring several system permissions, which can be a bit cumbersome. (While this could be resolved by registering as an Apple Developer and signing the application, I have no intention of paying the annual Apple Developer fee. Instructions for Mac installation are provided further down.)

# Development Philosophy
- Lightweight: Designed to be as lightweight as possible, with minimal resource consumption and a small footprint.
- Text-Only: No image recognition (OCR or AI Vision) is used; instead, the tool retrieves chat data directly from the add-on, ensuring 100% accurate text extraction.
- Minimalist: The interface is kept hidden whenever possible, displaying only the translated text.
- Educational: My goal is not to completely remove or replace the English text; that is not the direction I intend to take.
- Safe: The tool does not perform DLL injection or interfere with game memory, ensuring there is zero risk of a ban from Blizzard.

# Requirements for Installation
- Python (<a href="https://www.python.org/downloads/release/python-3110/">python-3.11</a> or <a href="https://www.python.org/downloads/release/python-3152/">python-3.15</a>) ※ Please download the 'macOS 64-bit universal2 installer' or 'Windows installer (64-bit)'—whichever matches your operating system—rather than using the 'Python install manager' (the yellow button).
- Add-on: ChatMatrix (available on <a href="https://www.curseforge.com/wow/addons/chatmatrix">CurseForge</a>)
- Program: ChatMatrixReader (available on <a href="https://github.com/blackmass/ChatMatrixReader/releases">GitHub</a>) ※ Please download the 'ChatMatrixReader.xxx.zip' file, not the source code. # Add-on Features
...Under construction

# Addon Features
- Upon the first launch, a green "matrix box" will appear. Drag it to a clearly visible area and use the command `/cm lock` to secure it in place. Ensure it is not obstructed by other interface elements.
- You can access various settings via the menu: Esc > Settings > Add-ons. Here, you can lock or unlock the box, as well as apply precise filters to select which chat channels should be translated.
- If changes to brightness, contrast, or scaling result in lower recognition accuracy, you can typically resolve this by lowering the "color level" and increasing the size of the matrix box within the add-on settings.
- When playing on a server in a different language, if the client you are using differs from the server's language, the links are automatically updated to match your client's language and displayed in the translation window (covering items, quests, skills, etc.).
- Since it displays everything—including miscellaneous messages (such as gold, items, or experience points gained)—it can completely replace the default World of Warcraft chat window. (Note, however, that text generated by other separate add-ons will not appear here.)

# How to Update
- Since `config.json` is generally not included in the release archive, you can simply overwrite the existing files whenever you update the add-on or the program.

# Using LM Studio for Free Local AI-Powered Translation
- The functionality is already in place, but I will organize or revise it later to make it easier to understand.

# Installation on macOS
- Download and extract the files as you would normally.
- Open Terminal, navigate to the directory, and run the following command to remove the quarantine attribute: `xattr -dr com.apple.quarantine ~/Documents/ChatMatrixReader` (You may need to repeat this step after every update.)
- Launch `ChatMatrix Reader.app` from the folder. Upon the first launch, a Terminal window will appear to set up the virtual environment, and you will be prompted to grant permissions. Accept the requests, close the app completely, and relaunch it. You may encounter additional permission prompts—repeat the process of closing and relaunching the app (typically about three times) until no further prompts appear; the environment is then correctly configured.
- While all my source code is open-source, if you feel uncomfortable, it is best not to run the application. (To be frank, I don’t have much personal attachment to the macOS platform.)
- Many features remain untested, though the core functionality has been verified. (Known issues or untested areas include: potential failure to appear in the top menu bar, font-related problems, etc.)

# Frequently Asked Questions (FAQ)
- Which servers do you play on? : North America Retail (Tichondrius) and North America Forever (PvP)
- I’ve hit a Google Translate limit : I haven’t encountered this myself—even when leaving the program running for an entire week—so it’s highly likely that the issue stems from something else. Please try installing Python 3.11 and 3.15, then run the 'run 3.11' and 'run 3.15' commands, respectively; let me know if either one works. If you were truly hit by a Google Translate limit, you should also be blocked from using Google Translate in your web browser from the same IP address. If that’s not the case, the issue is likely due to Google’s security protocols, which change almost daily. I am currently working on a 100% legitimate, standardized solution—rather than relying on forced workarounds—to ensure that everything runs smoothly using only 'run.bat'.