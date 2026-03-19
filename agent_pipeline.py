"""
Le Mat — Agent Pipeline Orchestrator
Implements a neuro-symbolic pipeline:
  UNDERSTAND → CLARIFY (optional) → PLAN → EXECUTE → VERIFY

The pipeline decides task complexity and routes accordingly:
- Simple tasks: skip to EXECUTE (direct LLM tool-calling)
- Complex tasks: full pipeline with structured plan
- Deterministic tasks: algorithmic generation (no LLM)

State is persisted to _agent_pipeline_state.json for suspend/resume
at the CLARIFY phase.
"""

import json
import re
import time
from pathlib import Path
from typing import AsyncGenerator, Optional

import agent_memory as mem
import agent_algorithmic as algo
from agent import (
    PROVIDERS,
    TOOLS_ANTHROPIC,
    TOOLS_OPENAI,
    build_file_tree,
    build_system_prompt,
    check_rate_limit,
    execute_tool,
    load_skill,
    _active_requests,
    _last_request,
)

import httpx

# ── Constants ────────────────────────────────────────────────────────────────

PIPELINE_STATE_FILE = "_agent_pipeline_state.json"

PHASES = ["understand", "clarify", "plan", "execute", "verify"]

# Complexity thresholds (estimated from task description)
SIMPLE_KEYWORDS = {
    "fix", "typo", "rename", "change", "update", "add", "remove", "delete",
    "color", "style", "text", "title", "label", "button", "margin", "padding",
}
COMPLEX_KEYWORDS = {
    "create", "build", "implement", "design", "refactor", "migrate",
    "full", "complete", "entire", "system", "feature", "multi",
    "database", "schema", "api", "crud", "auth", "dashboard",
}
DETERMINISTIC_PATTERNS = [
    (r"(?:create|generate|scaffold)\s+(?:a\s+)?(?:html\s+)?page", "scaffold_page"),
    (r"(?:create|generate)\s+(?:a\s+)?(?:crud|api)\s+(?:for|from|routes?)", "scaffold_crud_api"),
    (r"(?:create|generate)\s+(?:a\s+)?schema", "scaffold_schema"),
    (r"(?:create|generate)\s+(?:a\s+)?(?:css|stylesheet|styles?)", "scaffold_css"),
]

# Token budget tiers
MODEL_TIERS = {
    "fast": {"claude": "claude-haiku-4-20250514", "openai": "gpt-4o-mini", "xai": "grok-3-mini"},
    "balanced": {"claude": "claude-sonnet-4-20250514", "openai": "gpt-4o", "xai": "grok-3"},
    "powerful": {"claude": "claude-sonnet-4-20250514", "openai": "gpt-4o", "xai": "grok-3"},
}


# ── Pipeline State ───────────────────────────────────────────────────────────

def _state_path(project_dir: Path) -> Path:
    return project_dir / PIPELINE_STATE_FILE


def load_pipeline_state(project_dir: Path) -> Optional[dict]:
    p = _state_path(project_dir)
    if p.exists():
        try:
            return json.loads(p.read_text("utf-8"))
        except Exception:
            pass
    return None


