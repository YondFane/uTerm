import json
import sys
from pathlib import Path


def emit(text):
    sys.stdout.buffer.write(text.encode("utf-8"))
    sys.stdout.buffer.flush()


def raw_terminal():
    if not sys.stdin.isatty():
        return
    if sys.platform == "win32":
        import ctypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetStdHandle.argtypes = [ctypes.c_uint32]
        kernel.GetStdHandle.restype = ctypes.c_void_p
        kernel.GetConsoleMode.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
        kernel.SetConsoleMode.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        for number, clear, enable in [(-10, 7, 0x200), (-11, 0, 5)]:
            handle = kernel.GetStdHandle(ctypes.c_uint32(number).value)
            mode = ctypes.c_uint32()
            if not kernel.GetConsoleMode(handle, ctypes.byref(mode)):
                raise ctypes.WinError(ctypes.get_last_error())
            if not kernel.SetConsoleMode(handle, (mode.value & ~clear) | enable):
                raise ctypes.WinError(ctypes.get_last_error())
    else:
        import tty

        tty.setraw(sys.stdin.fileno())


def commands():
    line = bytearray()
    while True:
        byte = sys.stdin.buffer.read(1)
        if not byte:
            return
        if byte in (b"\r", b"\n"):
            if line:
                yield bytes(line)
                line.clear()
        else:
            line.extend(byte)


# Model CLI behavior without contacting a provider or reading credentials.
# 模拟 CLI 行为，不访问服务商或读取凭据。
raw_terminal()
Path("mock-arguments.json").write_text(
    json.dumps(sys.argv[1:], ensure_ascii=False), encoding="utf-8"
)
emit("\x1b[?1049h\x1b[?2004h\x1b[?1000hMOCK_AGENT_READY 中文\r\n> ")
turn = 0
for raw in commands():
    value = (
        raw.decode("utf-8")
        .rstrip("\r\n")
        .replace("\x1b[200~", "")
        .replace("\x1b[201~", "")
    )
    if value == "/error":
        emit("MOCK_AGENT_RETRYABLE_ERROR\r\n> ")
    elif value == "/cancel":
        Path("mock-cancelled.txt").write_text("cancelled", encoding="utf-8")
        emit("MOCK_AGENT_CANCELLED\r\n> ")
    elif value == "/quit":
        emit("\x1b[?1000l\x1b[?2004l\x1b[?1049lMOCK_AGENT_EXIT\r\n")
        sys.exit(7)
    else:
        turn += 1
        Path(f"mock-turn-{turn}.txt").write_bytes(value.encode("utf-8"))
        emit(f"\x1b[32mMOCK_AGENT_TURN_{turn}:{value}\x1b[0m\r\n> ")
