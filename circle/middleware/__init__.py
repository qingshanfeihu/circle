"""Generic agent middleware for Circle (no product-specific logic).

- ``ToolErrorBoundaryMiddleware``: an exception escaping a tool becomes an error
  ToolMessage instead of ending the turn.
- ``ToolCallCompatibilityMiddleware``: repairs common tool-call shape mistakes
  (tool-name case, JSON-in-a-string arguments, key spelling, unicode escapes) and
  tells the model which fields are wrong when arguments do not match the schema.
- ``LoopGuardMiddleware``: when the model repeats the same call, keeps getting empty
  results or rereads the same target, it gets a reminder to change strategy.
- ``ToolResultPruneMiddleware``: old tool outputs beyond a protected window are cut
  to a short head so long sessions keep room for new work.

Ported from InfoTest's IST-Core middleware; the compile-engine branches were left out.
"""

from circle.middleware.loop_guard import LoopGuardMiddleware
from circle.middleware.tool_call_compat import ToolCallCompatibilityMiddleware
from circle.middleware.tool_error_boundary import ToolErrorBoundaryMiddleware
from circle.middleware.tool_result_prune import ToolResultPruneMiddleware

__all__ = [
    "LoopGuardMiddleware",
    "ToolCallCompatibilityMiddleware",
    "ToolErrorBoundaryMiddleware",
    "ToolResultPruneMiddleware",
]
