"""STT system of ChatMatrixReader (layer 2 of: reader -> STT system -> recognition engine).

It listens to the sound of ONE program (Discord, WoW ...), cuts it into sentences, hands each sentence to an engine
(sttcore/engines: Whisper, later others) and reports the text as JSON lines on stdout (see protocol.py).
It runs as a separate process of its own: the reader starts and stops it, and nothing here touches the game.
"""
VERSION = "0.1.0"
