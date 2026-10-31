// Emoji Picker: a Cinnamon panel applet.
// Click the panel icon, click an emoji, and it is copied to the clipboard.
//
// The emoji come straight from Unicode's official emoji-test.txt (bundled in
// this folder, unmodified). To update to a newer Unicode release, replace that
// file with the new one from https://unicode.org/Public/emoji/latest/

const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const St = imports.gi.St;
const Gtk = imports.gi.Gtk;
const GLib = imports.gi.GLib;
const Pango = imports.gi.Pango;
const Gettext = imports.gettext;

const UUID = "emoji-picker@francocurotto";
const MAX_RECENT = 32;
const MAX_SEARCH_RESULTS = 240;
const ROWS_PER_IDLE_BATCH = 6;
const SEARCH_HINT_INDENT = "\u00A0\u00A0";
const MAX_NAME_FOR_HINT = 38;

Gettext.bindtextdomain(UUID, GLib.get_home_dir() + "/.local/share/locale");

function _(str) {
    let customTranslation = Gettext.dgettext(UUID, str);
    if (customTranslation !== str) {
        return customTranslation;
    }
    return Gettext.gettext(str);
}

/* ---------------------------------------------------------------------------
 * Data loading (pure functions, no Cinnamon dependencies)
 * ------------------------------------------------------------------------- */

// Tab icons for the groups defined by Unicode. Unknown (future) groups fall
// back to the first emoji they contain.
const GROUP_ICONS = {
    "Smileys & Emotion": "😀",
    "People & Body": "👋",
    "Animals & Nature": "🐶",
    "Food & Drink": "🍎",
    "Travel & Places": "🚗",
    "Activities": "⚽",
    "Objects": "💡",
    "Symbols": "🔣",
    "Flags": "🚩"
};

const TONE_FIRST = 0x1F3FB;   // light skin tone
const TONE_LAST = 0x1F3FF;    // dark skin tone
const TONE_PHRASE = /^(light|medium-light|medium|medium-dark|dark) skin tone$/;

// "<hex code points> ; <status> # <emoji> E<major>.<minor> <name>"
const LINE_RX = /^([0-9A-Fa-f ]+?)\s*;\s*([a-z-]+)\s*#\s*(\S+)\s+E(\d+)\.(\d+)\s+(.+)$/;

function readTextFile(path) {
    let [ok, bytes] = GLib.file_get_contents(path);
    if (!ok) {
        throw new Error("could not read " + path);
    }
    if (typeof TextDecoder !== "undefined") {
        return new TextDecoder("utf-8").decode(bytes);
    }
    return imports.byteArray.toString(bytes);
}

function stripVariationSelector(s) {
    return s.replace(/\uFE0F/g, "");
}

// "woman: light skin tone, red hair" -> "woman: red hair"
// "handshake: light skin tone, dark skin tone" -> "handshake"
function baseNameOf(name) {
    let sep = name.indexOf(": ");
    if (sep < 0) {
        return name;
    }
    let head = name.substring(0, sep);
    let parts = name.substring(sep + 2).split(", ").filter(p => !TONE_PHRASE.test(p));
    return parts.length > 0 ? head + ": " + parts.join(", ") : head;
}

