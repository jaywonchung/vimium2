// This is the set of all content scripts required to make Vimium's functionality work. This file is
// imported by background pages that we want to work with Vimium's key mappings, e.g. the options
// page. This should be the same list of files as in manifest.js's content_scripts section.

import "../core/backend.js";
import "../local_backend.js";
import "../core/lib/types.js";
import "../core/lib/utils.js";
import "../core/lib/url_utils.js";
import "../core/lib/keyboard_utils.js";
import "../core/lib/dom_utils.js";
import "../core/lib/rect.js";
import "../core/lib/handler_stack.js";
import "../core/lib/settings.js";
import "../core/lib/find_mode_history.js";

import "../core/content_scripts/mode.js";
import "../core/content_scripts/ui_component.js";
import "../core/content_scripts/link_hints.js";
import "../core/content_scripts/vomnibar.js";
import "../core/content_scripts/scroller.js";
import "../core/content_scripts/marks.js";
import "../core/content_scripts/mode_insert.js";
import "../core/content_scripts/mode_find.js";
import "../core/content_scripts/mode_key_handler.js";
import "../core/content_scripts/mode_visual.js";
import "../core/content_scripts/hud.js";
import "../core/content_scripts/mode_normal.js";
import "../core/content_scripts/vimium_frontend.js";
