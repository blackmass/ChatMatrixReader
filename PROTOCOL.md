# ChatMatrix protocol v1

Grid: 32 columns x 4 rows of cells, each cell = 4x4 physical pixels, so the matrix is 128x16 px.
Cells are numbered row-major from the top-left (index 0..127). Each cell is one RGB color = 3 bytes (R, G, B).
The read position of a cell is the center of its 4x4 block (e.g. offset +2,+2).

| Cell | Content |
|---|---|
| 0 | `0x43 0x4D 0x01` ("C","M", version). Use this to locate the matrix on screen. |
| 1 | `seq`, 24-bit big endian. Changes on every redraw. |
| 2 | R,G = payload length (16-bit big endian); B = number of lines |
| 3 | 24-bit checksum of the payload bytes (below) |
| 4..126 | payload bytes, zero padded (max 369 bytes; default budget 255) |
| 127 | `0x4D 0x58 0x45` ("M","X","E") end marker |

Checksum:

```
s1 = s2 = 0
for each payload byte b: s1 = (s1 + b) % 4095; s2 = (s2 + s1) % 4095
checksum = s2 * 4096 + s1
```

Payload: UTF-8, lines separated by `\n`. Each line has four fields separated by `\x1F`:

```
<channel> \x1F <id> \x1F <sender> \x1F <text>
```

