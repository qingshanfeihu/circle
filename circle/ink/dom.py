
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable


class NodeType(str, Enum):
    ROOT = "ink-root"
    BOX = "ink-box"
    TEXT = "ink-text"
    RAW_ANSI = "ink-raw-ansi"


@dataclass
class Styles:
    
    flex_direction: str = "column"
    flex_grow: float = 0
    flex_shrink: float = 1
    flex_basis: str | int = "auto"
    width: int | str | None = None
    height: int | str | None = None
    min_width: int | None = None
    min_height: int | None = None
    max_width: int | None = None
    max_height: int | None = None
    
    padding_top: int = 0
    padding_bottom: int = 0
    padding_left: int = 0
    padding_right: int = 0
    
    margin_top: int = 0
    margin_bottom: int = 0
    margin_left: int = 0
    margin_right: int = 0
    
    border_style: str | None = None
    border_color: str | None = None
    
    overflow: str = "visible"
    
    display: str = "flex"


@dataclass
class TextStyles:
    color: str | None = None
    background_color: str | None = None
    bold: bool = False
    dim: bool = False
    italic: bool = False
    underline: bool = False
    strikethrough: bool = False
    inverse: bool = False
    wrap: str = "wrap"


@dataclass
class Rect:
    x: int = 0
    y: int = 0
    width: int = 0
    height: int = 0


class DOMNode:

    def __init__(self, node_type: NodeType | str) -> None:
        self.node_type = node_type
        self.parent: DOMElement | None = None
        self.style = Styles()
        self.rect = Rect()
        self.dirty = True

    def mark_dirty(self) -> None:
        self.dirty = True
        if self.parent:
            self.parent.mark_dirty()


class DOMElement(DOMNode):

    def __init__(self, node_type: NodeType = NodeType.BOX) -> None:
        super().__init__(node_type)
        self.children: list[DOMNode] = []
        self.text_styles = TextStyles()
        self.attributes: dict[str, Any] = {}
        
        self.scroll_top: int = 0
        self.scroll_height: int = 0
        self.scroll_viewport_height: int = 0
        self.sticky_scroll: bool = False
        
        self.is_hidden: bool = False

    def append_child(self, child: DOMNode) -> None:
        child.parent = self
        self.children.append(child)
        self.mark_dirty()

    def remove_child(self, child: DOMNode) -> None:
        if child in self.children:
            self.children.remove(child)
            child.parent = None
            self.mark_dirty()

    def insert_before(self, child: DOMNode, ref: DOMNode | None) -> None:
        child.parent = self
        if ref is None or ref not in self.children:
            self.children.append(child)
        else:
            idx = self.children.index(ref)
            self.children.insert(idx, child)
        self.mark_dirty()

    def clear_children(self) -> None:
        for child in self.children:
            child.parent = None
        self.children.clear()
        self.mark_dirty()


def _sanitize_text_value(value: str) -> str:
    if "\t" in value or "\r" in value:
        return value.replace("\t", " ").replace("\r", "")
    return value


class TextNode(DOMNode):

    def __init__(self, value: str = "") -> None:
        super().__init__("#text")
        self.value = _sanitize_text_value(value)
        self._rows_cache: tuple[int, int] | None = None
        self.fill_char: str | None = None

    def set_value(self, value: str) -> None:
        value = _sanitize_text_value(value)
        if self.value != value:
            self.value = value
            self._rows_cache = None
            self.mark_dirty()

    def wrapped_rows(self, width: int) -> int:
        c = self._rows_cache
        if c is not None and c[0] == width:
            return c[1]
        from .string_width import wrapped_row_count
        n = wrapped_row_count(self.value, width) if self.value else 1
        self._rows_cache = (width, n)
        return n


def create_element(node_type: NodeType = NodeType.BOX, **attrs: Any) -> DOMElement:
    el = DOMElement(node_type)
    for k, v in attrs.items():
        el.attributes[k] = v
    return el


def create_text(value: str = "") -> TextNode:
    return TextNode(value)


def create_fill_text(char: str = "─") -> TextNode:
    node = TextNode("")
    node.fill_char = char
    return node
