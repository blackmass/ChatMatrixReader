"""Puts the pieces of a long chat message together again (see PROTOCOL.md, "long messages").

The addon cuts a message of more than 255 bytes into consecutive lines of the same channel and speaker, with consecutive ids:
    \\5 at the end of a piece     the message goes on in the next line
    \\5 at the start of a piece   this line continues the one before
    \\6<code> at the start         the same, and the piece starts inside the link marker with this code
                                  (the piece before closed that marker with \\3 right before its \\5)
Joiner.feed() takes the lines in the order they were read and gives back the lines to show; a message that is still being
collected is held back. It is closed with an ellipsis as soon as the next line is not its continuation, or when nothing
follows within TIMEOUT seconds (flush_due()). A continuation without its start (the first pieces were lost) is shown
with a leading ellipsis.
"""
import dataclasses
import logging

log = logging.getLogger("cmr.join")

CONT, CONT_IN = "\x05", "\x06"
ELLIPSIS = "…"
TIMEOUT = 1.0                      # seconds to wait for the next piece


def _closed(body):
    """The text, with a link marker that is still open closed."""
    return body + "\x03" if body.count("\x02") > body.count("\x03") else body


class Joiner:
    def __init__(self, timeout=TIMEOUT):
        self.timeout = timeout
        self.line = None           # the message being collected (a Line whose text is what was read so far)
        self.pieces = 0            # how many pieces it has so far
        self.last_id = 0
        self.deadline = 0.0

    # -------------------------------------------------------------- helpers
    def _finish(self, why=None):
        """why: None = the message is complete; else the reason it was closed with an ellipsis (for the log)."""
        line, self.line = self.line, None
        if why:
            log.warning("긴 메시지 %d조각에서 끊김 (%s): %s %s, %d자", self.pieces, why, line.channel, line.sender, len(line.text))
        else:
            log.info("긴 메시지 %d조각 합침: %s %s, %d자", self.pieces, line.channel, line.sender, len(line.text))
        if why:
            line = dataclasses.replace(line, text=_closed(line.text) + ELLIPSIS)
        return line

    def pending(self):
        return self.line is not None

    # -------------------------------------------------------------- API
    def feed(self, line, now):
        text = line.text
        lead = None                                   # None, "" (plain continuation) or the link code
        if text.startswith(CONT_IN) and len(text) >= 2:
            lead, text = text[1], text[2:]
        elif text.startswith(CONT):
            lead, text = "", text[1:]
        goes_on = text.endswith(CONT)
        if goes_on:
            text = text[:-1]
        out = []
        if self.line is not None:
            nxt = self.last_id % 65535 + 1
            if lead is not None and line.channel == self.line.channel and line.sender == self.line.sender and line.id == nxt:
                body = self.line.text
                if lead and body.endswith("\x03"):    # the piece before closed the marker: it goes on, so take the close back
                    body = body[:-1]
                self.line = dataclasses.replace(self.line, text=body + text)
                self.last_id = line.id
                self.pieces += 1
                if goes_on:
                    self.deadline = now + self.timeout
                    return out
                return [self._finish()]
            why = "다음 줄이 이어짐이 아님" if (lead is None) else "다음 조각이 아님 (채널/화자/번호 불일치, 조각 유실)"
            out.append(self._finish(why))             # not the continuation: the message ended here
        if lead is not None:                          # a continuation whose start was lost
            log.warning("이어지는 조각인데 앞 조각이 없음 (유실): %s %s", line.channel, line.sender)
            text = ELLIPSIS + ("\x02" + lead if lead else "") + text
        line = dataclasses.replace(line, text=text)
        if goes_on:
            self.line, self.last_id, self.deadline, self.pieces = line, line.id, now + self.timeout, 1
            return out
        out.append(line)
        return out

    def flush_due(self, now, force=False):
        """Nothing came after the last piece for a while (or the reader stops): close the message."""
        if self.line is not None and (force or now >= self.deadline):
            return [self._finish("1초 안에 다음 조각이 오지 않음" if not force else "종료")]
        return []