- channel: S say, Y yell, E emote, P party, PL party leader, R raid, RL raid leader, RW raid warning, I instance, IL instance leader, G guild, O officer, W whisper, B bnet whisper, WT whisper you sent (the name is the receiver), BT bnet whisper you sent, C<n> numbered channel n, CM community channel
- "other" messages (the chat window's "Other" settings) use codes that start with `!`: `!SY` system, `!XP` experience, `!HN` honor,
  `!RP` reputation, `!SK` skill, `!LT` loot, `!CY` currency, `!MN` money, `!TS` trade skills, `!OP` opening, `!PI` pet info,
  `!CI` misc. combat info, `!AC` / `!GA` achievements, `!BH` / `!BA` / `!BN` battleground, `!IG` ignored, `!TI` target icons,
  `!MS` `!MY` `!ME` `!MW` `!MP` NPC say / yell / emote / whisper / party, `!BE` `!BW` raid boss emote / whisper, `!CL` channel member list (`/chatlist`: `[5. kor] Name1, Name2`; dark red `#bf8080`).
  Lines the chat window showed that no captured event produced are sent as plain, never translated text: `!AD` when no chat event came
  with the line at all (an addon or the game wrote it directly; shown white), `!UN` when the line came with a chat event this addon does not
  capture (shown grey; the event name is printed by `/cm raw`).
  Except for the NPC / boss speech the sender field is empty (the text already contains the names). A reader that does
  not know a `!` code can show the line like any other; the codes never start with `C`, so they cannot be mistaken for channels.

- `!PG` - ping (`CHAT_MSG_PING`). The sender is kept. The text starts with one symbol that names the ping:
  `◈` normal / unknown (blue), `⚑` assist (green), `⚠` warning (red), `⚔` attack (orange), `▼` on my way (blue).
- Built-in text emotes (`CHAT_MSG_TEXT_EMOTE`) use channel `E` with an empty sender; the text already contains the names.
- `!BI` - Battle.net friend came online / went offline (rebuilt by the addon from `CHAT_MSG_BN_INLINE_TOAST_ALERT`). Empty sender.
- `!CN` - channel notice ("Changed Channel: [1. General - Stormwind City]", joined, left ...), built by the addon like the game's chat frame does from `CHAT_MSG_CHANNEL_NOTICE`. Empty sender. Filtered like the numbered channels.
- `!RS` - the chat restriction (boss fights) is over; sent only if unreadable lines (`[restricted]`) were seen during it. Empty sender; the text is ignored, the reader shows its own notice.
- `!TM` - "appearance added to your collection". The game prints this itself (it is not a chat event); the addon builds it from
  `TRANSMOG_COLLECTION_SOURCE_ADDED`. Empty sender. The reader shows the line yellow and the item name in one colour.
- Sent whispers use `WT` (character) and `BT` (Battle.net); the sender is the recipient.
- `/cm raw` prints the raw text of every chat event (with colour and link codes) for diagnosis; it is not part of the matrix.
- id: message counter 1..65535 (wraps). Use it to detect which lines are new.
- An empty sender in a normal channel line (`C<n>` ...) means nobody spoke: a server announcement (e.g. the Defense channel). The reader
  shows such a line without a name, in the system colour.
- text `[restricted]` with sender `?` means the client did not let the addon read that message.

Each redraw shows the newest lines that fit into the byte budget, so the same lines appear in several consecutive frames.
A reader should accept a frame only if the marker, end marker and checksum are valid, and translate only ids it has not seen before.

## Item links in the text field

Links are reduced to their name; a one-byte code around the name says how to colour it:

    \x02 <code> [Name] \x03

The code is the single character `chr(48 + n)` (n = 0..78, i.e. the bytes 0x30 .. 0x7E). The numbers are kept in groups of ten:

| n | meaning |
|---|---------|
| 0-9 | item quality: 0 poor, 1 common, 2 uncommon, 3 rare, 4 epic, 5 legendary, 6 artifact, 7 heirloom (8, 9 free). Battle pet and currency links use the quality of their link colour the same way |
| 10-19 | colours of other game links: 10 yellow (quest, achievement, map pin), 11 light blue `#71d5ff` (spell, talent, mount), 12 gold `#ffd100` (profession recipe; also the gold coins of a money line `1g`), 13 transmog purple `#e86bd0` (item name of "appearance added"), 14 silver coins `#c7c7cf` (`20s`), 15 copper coins `#eda55f` (`97c`) |
| 20 | a whole message that is gibberish to this character (spoken in a language it does not know, e.g. Orcish seen by the Alliance, Demonic): the reader does not translate it and shows it dim |
| 21-29 | reserved |
| 30-49 | class colours (`RAID_CLASS_COLORS`), 30-42 used: 30 Death Knight `#c41e3a`, 31 Demon Hunter `#a330c9`, 32 Druid `#ff7c0a`, 33 Evoker `#33937f`, 34 Hunter `#aad372`, 35 Mage `#3fc7eb`, 36 Monk `#00ff98`, 37 Paladin `#f48cba`, 38 Priest `#ffffff`, 39 Rogue `#fff468`, 40 Shaman `#0070dd`, 41 Warlock `#8788ee`, 42 Warrior `#c69b6d`. 43-49 free (new classes) |
| 50-70 | resource (power) colours: 50 Mana `#0000ff`, 51 Rage `#ff0000`, 52 Focus `#ff8040`, 53 Energy `#ffff00`, 54 Combo Points `#fff569`, 55 Runes `#808080`, 56 Runic Power `#00d1ff`, 57 Soul Shards `#80528c`, 58 Astral Power `#4d85e6`, 59 Holy Power `#f2e699`, 60 Maelstrom `#0080ff`, 61 Insanity `#6600cc`, 62 Chi `#b5ffeb`, 63 Arcane Charges `#1a1afa`, 64 Fury `#c942fd`, 65 Pain `#ff9c00`, 66 Ammo `#cc9900`, 67 Fuel `#008c80`, 68 Stagger light `#85ff85`, 69 Stagger medium `#fffab8`, 70 Stagger heavy `#ff6b6b` |
| 71-78 | the game's default chat colours that the rest of the palette lacks: 71 guild `#40ff40`, 72 officer `#40bf40`, 73 party `#aaaaff`, 74 party leader `#75c7ff`, 75 whisper `#ff80ff`, 76 yell `#ff4040`, 77 numbered channel `#ffc0c0`, 78 raid leader `#ff480a`. (say `#ffffff` = 1, emote `#ff8040` = 52, raid and instance `#ff8000` = 5, system and money `#ffff00` = 10) |

(The digits `0`-`9` are therefore the old item-quality codes; 10 is written as `:` and 11 as `;`. Earlier versions used the digit `9`
for yellow and `8` for light blue: addon and reader must be updated together.)
Quest links: the name is `[[level] Quest Name]`; an id appended by another addon is removed. Map pin links (`worldmap:mapID:x:y`)
are sent as `[◈ Map Pin Location]` (the game's diamond icon becomes the character ◈; the label comes from the client's own
`MAP_PIN_HYPERLINK` text); the coordinates are not sent. The addon puts the link names (item, spell, quest, achievement,
profession, mount, battle pet, currency) in the language of the player's own client when the client knows the id (option
"Show linked items ..."). A reader that does not know the marker can delete the bytes 0x02 and 0x03 and the code byte after
0x02; a code without a colour is shown plain. A message cut by the byte limit may lack the closing 0x03. This does not
change the pixel format or the protocol version.