def save_pipeline_state(project_dir: Path, state: dict):
    state["updated_at"] = time.time()
    _state_path(project_dir).write_text(
        json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def clear_pipeline_state(project_dir: Path):
    p = _state_path(project_dir)
    if p.exists():
        p.unlink()


# ── Task Classification ─────────────────────────────────────────────────────

def classify_task(message: str, memory: dict) -> dict:
    """
    Classify a task by complexity and type. Returns:
    {
        "complexity": "simple" | "medium" | "complex",
        "deterministic": bool,
        "deterministic_type": str | None,
        "model_tier": "fast" | "balanced" | "powerful",
        "needs_clarification": bool,
        "relevant_files": [str],
    }
    """
    msg_lower = message.lower()
    words = set(re.findall(r"\w+", msg_lower))

    # Check for deterministic patterns first
    for pattern, task_type in DETERMINISTIC_PATTERNS:
        if re.search(pattern, msg_lower):
            return {
                "complexity": "simple",
                "deterministic": True,
                "deterministic_type": task_type,
                "model_tier": "fast",
                "needs_clarification": False,
                "relevant_files": [],
            }

    # Score complexity
    simple_score = len(words & SIMPLE_KEYWORDS)
    complex_score = len(words & COMPLEX_KEYWORDS)

    # Heuristics
    has_multiple_files = bool(re.search(r"\b(?:files?|pages?|routes?|models?)\b.*\b(?:and|et|,)\b", msg_lower))
    is_vague = len(message.split()) < 8 and complex_score > 0
    mentions_many = any(w in msg_lower for w in ("all", "every", "each", "tous", "chaque"))

    if complex_score >= 2 or has_multiple_files or mentions_many:
        complexity = "complex"
    elif complex_score >= 1 and simple_score < 2:
        complexity = "medium"
    else:
        complexity = "simple"

    # Determine model tier
    if complexity == "simple":
        tier = "fast"
    elif complexity == "medium":
        tier = "balanced"
    else:
        tier = "powerful"

    # Check if clarification needed
    needs_clarification = is_vague and complexity != "simple"

    # Find relevant files from memory
    relevant = mem.get_relevant_files(memory, message)

    return {
        "complexity": complexity,
        "deterministic": False,
        "deterministic_type": None,
        "model_tier": tier,
        "needs_clarification": needs_clarification,
        "relevant_files": relevant,
    }


# ── SSE event helpers ────────────────────────────────────────────────────────

def _sse(event_type: str, data: dict) -> str:
    payload = {"type": event_type}
    payload.update(data)
    return "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"


# ── Phase: UNDERSTAND ────────────────────────────────────────────────────────

async def _phase_understand(
    message: str,
    project_dir: Path,
    memory: dict,
) -> AsyncGenerator[str, None]:
    """Classify the task and decide pipeline path."""
    yield _sse("phase", {"phase": "understand", "status": "start"})

    classification = classify_task(message, memory)

    yield _sse("phase", {
        "phase": "understand",
        "status": "done",
        "classification": classification,
    })

    # Yield classification for the caller to use
    yield _sse("_classification", classification)


# ── Phase: CLARIFY ───────────────────────────────────────────────────────────

def build_clarification_request(message: str, classification: dict, memory: dict) -> dict:
    """
    Build a clarification request with choices for the user.
    Returns a dict that will be sent as SSE and saved in pipeline state.
    """
    questions = []

    msg_lower = message.lower()

    # Detect ambiguities based on classification
    if classification["complexity"] in ("medium", "complex"):
        # If creating something but no specific file/format mentioned
        if any(w in msg_lower for w in ("create", "build", "creer", "construire")):
            if not any(ext in msg_lower for ext in (".html", ".py", ".js", ".css")):
                questions.append({
                    "id": "structure",
                    "text": "Quelle structure souhaitez-vous ?",
                    "choices": [
                        "Page HTML + CSS + JS",
                        "API backend (Python)",
                        "Full stack (page + API + schema)",
                        "Autre (précisez)",
                    ],
                    "allow_free_text": True,
                })

        # If schema/DB mentioned but no model names
        if any(w in msg_lower for w in ("database", "schema", "base de donnees", "modele", "model")):
            schemas = memory.get("schemas", {})
            if not schemas:
                questions.append({
                    "id": "models",
                    "text": "Quels modèles de données avez-vous en tête ?",
                    "choices": [],
                    "allow_free_text": True,
                    "placeholder": "Ex: User (name, email), Article (title, content, authorId)",
                })

        # Style/design ambiguity
        if any(w in msg_lower for w in ("design", "style", "theme", "ui")):
            questions.append({
                "id": "style",
                "text": "Quel style préférez-vous ?",
                "choices": [
                    "Moderne & minimaliste",
                    "Coloré & dynamique",
                    "Professionnel & corporate",
                    "Sombre (dark mode)",
                ],
                "allow_free_text": True,
            })

    return {
        "questions": questions,
        "original_message": message,
        "classification": classification,
    }


# ── Phase: PLAN ──────────────────────────────────────────────────────────────

async def _build_plan_with_llm(
    message: str,
    config: dict,
    memory: dict,
    project_name: str,
    clarification_answers: dict = None,
) -> AsyncGenerator[str, None]:
    """
    Use LLM to build a structured execution plan.
    Yields SSE events and the final plan as _plan event.
    """
    yield _sse("phase", {"phase": "plan", "status": "start"})

    # Build a compact context from memory
    memory_context = mem.memory_to_context(memory)

    # Build planning prompt
    clarification_text = ""
    if clarification_answers:
        parts = []
        for qid, answer in clarification_answers.items():
            parts.append(qid + ": " + str(answer))
        clarification_text = "\n\nUser clarifications:\n" + "\n".join(parts)

    planning_prompt = """You are a planning assistant. Given the user's request and project context,
create a structured execution plan as JSON.

## Project Context
{memory_context}

## User Request
{message}{clarification_text}

## Instructions
Return ONLY a JSON object with this structure:
{{
  "summary": "Brief description of what will be done",
  "steps": [
    {{
      "id": 1,
      "action": "create_file" | "edit_file" | "read_file" | "delete_file",
      "path": "relative/path",
      "description": "What this step does",
      "depends_on": [],
      "needs_llm": true | false
    }}
  ],
  "files_to_read_first": ["paths to read before executing"]
}}

Keep the plan minimal and efficient. Only include necessary steps.
""".format(
        memory_context=memory_context,
        message=message,
        clarification_text=clarification_text,
    )

    provider = config.get("provider", "claude")
    api_key = config["api_key"]
    # Use fast model for planning
    tier = "fast"
    model = MODEL_TIERS.get(tier, {}).get(provider, config.get("model"))

    plan_text = ""

    if PROVIDERS[provider]["format"] == "anthropic":
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }
        payload = {
            "model": model,
            "max_tokens": 2048,
            "system": "You are a concise planning assistant. Return only valid JSON.",
            "messages": [{"role": "user", "content": planning_prompt}],
        }

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                PROVIDERS["claude"]["base_url"],
                headers=headers,
                json=payload,
            )
            if resp.status_code == 200:
                data = resp.json()
                for block in data.get("content", []):
                    if block.get("type") == "text":
                        plan_text += block["text"]
    else:
        headers = {
            "Authorization": "Bearer " + api_key,
            "Content-Type": "application/json",
        }
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": "You are a concise planning assistant. Return only valid JSON."},
                {"role": "user", "content": planning_prompt},
            ],
            "max_tokens": 2048,
        }
        prov = PROVIDERS[provider]

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                prov["base_url"],
                headers=headers,
                json=payload,
            )
            if resp.status_code == 200:
                data = resp.json()
                choices = data.get("choices", [])
                if choices:
                    plan_text = choices[0].get("message", {}).get("content", "")

    # Parse plan JSON
    plan = None
    if plan_text:
        # Extract JSON from potential markdown code block
        json_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", plan_text, re.DOTALL)
        if json_match:
            plan_text = json_match.group(1)
        try:
            plan = json.loads(plan_text)
        except json.JSONDecodeError:
            # Try to find JSON in the text
            start = plan_text.find("{")
            end = plan_text.rfind("}") + 1
            if start >= 0 and end > start:
                try:
                    plan = json.loads(plan_text[start:end])
                except json.JSONDecodeError:
                    pass

    if not plan:
        plan = {
            "summary": "Execute user request directly",
            "steps": [{"id": 1, "action": "llm_execute", "description": "Handle with LLM", "needs_llm": True}],
            "files_to_read_first": [],
        }

    yield _sse("plan", {"plan": plan})
    yield _sse("phase", {"phase": "plan", "status": "done"})
    yield _sse("_plan", plan)


