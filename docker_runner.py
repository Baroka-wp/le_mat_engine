"""
Le Mat — Docker Runner
Provides Docker-based isolation for user code execution.
Falls back to direct subprocess if Docker is not available.
"""
import asyncio
import os
import shutil
import uuid
from pathlib import Path
from typing import Optional

# ── Configuration ─────────────────────────────────────────────────────────────

RUNNER_IMAGE = os.environ.get("LEMAT_RUNNER_IMAGE", "lemat-runner:latest")
RUNNER_CPU = os.environ.get("LEMAT_RUNNER_CPU", "0.5")
RUNNER_MEMORY = os.environ.get("LEMAT_RUNNER_MEMORY", "256m")
DOCKER_ISOLATION = os.environ.get("LEMAT_DOCKER_ISOLATION", "auto")  # "true", "false", "auto"

_docker_available: Optional[bool] = None
_image_ready: bool = False


# ── Docker availability ──────────────────────────────────────────────────────

async def is_docker_available() -> bool:
    """Check if Docker daemon is running. Cached after first call."""
    global _docker_available
    if _docker_available is not None:
        return _docker_available

    if DOCKER_ISOLATION == "false":
        _docker_available = False
        return False

    if not shutil.which("docker"):
        _docker_available = False
        return False

    try:
        proc = await asyncio.create_subprocess_exec(
            "docker", "info",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc.wait(), timeout=5.0)
        _docker_available = proc.returncode == 0
    except Exception:
        _docker_available = False

    return _docker_available


async def ensure_runner_image() -> bool:
    """Build the runner image if not present. Returns True if image is ready."""
    global _image_ready
    if _image_ready:
        return True

    if not await is_docker_available():
        return False

    # Check if image exists
    proc = await asyncio.create_subprocess_exec(
        "docker", "image", "inspect", RUNNER_IMAGE,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    await proc.wait()
    if proc.returncode == 0:
        _image_ready = True
        return True

    # Build the image from Dockerfile.runner
    app_dir = Path(__file__).resolve().parent
    dockerfile = app_dir / "Dockerfile.runner"
    if not dockerfile.exists():
        return False

    print(f"[docker] Building runner image {RUNNER_IMAGE}...")
    proc = await asyncio.create_subprocess_exec(
        "docker", "build",
        "-f", str(dockerfile),
        "-t", RUNNER_IMAGE,
        str(app_dir),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=300)
    if proc.returncode == 0:
        _image_ready = True
        print(f"[docker] Runner image built successfully")
        return True
    else:
        err = stderr.decode("utf-8", errors="replace")[:500]
        print(f"[docker] Failed to build runner image: {err}")
        return False


# ── Container command builder ────────────────────────────────────────────────

def build_docker_cmd(
    command: list,
    project_dir: str,
    container_name: Optional[str] = None,
    cpu_limit: str = RUNNER_CPU,
    memory_limit: str = RUNNER_MEMORY,
    interactive: bool = False,
    env_vars: Optional[dict] = None,
) -> list:
    """Build a `docker run` command with proper isolation."""
    if not container_name:
        container_name = f"lemat-run-{uuid.uuid4().hex[:8]}"

    cmd = [
        "docker", "run", "--rm",
        "--name", container_name,
        "--cpus", cpu_limit,
        "--memory", memory_limit,
        "--pids-limit", "256",
        # Allow container to reach the host (Le Mat server) for SDK HTTP calls
        "--add-host", "host.docker.internal:host-gateway",
        # Mount project directory
        "-v", f"{project_dir}:/project:rw",
        # Working directory
        "-w", "/project",
        # Environment variables
        "-e", "LEMAT_HOST=host.docker.internal",
        "-e", f"LEMAT_PORT={os.environ.get('LEMAT_PORT', '8000')}",
        "-e", "LEMAT_SDK_DIR=/lemat-sdk",
    ]

    if interactive:
        cmd.append("-i")

    if env_vars:
        for k, v in env_vars.items():
            cmd.extend(["-e", f"{k}={v}"])

    cmd.append(RUNNER_IMAGE)
    cmd.extend(command)

    return cmd, container_name


# ── Execution helpers ────────────────────────────────────────────────────────

async def run_command(
    command: list,
    project_dir: str,
    stdin_data: Optional[bytes] = None,
    timeout: float = 60.0,
    cpu_limit: str = RUNNER_CPU,
    memory_limit: str = RUNNER_MEMORY,
    env_vars: Optional[dict] = None,
) -> tuple:
    """
    Run a command in a Docker container (or fallback to subprocess).
    Returns (stdout_bytes, stderr_bytes, returncode, container_name).
    """
    use_docker = await is_docker_available() and _image_ready

    if use_docker:
        docker_cmd, container_name = build_docker_cmd(
            command=command,
            project_dir=project_dir,
            cpu_limit=cpu_limit,
            memory_limit=memory_limit,
            interactive=stdin_data is not None,
            env_vars=env_vars,
        )
        proc = await asyncio.create_subprocess_exec(
            *docker_cmd,
            stdin=asyncio.subprocess.PIPE if stdin_data else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(input=stdin_data),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            # Kill the container
            await _kill_container(container_name)
            raise
        return stdout, stderr, proc.returncode, container_name
    else:
        # Fallback: direct subprocess
        proc = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.PIPE if stdin_data else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=project_dir,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(input=stdin_data),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            proc.kill()
            raise
        return stdout, stderr, proc.returncode, None


async def start_streaming(
    command: list,
    project_dir: str,
    env_vars: Optional[dict] = None,
) -> tuple:
    """
    Start a long-running process for SSE streaming.
    Returns (process, container_name_or_none).
    """
    use_docker = await is_docker_available() and _image_ready

    if use_docker:
        docker_cmd, container_name = build_docker_cmd(
            command=command,
            project_dir=project_dir,
            env_vars=env_vars,
        )
        proc = await asyncio.create_subprocess_exec(
            *docker_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        return proc, container_name
    else:
        proc = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=project_dir,
        )
        return proc, None


async def kill_process(proc, container_name: Optional[str] = None):
    """Kill a running process and its container if applicable."""
    try:
        proc.kill()
    except Exception:
        pass
    if container_name:
        await _kill_container(container_name)


async def _kill_container(name: str):
    """Force-kill a Docker container by name."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "docker", "kill", name,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc.wait(), timeout=5.0)
    except Exception:
        pass