## Speaker class (optional 5th field, v1 and v2)

A line may carry a fifth field after the text: `<channel> \x1F <id> \x1F <sender> \x1F <text> \x1F <class>`.
`class` is one letter, or absent / empty when unknown (system messages, restricted messages, no GUID):

| A | B | C | D | E | F | G | H | I | J | K | L | M |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Warrior | Paladin | Hunter | Rogue | Priest | Death Knight | Shaman | Mage | Warlock | Monk | Druid | Demon Hunter | Evoker |

(= class id 1..13, letter = `A + id - 1`; further letters are reserved.) The addon reads the class from the chat event's
GUID (`GetPlayerInfoByGUID`), skips it when the GUID is secret/missing. A reader that knows only four fields shows
`\x1F` plus the letter after the text, so the addon and the reader should be updated together.

# Protocol v2 - colour-change tolerant format

v1 stores a full byte (0..255) in every colour channel. If anything between the game and the screen capture changes
colours (brightness / gamma settings, graphics filters, HDR, night mode ...), two different byte values can end up as
the same screen colour and the information is gone for good. v2 therefore uses only **L = 2, 4, 8 or 16 well separated
levels** per channel and puts a **ramp of those levels into every frame**, so a reader can measure how the screen shows
them. Anything that keeps the levels in order (brightness, gamma, contrast, per-channel gains, black lift) is harmless.
The addon lets the user pick L; fewer levels = sturdier but bigger. v1 (256 levels) stays the default and is unchanged.

## Command lines (channel code starting with `@`)

A channel code that starts with `@` is an instruction from the addon to the reader, not a message: the reader never shows it,
whatever follows. `!` codes are lines that are shown (system, loot ...); `@` codes are acted on. The reader looks only at the
first character to tell them apart, and ignores every `@` code it does not know (an older reader meets newer commands).
No command is defined yet. Rules for the ones to come:
- a command carries the **whole state** it is about (`@CC` + every colour that changed, not "colour X changed"), so that it can be
  repeated or lost without harm: lines are dropped when the queue is full, and a reader started later never saw earlier ones;
- what matters is also carried by the lines themselves (like the base colour); a command only makes the reader react at once;
- a command only changes what the reader's own window shows (colours, clearing); it never touches files or other programs.
Candidates: `@CC` a chat type's colour changed (recolour the earlier lines), `@CL` the chat window was cleared.

The reader keeps the channel code of every line it shows (a hidden text tag `t_<code>` that also carries the colour), so that
an instruction can address all lines of one chat type.

## Base colour (optional 6th field)

A line may carry a sixth field after the class: `<channel> \x1F <id> \x1F <sender> \x1F <text> \x1F <class> \x1F <colour>`
(`class` is empty when the line has no class but a colour). `colour` is one character, `chr(48 + n)`, a code of the colour
palette below: the colour the user gave this kind of message in the game's chat settings (`ChatTypeInfo`; every numbered channel
has its own). The addon sends it only when the user's colour differs from the game's default colour, as the nearest palette colour
(no distance limit: the user chose it on purpose); without the field the reader uses its default colour for the channel code. For
lines no captured event produced (`!AD`, `!UN`) it is the colour the chat window drew the line in, when that is not white.
Colours inside the text (links) are drawn over the base colour. Old readers ignore the sixth field.

## Geometry

32 columns of 4x4 px cells (width 128 px, as v1), `rows` rows (height `4 * rows` px); `rows` depends on L (fixed per
mode, so the matrix never changes size):