# ── Phase: EXECUTE ───────────────────────────────────────────────────────────

async def _phase_execute_deterministic(
    task_type: str,
    message: str,
    project_dir: Path,
    memory: dict,
    config: dict,
) -> AsyncGenerator[str, None]:
    """Execute a deterministic task without LLM."""
    yield _sse("phase", {"phase": "execute", "status": "start", "mode": "algorithmic"})

    # Extract parameters from message for the algorithmic generator
    params = _extract_algo_params(task_type, message, memory)
    actions = algo.generate(task_type, params)

    for action in actions:
        tool_name = action["action"]
        tool_args = {k: v for k, v in action.items() if k != "action"}

        yield _sse("step_start", {"action": tool_name, "path": tool_args.get("path", "")})

        result = await execute_tool(tool_name, tool_args, project_dir)

        yield _sse("tool_result", {"name": tool_name, "result": result})
        yield _sse("step_done", {"action": tool_name, "success": result.get("success", False)})

        # Update memory
        if result.get("success"):
            mem.update_memory_after_action(
                project_dir, memory, tool_name,
                tool_args.get("path", ""),
                tool_args.get("content"),
            )

    yield _sse("phase", {"phase": "execute", "status": "done"})


def _extract_algo_params(task_type: str, message: str, memory: dict) -> dict:
    """Extract parameters from user message for algorithmic generation."""
    msg_lower = message.lower()

    if task_type == "scaffold_page":
        # Try to extract page name from message
        name_match = re.search(r"(?:page|fichier)\s+['\"]?(\w[\w-]*)", msg_lower)
        name = name_match.group(1) if name_match else "index"
        title_match = re.search(r"(?:titre|title|called?|nommee?)\s+['\"]?([^'\"]+)", msg_lower)
        title = title_match.group(1).strip() if title_match else name.replace("-", " ").title()
        has_db = bool(memory.get("schemas"))
        return {"name": name, "title": title, "has_db": has_db, "css_file": "style.css"}

    elif task_type == "scaffold_crud_api":
        # Find which model to generate CRUD for
        schemas = memory.get("schemas", {})
        models = []
        for schema_info in schemas.values():
            models.extend(schema_info.get("models", []))

        # Try to match a model name from message
        target_model = None
        for m in models:
            if m.lower() in msg_lower:
                target_model = m
                break
        if not target_model and models:
            target_model = models[0]

        # Parse schema to get fields
        fields = []
        if target_model:
            for f in memory.get("file_tree", []):
                if f.endswith(".lemat"):
                    schema_path = Path(str(f))
                    # Read from project dir
                    # We'll get fields from file summaries
                    pass

        # Use basic fields if we can't parse
        if not fields:
            fields = [
                {"name": "id", "type": "integer", "is_pk": True, "auto": True},
                {"name": "name", "type": "text", "required": True},
            ]

        lang = "javascript" if "js" in msg_lower or "javascript" in msg_lower else "python"
        return {"model": target_model or "Item", "fields": fields, "language": lang}

    elif task_type == "scaffold_schema":
        return {"database": "app.db", "models": [], "filename": "schema.lemat"}

    elif task_type == "scaffold_css":
        theme = "dark" if any(w in msg_lower for w in ("dark", "sombre", "noir")) else "light"
        return {"theme": theme, "filename": "style.css"}

    return {}