// Parses emoji-test.txt. Only fully-qualified emoji are used. Skin-tone
// variants are folded into their base emoji instead of cluttering the grid:
//   base.variants = every variant (for the right-click view)
//   base.tones    = { "1F3FB": variant, ... } single-tone variants only
function parseEmojiTest(text) {
    let categories = [];
    let current = null;
    let baseByName = {};
    let pending = [];
    let nameByEmoji = {};

    let lines = text.split("\n");
    for (let n = 0; n < lines.length; n++) {
        let line = lines[n];

        if (line.charAt(0) === "#") {
            if (line.startsWith("# group:")) {
                let groupName = line.substring(8).trim();
                if (groupName === "Component") {
                    current = null;
                } else {
                    current = { name: groupName, icon: GROUP_ICONS[groupName] || "", items: [] };
                    categories.push(current);
                }
            }
            continue;
        }

        if (current === null) {
            continue;
        }
        let m = LINE_RX.exec(line);
        if (m === null || m[2] !== "fully-qualified") {
            continue;
        }

        let codePoints = m[1].trim().split(/\s+/).map(h => parseInt(h, 16));
        let tones = codePoints.filter(cp => cp >= TONE_FIRST && cp <= TONE_LAST);
        let item = {
            emoji: m[3],
            name: m[6].trim(),
            version: parseFloat(m[4] + "." + m[5]),
            search: ""
        };
        item.search = item.name.toLowerCase();
        nameByEmoji[item.emoji] = item.name;

        if (tones.length === 0) {
            current.items.push(item);
            baseByName[item.name] = item;
        } else {
            pending.push({ item: item, tones: tones, group: current });
        }
    }

    pending.forEach(p => {
        let baseName = baseNameOf(p.item.name);
        // "kiss: person, person, <tone>, <tone>" belongs to the plain "kiss".
        let base = baseByName[baseName] || baseByName[baseName.replace(/: person, person$/, "")];
        if (!base) {
            p.group.items.push(p.item);   // never lose an emoji
            return;
        }
        if (!base.variants) {
            base.variants = [];
            base.tones = {};
        }
        base.variants.push(p.item);
        let first = p.tones[0];
        if (p.tones.every(cp => cp === first)) {
            base.tones[first.toString(16).toUpperCase()] = p.item;
        }
    });

    return { categories: categories, nameByEmoji: nameByEmoji };
}

// "<emoji> <extra search words>" per line; "//" starts a comment.
function parseKeywords(text) {
    let map = {};
    text.split("\n").forEach(raw => {
        let line = raw.trim();
        if (line === "" || line.startsWith("//")) {
            return;
        }
        let space = line.indexOf(" ");
        if (space > 0) {
            map[stripVariationSelector(line.substring(0, space))] = line.substring(space + 1).trim().toLowerCase();
        }
    });
    return map;
}

/* ---------------------------------------------------------------------------
 * Applet
 * ------------------------------------------------------------------------- */

function EmojiPickerApplet(metadata, orientation, panelHeight, instanceId) {
    this._init(metadata, orientation, panelHeight, instanceId);
}

