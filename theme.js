/*
 * theme.js — applies settings as CSS variables on <html>, live, no reload.
 * Everything Canvas-DOM-facing is gated behind a single class ("cdx-enabled")
 * so we touch as little of Canvas's own styling as possible.
 */
(function (global) {
  'use strict';

  var ACCENT_PRESETS = [
    { id: 'crimson', label: 'Crimson', hex: '#c0392b' },
    { id: 'blue', label: 'Blue', hex: '#2563eb' },
    { id: 'green', label: 'Green', hex: '#0f9d58' },
    { id: 'purple', label: 'Purple', hex: '#7c3aed' },
    { id: 'amber', label: 'Amber', hex: '#d97706' },
    { id: 'slate', label: 'Slate', hex: '#475569' }
  ];

  var mediaQuery = global.matchMedia ? global.matchMedia('(prefers-color-scheme: dark)') : null;

  function resolveMode(settings) {
    if (settings.mode === 'light' || settings.mode === 'dark') return settings.mode;
    return mediaQuery && mediaQuery.matches ? 'dark' : 'light';
  }

  function hexToRgb(hex) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!m) return { r: 192, g: 57, b: 43 };
    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
  }

  function applySettings(settings) {
    var html = document.documentElement;
    html.classList.add('cdx-enabled');
    var mode = resolveMode(settings);
    html.setAttribute('data-cdx-mode', mode);
    html.setAttribute('data-cdx-density', settings.density);
    html.setAttribute('data-cdx-radius', settings.radius);
    html.setAttribute('data-cdx-font', settings.font);
    html.setAttribute('data-cdx-background', settings.background);
    html.classList.toggle('cdx-hide-course-images', !settings.showCourseImages);
    html.classList.toggle('cdx-hide-streak', !settings.showStreak);
    html.classList.toggle('cdx-hide-ring', !settings.showRing);

    var style = html.style;
    var rgb = hexToRgb(settings.accent);
    style.setProperty('--cdx-accent', settings.accent);
    style.setProperty('--cdx-accent-rgb', rgb.r + ',' + rgb.g + ',' + rgb.b);
  }

  function buildAccentPresetButtons(container, current, onPick) {
    container.innerHTML = '';
    ACCENT_PRESETS.forEach(function (preset) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cdx-swatch';
      btn.style.setProperty('--cdx-swatch-color', preset.hex);
      btn.setAttribute('aria-label', preset.label);
      btn.setAttribute('aria-pressed', String(current === preset.hex));
      if (current === preset.hex) btn.classList.add('is-active');
      btn.addEventListener('click', function () { onPick(preset.hex); });
      container.appendChild(btn);
    });
  }

  function field(labelText, controlEl) {
    var wrap = document.createElement('label');
    wrap.className = 'cdx-field';
    var span = document.createElement('span');
    span.className = 'cdx-field__label';
    span.textContent = labelText;
    wrap.appendChild(span);
    wrap.appendChild(controlEl);
    return wrap;
  }

  function select(options, current) {
    var el = document.createElement('select');
    el.className = 'cdx-select';
    options.forEach(function (opt) {
      var o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === current) o.selected = true;
      el.appendChild(o);
    });
    return el;
  }

  function checkbox(current) {
    var el = document.createElement('input');
    el.type = 'checkbox';
    el.className = 'cdx-checkbox';
    el.checked = !!current;
    return el;
  }

  function buildSettingsDialog(getSettings, onChange) {
    var dialog = document.createElement('dialog');
    dialog.className = 'cdx-root cdx-settings-dialog';
    dialog.setAttribute('aria-label', 'Dashboard settings');

    var form = document.createElement('form');
    form.method = 'dialog';
    form.className = 'cdx-settings-form';

    var heading = document.createElement('h2');
    heading.className = 'cdx-settings-heading';
    heading.textContent = 'Dashboard settings';
    form.appendChild(heading);

    var settings = getSettings();

    // Mode
    var modeSelect = select([
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' },
      { value: 'follow-system', label: 'Follow system' }
    ], settings.mode);
    modeSelect.addEventListener('change', function () { onChange({ mode: modeSelect.value }); });
    form.appendChild(field('Mode', modeSelect));

    // Accent
    var accentWrap = document.createElement('div');
    accentWrap.className = 'cdx-accent-row';
    var swatches = document.createElement('div');
    swatches.className = 'cdx-swatches';
    var customHex = document.createElement('input');
    customHex.type = 'text';
    customHex.className = 'cdx-hex-input';
    customHex.placeholder = '#hex';
    customHex.value = settings.accent;
    function refreshSwatches(current) {
      buildAccentPresetButtons(swatches, current, function (hex) {
        customHex.value = hex;
        onChange({ accent: hex });
        refreshSwatches(hex);
      });
    }
    refreshSwatches(settings.accent);
    customHex.addEventListener('change', function () {
      var v = customHex.value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(v)) {
        onChange({ accent: v });
        refreshSwatches(v);
      }
    });
    accentWrap.appendChild(swatches);
    accentWrap.appendChild(customHex);
    form.appendChild(field('Accent color', accentWrap));

    // Background
    var bgSelect = select([
      { value: 'none', label: 'Canvas default' },
      { value: 'tint', label: 'Subtle tint' },
      { value: 'solid', label: 'Solid color' }
    ], settings.background);
    bgSelect.addEventListener('change', function () { onChange({ background: bgSelect.value }); });
    form.appendChild(field('Background', bgSelect));

    // Font
    var fontSelect = select([
      { value: 'system', label: 'System' },
      { value: 'serif', label: 'Serif' },
      { value: 'mono', label: 'Monospace' }
    ], settings.font);
    fontSelect.addEventListener('change', function () { onChange({ font: fontSelect.value }); });
    form.appendChild(field('Font', fontSelect));

    // Density
    var densitySelect = select([
      { value: 'comfortable', label: 'Comfortable' },
      { value: 'compact', label: 'Compact' }
    ], settings.density);
    densitySelect.addEventListener('change', function () { onChange({ density: densitySelect.value }); });
    form.appendChild(field('Density', densitySelect));

    // Radius
    var radiusSelect = select([
      { value: 'sharp', label: 'Sharp' },
      { value: 'soft', label: 'Soft' },
      { value: 'round', label: 'Round' }
    ], settings.radius);
    radiusSelect.addEventListener('change', function () { onChange({ radius: radiusSelect.value }); });
    form.appendChild(field('Corner radius', radiusSelect));

    // Toggles
    var toggleWrap = document.createElement('div');
    toggleWrap.className = 'cdx-toggle-group';
    [
      { key: 'showStreak', label: 'Show streak' },
      { key: 'showRing', label: 'Show ring' },
      { key: 'showCourseImages', label: 'Show course images' }
    ].forEach(function (t) {
      var cb = checkbox(settings[t.key]);
      cb.addEventListener('change', function () {
        var patch = {};
        patch[t.key] = cb.checked;
        onChange(patch);
      });
      toggleWrap.appendChild(field(t.label, cb));
    });
    form.appendChild(toggleWrap);

    var closeRow = document.createElement('div');
    closeRow.className = 'cdx-settings-close-row';
    var closeBtn = document.createElement('button');
    closeBtn.type = 'submit';
    closeBtn.className = 'cdx-btn cdx-btn--primary';
    closeBtn.textContent = 'Done';
    closeRow.appendChild(closeBtn);
    form.appendChild(closeRow);

    dialog.appendChild(form);
    return dialog;
  }

  global.CdxTheme = {
    ACCENT_PRESETS: ACCENT_PRESETS,
    applySettings: applySettings,
    buildSettingsDialog: buildSettingsDialog,
    watchSystemMode: function (cb) {
      if (!mediaQuery) return;
      var handler = function () { cb(); };
      if (mediaQuery.addEventListener) mediaQuery.addEventListener('change', handler);
      else if (mediaQuery.addListener) mediaQuery.addListener(handler);
    }
  };
})(window);