| L | bits / cell | rows | size (budget 255 bytes) |
|---|---|---|---|
| 2 | 3 | 23 | 128 x 92 |
| 4 | 6 | 12 | 128 x 48 |
| 8 | 9 | 9 | 128 x 36 |
| 16 | 12 | 7 | 128 x 28 |
| (v1: 256) | 24 | 4 | 128 x 16 |

`rows = ceil((12 + L + 4 + ceil(8 * (9 + budget) / (3 * log2 L))) / 32)`. Cells are numbered row-major from 0.
The read position of a cell is its centre (+2,+2).

## Cells

"Binary" cells use only 0 or 255 per channel (so one cell = 3 bits: R, G, B). Data cells use level values.

| Cells | Content |
|---|---|
| 0..7 | preamble, binary RGB: W(1,1,1) K(0,0,0) R(1,0,0) G(0,1,0) B(0,0,1) Y(1,1,0) K W |
| 8..11 | mode, 12 bits in 4 binary cells (3 bits each, first bit = R): `version(3) = 010`, `level code(2)` (0:L=2, 1:4, 2:8, 3:16), `rows-1 (6)`, `parity(1)` = XOR of the 11 bits before |
| 12 .. 12+L-1 | ramp: grey cells (v,v,v) for every level value, in ascending order |
| 12+L .. n-5 | data cells (n = rows * 32); each channel holds one symbol 0..L-1 |
| n-4 .. n-1 | end marker, binary: K W K W |

Level values: `value(i) = round(i * 180 / (L - 1))`, i = 0..L-1. The top level is 180 (not 255) to leave headroom for
brightening; black (0) is the bottom level. Preamble / mode / end cells use 0 and 255.

## Data stream

Bytes: `seq (3, big endian) | length (2) | lines (1) | checksum (3) | payload`. `checksum` and `payload` are exactly as in
v1 (same Fletcher-style checksum over the payload bytes, same line format incl. the optional class field). The byte
stream is written MSB first as a bit stream; every data cell takes `3 * log2(L)` bits: the first `log2(L)` bits are the
symbol of R, the next of G, the last of B. Unused bits / cells are zero (symbol 0).

## Reader

1. Take cell 0 (white) and cell 1 (black) of the preamble: their per-channel mean is the decision threshold for all
   binary cells; require white - black >= 40 in every channel. Check the preamble pattern (24 bits), read the mode cells.
2. Read the ramp. Per channel the measured ramp values must be strictly increasing (otherwise the screen merges levels:
   this mode is too weak for the setup -> report it, do not guess).
3. Classify every data cell channel against the midpoints of its channel's ramp. Assemble the bytes, verify the end
   marker and the checksum; accept only if both match.
4. Locating without knowing the colour changes: look for cell 0 brighter than cell 1 by >= 40 in all channels, then check
   the remaining preamble cells relative to the threshold of those two. A position up to 2 px off still decodes; refine it
   to the middle of the offsets that decode.

`proto2.py` (reader) is the reference implementation of encoder and decoder; `test_proto2.py` shows how it behaves under
colour damage.

## Colour palette

Only colours the game itself uses are in the table above; the reader draws a code with the colour listed there.
Sources: item quality - https://warcraft.wiki.gg/wiki/Item_Quality (8 WoW Token = `#00ccff`, the same as 7 heirloom, has no code of its own);
class colours - https://warcraft.wiki.gg/wiki/Class_colors (priest white and shaman `#0070dd` equal item qualities 1 and 3);
resource colours - https://warcraft.wiki.gg/wiki/Power_colors; chat colours (71-78) - the game's default chat settings, from memory and the in-game colour swatches, not from a published list; link and coin colours (10-15) are the game's own link colours.
The font colours of the interface (gold `#ffd100`, ...) are in the game's `GlobalColor` table; they are not copied here yet.

A line that no captured event produced (`!AD`, `!UN`) may contain `|cAARRGGBB...|r` colour spans written by an addon. The addon
replaces each span by the nearest palette code (weighted RGB distance, redmean formula; a colour farther than 60 from every palette
colour is dropped). The reader therefore never receives an arbitrary colour. `|cnNAME:` (named colours) are dropped.
