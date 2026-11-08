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

- channel: S say, Y yell, E emote, P party, R raid, RW raid warning, I instance, G guild, O officer, W whisper, B bnet whisper, C<n> numbered channel n, CM community channel
- "other" messages (the chat window's "Other" settings) use codes that start with `!`: `!SY` system, `!XP` experience, `!HN` honor,
  `!RP` reputation, `!SK` skill, `!LT` loot, `!CY` currency, `!MN` money, `!TS` trade skills, `!OP` opening, `!PI` pet info,
  `!CI` misc. combat info, `!AC` / `!GA` achievements, `!BH` / `!BA` / `!BN` battleground, `!IG` ignored, `!TI` target icons,
  `!MS` `!MY` `!ME` `!MW` `!MP` NPC say / yell / emote / whisper / party, `!BE` `!BW` raid boss emote / whisper.
  Except for the NPC / boss speech the sender field is empty (the text already contains the names). A reader that does
  not know a `!` code can show the line like any other; the codes never start with `C`, so they cannot be mistaken for channels.
- id: message counter 1..65535 (wraps). Use it to detect which lines are new.
- text `[restricted]` with sender `?` means the client did not let the addon read that message.

Each redraw shows the newest lines that fit into the byte budget, so the same lines appear in several consecutive frames.
A reader should accept a frame only if the marker, end marker and checksum are valid, and translate only ids it has not seen before.

## Item links in the text field

Item links are reduced to their name; the quality (rarity) is kept as a marker around the name:

    \x02 <digit 0-8> [Item Name] \x03

0 poor, 1 common, 2 uncommon, 3 rare, 4 epic, 5 legendary, 6 artifact, 7 heirloom, 8 token,
9 = a quest link (the name is `[[level] Quest Name]`; an id appended by another addon is removed).
Achievement links also use 9; spell links use 8 (light blue like the heirloom colour). The addon puts the link names in the
language of the player's own client when the client knows the id (option "Show linked items ..."). A reader that does not
know the marker can simply delete the bytes 0x02 and 0x03 (and the digit after 0x02). A message cut by the byte
limit may lack the closing 0x03. This does not change the pixel format or the protocol version.


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