# ── Phase: VERIFY ────────────────────────────────────────────────────────────

async def _phase_verify(
    project_dir: Path,
    memory: dict,
    plan: dict = None,
) -> AsyncGenerator[str, None]:
    """Quick verification that files were created/modified correctly."""
    yield _sse("phase", {"phase": "verify", "status": "start"})

    issues = []

    # Check all files in plan exist
    if plan and "steps" in plan:
        for step in plan["steps"]:
            path = step.get("path")
            if path and step.get("action") == "create_file":
                full = project_dir / path
                if not full.exists():
                    issues.append("File not created: " + path)

    # Check for common issues in HTML files
    for f in project_dir.rglob("*.html"):
        if f.name.startswith("_"):
            continue
        try:
            content = f.read_text("utf-8")
            if "<!DOCTYPE" not in content and "<html" in content:
                rel = str(f.relative_to(project_dir))
                issues.append(rel + ": missing DOCTYPE")
        except Exception:
            pass

    status = "pass" if not issues else "issues"
    yield _sse("verify", {"status": status, "issues": issues})
    yield _sse("phase", {"phase": "verify", "status": "done"})


# ── Main Pipeline Entry Point ────────────────────────────────────────────────

async def stream_pipeline(
    config: dict,
    messages: list,
    project_name: str,
    project_dir: Path,
    schema_info: str = "",
    clarification_response: dict = None,
) -> AsyncGenerator[str, None]:
    """
    Main entry point for the pipeline agent.
    Replaces direct stream_agent calls when pipeline mode is active.

    If clarification_response is provided, we resume from CLARIFY phase.
    """
    # Rate limit check
    error = check_rate_limit(project_name)
    if error:
        yield _sse("error", {"data": error})
        return

    _active_requests.add(project_name)
    _last_request[project_name] = time.time()

    try:
        # Load or build memory
        memory = mem.load_memory(project_dir)
        if not memory.get("file_tree") or mem.is_memory_stale(project_dir, memory):
            yield _sse("memory_update", {"status": "rebuilding"})
            memory = mem.build_memory_from_scratch(project_dir)
            mem.save_memory(project_dir, memory)
            yield _sse("memory_update", {"status": "ready"})

        # Get the user's current message
        current_message = ""
        for m in reversed(messages):
            if m.get("role") == "user":
                current_message = m.get("content", "")
                break

        # ── Resume from clarification ──
        if clarification_response:
            state = load_pipeline_state(project_dir)
            if state and state.get("phase") == "clarify":
                # Merge answers and continue to PLAN
                state["clarification_answers"] = clarification_response
                current_message = state.get("original_message", current_message)

                async for evt in _build_plan_with_llm(
                    current_message, config, memory, project_name,
                    clarification_answers=clarification_response,
                ):
                    yield evt

                # After plan, execute with standard agent
                clear_pipeline_state(project_dir)
                async for evt in _execute_with_agent(
                    config, messages, project_name, project_dir,
                    schema_info, memory,
                ):
                    yield evt
                return

        # ── Phase 1: UNDERSTAND ──
        classification = None
        async for evt in _phase_understand(current_message, project_dir, memory):
            if '"_classification"' in evt:
                try:
                    data = json.loads(evt.split("data: ", 1)[1].strip())
                    classification = {k: v for k, v in data.items() if k != "type"}
                except Exception:
                    pass
            else:
                yield evt

        if not classification:
            classification = {
                "complexity": "medium",
                "deterministic": False,
                "model_tier": "balanced",
                "needs_clarification": False,
                "relevant_files": [],
            }

        # ── Deterministic path ──
        if classification.get("deterministic"):
            task_type = classification["deterministic_type"]
            async for evt in _phase_execute_deterministic(
                task_type, current_message, project_dir, memory, config,
            ):
                yield evt

            # Quick summary via fast LLM
            yield _sse("text", {"data": "\n\nFichiers générés automatiquement. "})

            # Verify
            async for evt in _phase_verify(project_dir, memory):
                yield evt

            # Save memory
            mem.save_memory(project_dir, memory)
            yield _sse("done", {})
            return

        # ── Phase 2: CLARIFY (optional) ──
        if classification.get("needs_clarification"):
            clarification = build_clarification_request(
                current_message, classification, memory,
            )
            if clarification.get("questions"):
                # Save state and suspend
                state = {
                    "phase": "clarify",
                    "original_message": current_message,
                    "classification": classification,
                    "clarification": clarification,
                }
                save_pipeline_state(project_dir, state)

                yield _sse("clarify", {
                    "questions": clarification["questions"],
                })
                # Don't yield 'done' — the frontend will show clarification UI
                # and resume via /agent/clarify endpoint
                return

        # ── Simple task: skip plan, go direct ──
        if classification["complexity"] == "simple":
            yield _sse("phase", {"phase": "execute", "status": "start", "mode": "direct"})

            async for evt in _execute_with_agent(
                config, messages, project_name, project_dir,
                schema_info, memory,
            ):
                yield evt
            return

        # ── Complex task: PLAN then EXECUTE ──
        plan = None
        async for evt in _build_plan_with_llm(
            current_message, config, memory, project_name,
        ):
            if '"_plan"' in evt:
                try:
                    data = json.loads(evt.split("data: ", 1)[1].strip())
                    plan = {k: v for k, v in data.items() if k != "type"}
                except Exception:
                    pass
            else:
                yield evt

        # Execute with the full agent (which has tool-calling loop)
        async for evt in _execute_with_agent(
            config, messages, project_name, project_dir,
            schema_info, memory, plan=plan,
        ):
            yield evt

    finally:
        _active_requests.discard(project_name)


