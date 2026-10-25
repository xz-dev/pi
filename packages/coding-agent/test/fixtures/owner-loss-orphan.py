"""Raw direct child or orphaned setsid grandchild for real ownership regressions."""
import os
import pathlib
import sys
import time

root = pathlib.Path(sys.argv[1])
mode = sys.argv[2]
if mode == "orphan":
    if os.fork():
        os._exit(0)
    os.setsid()
    (root / "adopted-pid").write_text(str(os.getpid()))
for tick in range(6000):
    (root / ("direct-tick" if mode == "direct" else "adopted-tick")).write_text(str(tick))
    time.sleep(.01)
