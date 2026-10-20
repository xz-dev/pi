import os
import signal
import time

# Finite detached double-fork; only native owner may reap this daemon.
if os.fork():
    os._exit(0)
os.setsid()
if os.fork():
    os._exit(0)
signal.signal(signal.SIGTERM, signal.SIG_IGN)
signal.alarm(9)
os.write(1, f"{os.getpid()}\n".encode())
os.close(1)
os.close(2)
time.sleep(10)