async def _execute_with_agent(
    config: dict,
    messages: list,
    project_name: str,
    project_dir: Path,
    schema_info: str,
    memory: dict,
    plan: dict = None,
) -> AsyncGenerator[str, None]:
    """
    Execute using the LLM agent with tool-calling loop.
    Enhanced with memory context and optional plan.
    """
    from agent import _stream_anthropic, _stream_openai

    provider = config.get("provider", "claude")

    # Build system prompt with memory context instead of raw file reads
    memory_context = mem.memory_to_context(memory)
    skill_content = load_skill()
    file_tree = build_file_tree(project_dir)

    # Enrich system prompt with plan if available
    plan_section = ""
    if plan:
        plan_json = json.dumps(plan, ensure_ascii=False, indent=2)
        plan_section = "\n\n## Execution Plan\nFollow this plan step by step:\n```json\n" + plan_json + "\n```\n"

    system_prompt = build_system_prompt(
        project_name=project_name,
        file_tree=file_tree,
        schema_info=schema_info,
        skill_content=skill_content,
        project_description=config.get("project_description", ""),
        project_dir=project_dir,
    )

    # Append plan to system prompt
    if plan_section:
        system_prompt += plan_section

    # Select model based on complexity tier
    # (The config already has the user's chosen model, but we can suggest)

    # Remove rate limit check since pipeline already did it
    # Execute via the streaming functions directly
    if PROVIDERS[provider]["format"] == "anthropic":
        async for chunk in _stream_anthropic(config, system_prompt, messages, project_dir):
            yield chunk
            # Track tool results to update memory
            try:
                if chunk.startswith("data: "):
                    data = json.loads(chunk[6:].strip())
                    if data.get("type") == "tool_result":
                        result = data.get("result", {})
                        name = data.get("name", "")
                        if result.get("success") and name in ("create_file", "edit_file", "delete_file"):
                            path = result.get("path", "")
                            content = result.get("content") if name == "read_file" else None
                            mem.update_memory_after_action(project_dir, memory, name, path, content)
            except Exception:
                pass
    else:
        async for chunk in _stream_openai(config, system_prompt, messages, project_dir, provider):
            yield chunk
            try:
                if chunk.startswith("data: "):
                    data = json.loads(chunk[6:].strip())
                    if data.get("type") == "tool_result":
                        result = data.get("result", {})
                        name = data.get("name", "")
                        if result.get("success") and name in ("create_file", "edit_file", "delete_file"):
                            path = result.get("path", "")
                            mem.update_memory_after_action(project_dir, memory, name, path)
            except Exception:
                pass

    # Save updated memory
    mem.save_memory(project_dir, memory)

    # Verify phase for complex tasks
    if plan:
        async for evt in _phase_verify(project_dir, memory, plan):
            yield evt
