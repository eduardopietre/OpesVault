"""Helpers shared by the golden generators: one JSON form for every domain value."""

from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Any
from uuid import UUID

from pydantic import BaseModel


def j(value: Any) -> Any:
    """Plain JSON for a domain value: decimals as fixed text, dates in ISO, models as their dump."""
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, Decimal):
        return {"$dec": format(value, "f")} if value.is_finite() else {"$dec": str(value)}
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    if isinstance(value, dict):
        return {str(j(k)) if not isinstance(k, str) else k: j(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [j(v) for v in value]
    if hasattr(value, "__dataclass_fields__"):
        return {k: j(getattr(value, k)) for k in value.__dataclass_fields__}
    raise TypeError(f"no JSON form for {type(value).__name__}")


def outcome(fn: Any, *args: Any, **kwargs: Any) -> dict[str, Any]:
    """{"ok": result} or {"error": exception type name}."""
    try:
        return {"ok": j(fn(*args, **kwargs))}
    except Exception as exc:
        return {"error": type(exc).__name__}