EmojiPickerApplet.prototype = {
    __proto__: Applet.IconApplet.prototype,

    _init: function(metadata, orientation, panelHeight, instanceId) {
        Applet.IconApplet.prototype._init.call(this, orientation, panelHeight, instanceId);

        this.metadata = metadata;
        this._built = false;
        this._suppressSearch = false;
        this._activeTab = 0;
        this._categories = [];
        this._tabs = [];
        this._tabButtons = [];
        this._visibleItems = [];
        this._visibleExact = false;
        this._nameByEmoji = {};
        this._renderSource = 0;
        this._variantsView = false;
        this._hotkeyName = UUID + "-" + this.instance_id;

        this.set_applet_tooltip(_("Emoji Picker"));

        this._clipboard = St.Clipboard.get_default();

        this._bindSettings();
        this._updateIcon();
        this._loadData();

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        this.menu.connect("open-state-changed", (menu, isOpen) => this._onOpenStateChanged(isOpen));

        this._buildUI();
        this._updateKeybinding();
    },

    /* ----- settings ------------------------------------------------------ */

    _bindSettings: function() {
        this.settings = new Settings.AppletSettings(this, UUID, this.instance_id);
        let refresh = () => this._onDisplaySettingsChanged();
        this.settings.bind("columns", "columns", refresh);
        this.settings.bind("visible-rows", "visibleRows", refresh);
        this.settings.bind("emoji-size", "emojiSize", refresh);
        this.settings.bind("skin-tone", "skinTone", refresh);
        this.settings.bind("max-emoji-version", "maxEmojiVersion", refresh);
        this.settings.bind("icon-style", "iconStyle", () => this._updateIcon());
        this.settings.bind("close-on-select", "closeOnSelect");
        this.settings.bind("notify-on-copy", "notifyOnCopy");
        this.settings.bind("keybinding", "keybinding", () => this._updateKeybinding());
        this.settings.bind("recent", "recent");
    },

    // "color": a full-colour yellow face that stands out on any panel.
    // "symbolic": a monochrome icon that takes the panel's text colour.
    _updateIcon: function() {
        let symbolic = this.iconStyle === "symbolic";
        let file = this.metadata.path + "/icons/" + (symbolic ? "emoji-picker-symbolic.svg" : "emoji-picker.svg");
        if (GLib.file_test(file, GLib.FileTest.EXISTS)) {
            if (symbolic) {
                this.set_applet_icon_symbolic_path(file);
            } else {
                this.set_applet_icon_path(file);
            }
        } else {
            this.set_applet_icon_symbolic_name("face-smile-symbolic");
        }
    },

    _onDisplaySettingsChanged: function() {
        if (!this._built) {
            return;
        }
        this._applySizes();
        if (this._currentQuery() === "") {
            this._renderTab(this._activeTab);
        } else {
            this._onSearchChanged();
        }
    },

    _updateKeybinding: function() {
        try {
            Main.keybindingManager.removeHotKey(this._hotkeyName);
        } catch (e) {
            // Nothing was bound yet.
        }
        let combo = this.keybinding || "";
        if (combo.replace(/:/g, "").trim() !== "") {
            Main.keybindingManager.addHotKey(this._hotkeyName, combo, () => this.menu.toggle());
        }
    },

    /* ----- data ---------------------------------------------------------- */

    _loadData: function() {
        let parsed = { categories: [], nameByEmoji: {} };
        try {
            parsed = parseEmojiTest(readTextFile(this.metadata.path + "/emoji-test.txt"));
        } catch (e) {
            global.logError("[" + UUID + "] Could not load emoji-test.txt: " + e);
        }

        let keywords = {};
        try {
            keywords = parseKeywords(readTextFile(this.metadata.path + "/emoji-keywords.txt"));
        } catch (e) {
            // The keywords file is optional.
        }

        parsed.categories.forEach(cat => {
            cat.items.forEach(item => {
                let extra = keywords[stripVariationSelector(item.emoji)];
                if (extra) {
                    item.search += " " + extra;
                }
            });
        });

        this._categories = parsed.categories;
        this._nameByEmoji = parsed.nameByEmoji;
        this._tabs = [{ icon: "🕘", name: _("Recently used"), recent: true }].concat(
            parsed.categories.map(cat => ({
                icon: cat.icon || (cat.items.length > 0 ? cat.items[0].emoji : "?"),
                name: cat.name,
                items: cat.items
            }))
        );
    },

    // Honours the "hide emoji newer than" setting.
    _isAllowed: function(item) {
        let max = parseFloat(this.maxEmojiVersion) || 0;
        return max === 0 || !(item.version > max);
    },

    // Applies the preferred skin tone, when the emoji has such a variant.
    _resolve: function(item) {
        if (item.tones && this.skinTone && this.skinTone !== "none") {
            let variant = item.tones[this.skinTone];
            if (variant && this._isAllowed(variant)) {
                return variant;
            }
        }
        return item;
    },

    /* ----- UI ------------------------------------------------------------ */

    _buildUI: function() {
        this.mainBox = new St.BoxLayout({ vertical: true, style_class: "emoji-picker-box" });

        // Search box
        this.searchEntry = new St.Entry({
            style_class: "emoji-search-entry",
            // St.Entry draws the hint from the same x position as the caret, so the
            // caret would sit on top of the first letter. The non-breaking spaces
            // push the hint to the right of it.
            hint_text: SEARCH_HINT_INDENT + _("Search emoji…"),
            track_hover: true,
            can_focus: true,
            x_expand: true
        });
        let searchText = this.searchEntry.get_clutter_text();
        searchText.connect("text-changed", () => this._onSearchChanged());
        searchText.connect("activate", () => this._onSearchActivate());
        this.mainBox.add_actor(this.searchEntry);

        // Category tabs
        this.tabBox = new St.BoxLayout({ style_class: "emoji-tabs", x_expand: true });
        this._tabButtons = [];
        this._tabs.forEach((tab, index) => {
            let button = new St.Button({
                style_class: "emoji-tab",
                reactive: true,
                can_focus: true,
                track_hover: true,
                x_expand: true
            });
            button.set_child(new St.Label({ text: tab.icon, style: "font-size: 15px;" }));
            button.connect("clicked", () => {
                this._selectTab(index);
                this._focusSearch();
            });
            button.connect("notify::hover", () => {
                if (button.hover) {
                    this._setPreview(tab.name);
                }
            });
            this.tabBox.add_actor(button);
            this._tabButtons.push(button);
        });
        this.mainBox.add_actor(this.tabBox);

        // Scrollable emoji grid
        this.scroll = new St.ScrollView({ style_class: "emoji-scroll" });
        this.scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);
        this.gridBox = new St.BoxLayout({ vertical: true });
        this.scroll.add_actor(this.gridBox);
        this.mainBox.add_actor(this.scroll);

        // Footer: name of the hovered emoji / copy confirmation. Its width is pinned
        // to the grid width in _applySizes(); without that, a long name would be the
        // widest thing in the menu and stretch the whole applet.
        this.previewLabel = new St.Label({ style_class: "emoji-preview" });
        this._enableWrap(this.previewLabel);
        this.mainBox.add_actor(this.previewLabel);

        this.menu.addActor(this.mainBox);

        this._built = true;
        this._applySizes();
        this._selectTab(this._defaultTab());
        this._setPreview(_("Click an emoji to copy it"));
    },

    _cellSize: function() {
        return Math.round((parseInt(this.emojiSize) || 22) * 1.7);
    },

    _columns: function() {
        return Math.max(1, parseInt(this.columns) || 8);
    },

    // Width of the emoji grid, including room for the vertical scrollbar.
    _gridWidth: function() {
        return this._columns() * this._cellSize() + 20;
    },

    _applySizes: function() {
        let rows = Math.max(1, parseInt(this.visibleRows) || 7);
        let width = this._gridWidth();
        this.scroll.set_style("width: " + width + "px; height: " + (rows * this._cellSize()) + "px;");
        this._applyFooterStyle();
    },

    // The footer's width is pinned to the grid's. Its height reserves two lines
    // (see stylesheet.css). The variants view can show the longest names, which
    // need a third, so it reserves that for as long as it is open. That keeps the
    // menu from changing height as the pointer moves between emoji.
    _applyFooterStyle: function() {
        let style = "width: " + this._gridWidth() + "px;";
        if (this._variantsView) {
            style += " min-height: 50px;";
        }
        this.previewLabel.set_style(style);
    },

    // Wrap long text onto further lines (breaking inside a word if it has to).
    _enableWrap: function(label) {
        let text = label.get_clutter_text();
        text.set_line_wrap(true);
        text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        text.set_ellipsize(Pango.EllipsizeMode.NONE);
    },

    _defaultTab: function() {
        let hasRecent = Array.isArray(this.recent) && this.recent.length > 0;
        if (hasRecent || this._tabs.length < 2) {
            return 0;
        }
        return 1;
    },

    _focusSearch: function() {
        global.stage.set_key_focus(this.searchEntry);
    },

    _setPreview: function(text) {
        this.previewLabel.set_text(text);
    },

    _currentQuery: function() {
        return this.searchEntry.get_text().trim().toLowerCase();
    },

    /* ----- rendering ----------------------------------------------------- */

    _selectTab: function(index) {
        this._activeTab = index;
        this._tabButtons.forEach((button, i) => {
            if (i === index) {
                button.add_style_class_name("emoji-tab-selected");
            } else {
                button.remove_style_class_name("emoji-tab-selected");
            }
        });

        this._clearSearchText();
        this._renderTab(index);
    },

    _clearSearchText: function() {
        this._suppressSearch = true;
        this.searchEntry.set_text("");
        this._suppressSearch = false;
    },

    _renderTab: function(index) {
        let tab = this._tabs[index];
        if (!tab) {
            this._renderItems([], { empty: _("No emoji data found") });
            return;
        }

        if (tab.recent) {
            let list = Array.isArray(this.recent) ? this.recent : [];
            let items = list.map(emoji => ({ emoji: emoji, name: this._nameByEmoji[emoji] || "" }));
            this._renderItems(items, { empty: _("No recent emoji yet") });
        } else {
            this._renderItems(tab.items.filter(item => this._isAllowed(item)), { empty: "" });
        }
    },

    _cancelRender: function() {
        if (this._renderSource) {
            Mainloop.source_remove(this._renderSource);
            this._renderSource = 0;
        }
    },

    // opts.empty:  text shown when there is nothing to display
    // opts.exact:  show items exactly as given (no skin-tone preference, no variant view)
    // opts.header: optional title shown above the grid
    //
    // The first screenful is built immediately; the rest is added in small
    // idle batches so that big categories never freeze the shell.
    _renderItems: function(items, opts) {
        opts = opts || {};
        this._cancelRender();
        this._visibleItems = items;
        this._visibleExact = !!opts.exact;
        this._variantsView = !!opts.header;
        this._applyFooterStyle();
        this.gridBox.destroy_all_children();

        if (opts.header) {
            let header = new St.Label({
                text: opts.header,
                style_class: "emoji-variants-title",
                style: "width: " + (this._columns() * this._cellSize()) + "px;"
            });
            this._enableWrap(header);
            this.gridBox.add_actor(header);
        }

        if (items.length === 0) {
            this.gridBox.add_actor(new St.Label({ text: opts.empty || "", style_class: "emoji-empty" }));
            return;
        }

        let cols = this._columns();
        let totalRows = Math.ceil(items.length / cols);
        let nextRow = 0;

        let addRows = (count) => {
            let end = Math.min(totalRows, nextRow + count);
            for (; nextRow < end; nextRow++) {
                let row = new St.BoxLayout({ style_class: "emoji-row" });
                let last = Math.min(items.length, (nextRow + 1) * cols);
                for (let i = nextRow * cols; i < last; i++) {
                    row.add_actor(this._createEmojiButton(items[i], !!opts.exact));
                }
                this.gridBox.add_actor(row);
            }
            return nextRow < totalRows;
        };

        let visibleRows = Math.max(1, parseInt(this.visibleRows) || 7);
        if (addRows(visibleRows + 1)) {
            this._renderSource = Mainloop.idle_add(() => {
                if (addRows(ROWS_PER_IDLE_BATCH)) {
                    return true;
                }
                this._renderSource = 0;
                return false;
            });
        }

        // Jump back to the top whenever the content changes.
        try {
            this.scroll.get_vscroll_bar().get_adjustment().set_value(0);
        } catch (e) {
            // Not critical.
        }
    },

    _createEmojiButton: function(item, exact) {
        let shown = exact ? item : this._resolve(item);
        let hasVariants = !exact && !!item.variants && item.variants.length > 0;
        let cell = this._cellSize();
        let size = parseInt(this.emojiSize) || 22;

        let button = new St.Button({
            style_class: "emoji-button",
            reactive: true,
            can_focus: true,
            track_hover: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE
        });
        button.set_style("width: " + cell + "px; height: " + cell + "px;");
        button.set_child(new St.Label({ text: shown.emoji, style: "font-size: " + size + "px;" }));

        button.connect("clicked", (actor, mouseButton) => {
            if (mouseButton === 3) {
                if (hasVariants) {
                    this._showVariants(item);
                }
                return;
            }
            this._copyEmoji(shown);
        });
        button.connect("notify::hover", () => {
            if (!button.hover) {
                return;
            }
            let text = shown.name !== "" ? shown.emoji + "  " + shown.name : shown.emoji;
            // The hint gets its own line, but only when the name is short enough
            // for the footer to stay within its two reserved lines.
            if (hasVariants && text.length <= MAX_NAME_FOR_HINT) {
                text += "\n" + _("Right-click for skin tones");
            }
            this._setPreview(text);
        });
        return button;
    },

    // Right-click on an emoji: show it together with all of its variants.
    // Picking any tab (or searching) goes back to the normal view.
    _showVariants: function(base) {
        let list = [base].concat(base.variants.filter(v => this._isAllowed(v)));
        this._clearSearchText();
        this._renderItems(list, { exact: true, header: base.emoji + "  " + base.name });
    },

    /* ----- search -------------------------------------------------------- */

    _onSearchChanged: function() {
        if (this._suppressSearch) {
            return;
        }

        let query = this._currentQuery();
        if (query === "") {
            this._renderTab(this._activeTab);
            return;
        }

        let terms = query.split(/\s+/);
        let results = [];
        for (let c = 0; c < this._categories.length && results.length < MAX_SEARCH_RESULTS; c++) {
            let items = this._categories[c].items;
            for (let i = 0; i < items.length && results.length < MAX_SEARCH_RESULTS; i++) {
                let item = items[i];
                if (this._isAllowed(item) && terms.every(term => item.search.indexOf(term) !== -1)) {
                    results.push(item);
                }
            }
        }
        this._renderItems(results, { empty: _("No emoji found") });
    },

    // Pressing Enter in the search box copies the first result.
    _onSearchActivate: function() {
        if (this._visibleItems.length > 0) {
            let first = this._visibleItems[0];
            this._copyEmoji(this._visibleExact ? first : this._resolve(first));
        }
    },

    /* ----- actions ------------------------------------------------------- */

    _copyEmoji: function(item) {
        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, item.emoji);
        this._addRecent(item.emoji);
        this._setPreview(_("Copied") + " " + item.emoji);

        if (this.notifyOnCopy) {
            Main.notify(_("Emoji copied"), item.name !== "" ? item.emoji + "  " + item.name : item.emoji);
        }

        if (this.closeOnSelect) {
            this.menu.close();
        } else {
            this._focusSearch();
        }
    },

    _addRecent: function(emoji) {
        let list = Array.isArray(this.recent) ? this.recent : [];
        list = list.filter(e => e !== emoji);
        list.unshift(emoji);
        // Assigning a new array makes the settings layer persist it.
        this.recent = list.slice(0, MAX_RECENT);
    },

    _onOpenStateChanged: function(isOpen) {
        if (!isOpen) {
            return;
        }
        this._selectTab(this._defaultTab());
        this._setPreview(_("Click an emoji to copy it"));
        Mainloop.idle_add(() => {
            this._focusSearch();
            return false;
        });
    },

    /* ----- applet callbacks ---------------------------------------------- */

    on_applet_clicked: function(event) {
        this.menu.toggle();
    },

    on_orientation_changed: function(orientation) {
        this.orientation = orientation;
        if (this.menu && typeof this.menu.setArrowSide === "function") {
            this.menu.setArrowSide(orientation);
        }
    },

    on_applet_removed_from_panel: function() {
        this._cancelRender();
        try {
            Main.keybindingManager.removeHotKey(this._hotkeyName);
        } catch (e) {
            // Already gone.
        }
        if (this.settings) {
            this.settings.finalize();
        }
        if (this.menu) {
            this.menu.destroy();
        }
    }
};

function main(metadata, orientation, panelHeight, instanceId) {
    return new EmojiPickerApplet(metadata, orientation, panelHeight, instanceId);
}
