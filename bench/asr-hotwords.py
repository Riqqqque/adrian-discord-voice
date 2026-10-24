"""Writes <bench>/hotwords.txt: phrases as Parakeet tokens (one per line), for sherpa's
transducer biasing. Only words production could know ahead of time (names, the PC's
apps and games, mod sites): no artists or streamers, so the pc set isn't rigged.
   venv/bin/python -I bench/asr-hotwords.py <bench dir>"""
import os, sys
from tokenizers import Tokenizer

BENCH = sys.argv[1]
WORDS = ["Adrian", "Rique", "Spotify", "Discord", "Valorant", "Steam", "Chrome", "YouTube", "Netflix", "Modrinth",
         "CurseForge", "Minecraft", "Fabric", "Forge", "Sodium", "JEI", "OBS", "FL Studio", "Auto-Tune", "Twitch",
         "Fortnite", "Xbox", "Reddit", "CPU", "GPU", "RAM", "Notepad", "Explorer", "Plex"]
tk = Tokenizer.from_file(os.path.join(BENCH, "models", "bark", "tokenizer.json"))
with open(os.path.join(BENCH, "hotwords.txt"), "w") as f:
    for w in WORDS:
        f.write(" ".join(tk.encode(w, add_special_tokens=False).tokens) + "\n")
print(len(WORDS), "hotwords")
