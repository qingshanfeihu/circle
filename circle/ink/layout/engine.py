
from __future__ import annotations

from ..dom import DOMElement, DOMNode, NodeType, Rect, TextNode
from ..string_width import string_width


def compute_layout(root: DOMElement, width: int, height: int) -> None:
    root.rect = Rect(0, 0, width, height)
    _layout_children(root)


def _layout_children(node: DOMElement) -> None:
    if not node.children:
        return

    rect = node.rect
    border_w = 1 if node.style.border_style else 0
    pad_h = node.style.padding_left + node.style.padding_right + 2 * border_w
    pad_v = node.style.padding_top + node.style.padding_bottom + 2 * border_w
    avail_w = max(0, rect.width - pad_h)
    avail_h = max(0, rect.height - pad_v)

    visible = [c for c in node.children if isinstance(c, DOMElement) and c.style.display != "none"]
    if not visible:
        
        for c in node.children:
            if isinstance(c, TextNode):
                c.rect = Rect(0, 0, avail_w, 1)
        return

    is_column = node.style.flex_direction == "column"

    
    fixed_total = 0
    flex_total = 0.0
    for child in visible:
        size = _get_fixed_size(child, is_column, avail_w, avail_h)
        if size is not None:
            fixed_total += size
        else:
            flex_total += max(child.style.flex_grow, 0.001)

    
    remaining = (avail_h if is_column else avail_w) - fixed_total
    remaining = max(0, remaining)

    offset = 0
    for child in visible:
        fixed = _get_fixed_size(child, is_column, avail_w, avail_h)
        if fixed is not None:
            size = fixed
        else:
            grow = max(child.style.flex_grow, 0.001)
            size = int(remaining * grow / flex_total) if flex_total > 0 else 0

        if is_column:
            child.rect = Rect(0, offset, avail_w, size)
        else:
            child.rect = Rect(offset, 0, size, avail_h)
        offset += size

        
        if isinstance(child, DOMElement):
            _layout_children(child)


def _get_fixed_size(child: DOMElement, is_column: bool, avail_w: int, avail_h: int) -> int | None:
    if is_column:
        h = child.style.height
        if isinstance(h, int):
            return h
        if child.style.flex_grow > 0:
            return None
        
        return _estimate_content_height(child, avail_w)
    else:
        w = child.style.width
        if isinstance(w, int):
            return w
        if child.style.flex_grow > 0:
            return None
        return _estimate_content_width(child)


def _estimate_content_height(node: DOMElement, avail_w: int) -> int:
    total = 0
    for child in node.children:
        if isinstance(child, TextNode):
            if child.fill_char:
                total += 1
                continue
            if not child.value:
                continue
            lines = child.value.split("\n")
            for line in lines:
                w = string_width(line)
                total += max(1, (w + avail_w - 1) // avail_w) if avail_w > 0 else 1
        elif isinstance(child, DOMElement):
            h = child.style.height
            total += h if isinstance(h, int) else 1
    return max(1, total)


def _estimate_content_width(node: DOMElement) -> int:
    max_w = 0
    for child in node.children:
        if isinstance(child, TextNode):
            max_w = max(max_w, string_width(child.value))
        elif isinstance(child, DOMElement):
            w = child.style.width
            if isinstance(w, int):
                max_w = max(max_w, w)
    return max(1, max_w)
