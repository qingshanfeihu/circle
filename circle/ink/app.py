
from __future__ import annotations

import logging
import os
import signal
import sys
import threading
import time
from typing import Any, Callable

logger = logging.getLogger(__name__)

from .cursor import CursorManager
from .dom import DOMElement, NodeType, Rect, create_element
from .layout.engine import compute_layout
from .log_update import render_frame, render_full
from .output import Output
from .parse_keypress import InputEvent, InputParser, MouseEvent
from .render import render_tree
from .screen import CharPool, Screen, StylePool
from .selection import (
    SelectionState,
    apply_selection_overlay,
    has_selection,
)
from .termio.dec import (
    DBP,
    DCS_REPORTS,
    DFE,
    ECS,
    DISABLE_MOUSE_TRACKING,
    EBP,
    EFE,
    ENABLE_MOUSE_TRACKING,
    ENTER_ALT_SCREEN,
    EXIT_ALT_SCREEN,
    HIDE_CURSOR,
    SHOW_CURSOR,
)
from .termio.csi import erase_in_display
from .termio.terminal import Terminal


class InkApp:

    def __init__(
        self,
        *,
        alt_screen: bool = True,
        mouse: bool = False,
    ) -> None:
        self._terminal = Terminal()
        self._alt_screen = alt_screen
        self._mouse = mouse
        # Ask the terminal to say when its colour scheme changes (DEC mode 2031). Terminals that
        # do not know the mode ignore it.
        self.color_scheme_reports = False
        self._running = False
        self._suspended = False

        
        
        
        
        self._render_lock = threading.RLock()
        self.lock = self._render_lock
        self._last_render_time = 0.0

        
        self._char_pool = CharPool()
        self._style_pool = StylePool()

        
        self._width = self._terminal.columns
        self._height = self._terminal.rows
        self._prev_screen = Screen(self._width, self._height, self._char_pool, self._style_pool)
        self._curr_screen = Screen(self._width, self._height, self._char_pool, self._style_pool)

        
        self.root = create_element(NodeType.ROOT)
        self.root.style.flex_direction = "column"

        
        self.cursor = CursorManager()

        
        self._input_parser = InputParser()
        self._on_input: Callable[[InputEvent], None] | None = None
        self._on_mouse: Callable[[MouseEvent], None] | None = None
        # Runs after the terminal size is known and before layout. Must not
        # call render(); used to rebuild the composer frame at the real width.
        self.before_render: Callable[[], None] | None = None

        
        
        
        
        self.selection: SelectionState = SelectionState()
        self._selection_listeners: set[Callable[[], None]] = set()

        
        self._render_pending = False
        self._running = False
        self._input_thread: threading.Thread | None = None
        self._input_stop = threading.Event()

    @property
    def width(self) -> int:
        return self._width

    @property
    def height(self) -> int:
        return self._height

    @property
    def style_pool(self) -> StylePool:
        return self._style_pool

    @property
    def on_input(self) -> Callable[[InputEvent], None] | None:
        return self._on_input

    @on_input.setter
    def on_input(self, handler: Callable[[InputEvent], None] | None) -> None:
        self._on_input = handler

    @property
    def on_mouse(self) -> Callable[[MouseEvent], None] | None:
        return self._on_mouse

    @on_mouse.setter
    def on_mouse(self, handler: Callable[[MouseEvent], None] | None) -> None:
        self._on_mouse = handler

    
    
    

    def add_selection_listener(self, cb: Callable[[], None]) -> Callable[[], None]:
        self._selection_listeners.add(cb)

        def _unsubscribe() -> None:
            self._selection_listeners.discard(cb)

        return _unsubscribe

    def notify_selection_change(self) -> None:
        for cb in list(self._selection_listeners):
            try:
                cb()
            except Exception:  # noqa: BLE001
                logger.debug("selection listener 回调异常", exc_info=True)

    def has_text_selection(self) -> bool:
        return has_selection(self.selection)

    def visible_screen(self) -> Screen:
        return self._prev_screen

    def start(self) -> None:
        if self._input_thread is not None and self._input_thread.is_alive():
            raise RuntimeError("the previous terminal input reader is still running")
        self._input_stop = threading.Event()
        self._running = True
        self._terminal.set_raw_mode(True)

        init_seq = ""
        if self._alt_screen:
            init_seq += ENTER_ALT_SCREEN
        init_seq += HIDE_CURSOR + EBP + EFE
        if self.color_scheme_reports:
            init_seq += ECS
        if self._mouse:
            
            
            
            
            init_seq += ENABLE_MOUSE_TRACKING
        init_seq += erase_in_display(2)
        self._terminal.write(init_seq)

        
        if hasattr(signal, "SIGWINCH"):
            signal.signal(signal.SIGWINCH, self._on_resize)
        else:  # Windows has no such signal: look at the window size a few times a second
            threading.Thread(
                target=self._watch_size, daemon=True, name="ink-resize",
            ).start()

        
        self._input_thread = threading.Thread(
            target=self._read_input, daemon=True, name="ink-input",
        )
        self._input_thread.start()

        
        self.render()

    def stop(self) -> None:
        self._running = False
        self._suspended = False
        self._input_stop.set()
        reader = self._input_thread
        if reader is not None and reader is not threading.current_thread():
            deadline = time.monotonic() + 2
            while reader.is_alive() and time.monotonic() < deadline:
                if reader.native_id is not None:
                    self._terminal.cancel_read(reader.native_id)
                reader.join(0.05)
            if reader.is_alive():
                raise RuntimeError("terminal input reader did not stop")

        cleanup = SHOW_CURSOR + DBP + DFE + DCS_REPORTS
        if self._mouse:
            cleanup += DISABLE_MOUSE_TRACKING
        if self._alt_screen:
            cleanup += EXIT_ALT_SCREEN
        self._terminal.write(cleanup)
        self._terminal.restore()

    def suspend_for_external(self) -> None:
        """Hand the TTY to $EDITOR without killing the session run loop."""
        self._suspended = True
        cleanup = SHOW_CURSOR + DBP + DFE + DCS_REPORTS
        if self._mouse:
            cleanup += DISABLE_MOUSE_TRACKING
        if self._alt_screen:
            cleanup += EXIT_ALT_SCREEN
        self._terminal.write(cleanup)
        self._terminal.set_raw_mode(False)

    def resume_from_external(self) -> None:
        """Take the TTY back after an external editor exits."""
        self._terminal.set_raw_mode(True)
        init_seq = ""
        if self._alt_screen:
            init_seq += ENTER_ALT_SCREEN
        init_seq += HIDE_CURSOR + EBP + EFE
        if self.color_scheme_reports:
            init_seq += ECS
        if self._mouse:
            init_seq += ENABLE_MOUSE_TRACKING
        init_seq += erase_in_display(2)
        self._terminal.write(init_seq)
        self._suspended = False
        self._force_full_render()

    @property
    def active(self) -> bool:
        """True while the screen is ours: started, and not lent to an external program."""
        return self._running and not self._suspended

    def set_color_scheme_reports(self, on: bool) -> None:
        """Turn the terminal's colour-scheme reports on or off, now if the screen is running."""
        self.color_scheme_reports = on
        if self.active:
            self.write_passthrough(ECS if on else DCS_REPORTS)

    def write_passthrough(self, data: str) -> None:
        with self._render_lock:
            try:
                self._terminal.write(data)
            except Exception:  # noqa: BLE001
                logger.debug("终端 passthrough 写入失败", exc_info=True)

    def render(self) -> None:
        if not self._running or getattr(self, "_suspended", False):
            return
        with self._render_lock:
            now = time.time()
            elapsed = now - self._last_render_time
            if elapsed < 0.016:

                if not self._render_pending:
                    self._render_pending = True
                    threading.Timer(0.016 - elapsed, self._do_render).start()
                return
            self._do_render_inner()

    def _do_render(self) -> None:
        with self._render_lock:
            if not self._running or getattr(self, "_suspended", False):
                self._render_pending = False
                return
            if self._render_pending:
                self._do_render_inner()

    def _do_render_inner(self, *, full: bool = False) -> None:
        self._render_pending = False
        self._last_render_time = time.time()


        self._width = self._terminal.columns
        self._height = self._terminal.rows
        if self.before_render is not None:
            self.before_render()
        compute_layout(self.root, self._width, self._height)


        if self._curr_screen.width != self._width or self._curr_screen.height != self._height:
            self._prev_screen = Screen(self._width, self._height, self._char_pool, self._style_pool)
            self._curr_screen = Screen(self._width, self._height, self._char_pool, self._style_pool)
            if not full:
                self._terminal.write(erase_in_display(2))


        output = Output(self._width, self._height, self._char_pool, self._style_pool, self._curr_screen)
        render_tree(self.root, output, self._char_pool, self._style_pool)
        output.apply()


        if has_selection(self.selection):
            apply_selection_overlay(self._curr_screen, self.selection, self._style_pool)


        now = time.time()
        if not full and now - getattr(self, "_last_full_paint", 0.0) >= 2.0:
            full = True
        if full:
            self._last_full_paint = now
            ansi = render_full(self._curr_screen, self._style_pool, self._char_pool)
        else:
            ansi = render_frame(self._prev_screen, self._curr_screen, self._style_pool, self._char_pool)
        if ansi:
            self._terminal.write(ansi)

        
        cursor_seq = self.cursor.get_cursor_sequence()
        if cursor_seq:
            self._terminal.write(cursor_seq + SHOW_CURSOR)
            self._cursor_visible = True
        elif getattr(self, "_cursor_visible", False):
            # nothing declares a cursor (the prompt row is hidden behind a card): hide it, or it
            # parks wherever the last change was drawn
            self._terminal.write(HIDE_CURSOR)
            self._cursor_visible = False

        
        self._prev_screen, self._curr_screen = self._curr_screen, self._prev_screen

    def _force_full_render(self) -> None:
        with self._render_lock:
            self._prev_screen = Screen(self._width, self._height, self._char_pool, self._style_pool)
            self._terminal.write(erase_in_display(2))
        self.render()

    def _repaint_full(self) -> None:
        with self._render_lock:
            self._do_render_inner(full=True)

    def schedule_render(self) -> None:
        if not self._render_pending and self._running:
            self._render_pending = True
            threading.Timer(0.016, self._do_scheduled_render).start()

    def _do_scheduled_render(self) -> None:
        if self._running and self._render_pending:
            self.render()

    def _on_resize(self, signum: int, frame: Any) -> None:
        if self._running:
            self.render()

    def _watch_size(self) -> None:
        size = (self._terminal.columns, self._terminal.rows)
        while self._running:
            time.sleep(0.1)
            now = (self._terminal.columns, self._terminal.rows)
            if now != size and not self._suspended:
                size = now
                self._on_resize(0, None)

    def _read_input(self) -> None:
        stop_event = self._input_stop
        while self._running and not stop_event.is_set():
            if self._suspended:
                time.sleep(0.05)
                continue
            try:
                text = self._terminal.read_input(stop_event)
                if not text or stop_event.is_set():
                    break
                events = self._input_parser.feed(text)
                input_handler = self._on_input
                mouse_handler = self._on_mouse
                for event in events:
                    if stop_event.is_set():
                        break
                    if input_handler is not None:
                        input_handler(event)
                    if mouse_handler is not None and isinstance(event, MouseEvent):
                        mouse_handler(event)
            except OSError:
                break
