"""One authenticated file tile's Jupyter kernel, using newline-delimited JSON on stdio."""
import json
import sys
import threading
import time
from queue import Empty

output_lock = threading.Lock()


def emit(message):
    with output_lock:
        print(json.dumps(message, ensure_ascii=True, default=str), flush=True)


try:
    from jupyter_client import KernelManager
    from jupyter_client.kernelspec import KernelSpecManager
except ImportError:
    emit({"type": "fatal", "error": "Jupyter is missing from this Python environment. Install jupyter_client and ipykernel, or set WAYSTATION_PYTHON to an environment that has them."})
    sys.exit(1)

if len(sys.argv) > 1 and sys.argv[1] == "--list":
    specs = KernelSpecManager().get_all_specs()
    emit({"kernels": [{"name": name, "label": value["spec"].get("display_name", name), "language": value["spec"].get("language", "")} for name, value in specs.items()]})
    sys.exit(0)

manager = KernelManager(kernel_name=sys.argv[2] if len(sys.argv) > 2 else "python3")
client = None
busy = threading.Lock()


def execute(command):
    if not busy.acquire(blocking=False):
        emit({"type": "error", "job": command["job"], "error": "A cell is already running."})
        return
    job = command["job"]
    try:
        msg_id = client.execute(command["code"], allow_stdin=False, stop_on_error=True)
        deadline = time.monotonic() + 120
        sent_bytes = 0
        truncated = False
        while time.monotonic() < deadline:
            try:
                message = client.get_iopub_msg(timeout=0.5)
            except Empty:
                if not manager.is_alive():
                    raise RuntimeError("The kernel exited. Restart the kernel to run another cell.")
                continue
            if message.get("parent_header", {}).get("msg_id") != msg_id:
                continue
            kind, content = message["header"]["msg_type"], message["content"]
            if kind == "status" and content.get("execution_state") == "idle":
                emit({"type": "done", "job": job})
                return
            if kind == "execute_input":
                emit({"type": "count", "job": job, "count": content.get("execution_count")})
            elif kind in ("stream", "display_data", "execute_result", "error", "clear_output", "update_display_data"):
                encoded = json.dumps(content, default=str)
                sent_bytes += len(encoded)
                if sent_bytes <= 5_000_000:
                    emit({"type": "output", "job": job, "output": {"output_type": kind, **content}})
                elif not truncated:
                    emit({"type": "output", "job": job, "output": {"output_type": "stream", "name": "stderr", "text": "\nOutput limit reached; further output is omitted.\n"}})
                    truncated = True
        manager.interrupt_kernel()
        emit({"type": "error", "job": job, "error": "Cell execution exceeded two minutes and was interrupted. The kernel remains available."})
    except Exception as error:
        emit({"type": "error", "job": job, "error": str(error)})
    finally:
        busy.release()


try:
    manager.start_kernel(cwd=sys.argv[1])
    client = manager.blocking_client()
    client.start_channels()
    client.wait_for_ready(timeout=25)
    # Match notebook plot behavior without executing any notebook cell automatically.
    init_id = client.execute("%matplotlib inline", silent=True, store_history=False, allow_stdin=False) if manager.kernel_name.startswith("python") else None
    if init_id:
        while True:
            message = client.get_iopub_msg(timeout=10)
            if message.get("parent_header", {}).get("msg_id") == init_id and message["header"]["msg_type"] == "status" and message["content"].get("execution_state") == "idle":
                break
    emit({"type": "ready", "kernel": manager.kernel_name})
    for line in sys.stdin:
        command = json.loads(line)
        if command.get("op") == "execute":
            threading.Thread(target=execute, args=(command,), daemon=True).start()
        elif command.get("op") == "interrupt":
            manager.interrupt_kernel()
        elif command.get("op") == "shutdown":
            break
except Exception as error:
    emit({"type": "fatal", "error": str(error)})
finally:
    if client:
        client.stop_channels()
    if manager.has_kernel:
        manager.shutdown_kernel(now=True)
