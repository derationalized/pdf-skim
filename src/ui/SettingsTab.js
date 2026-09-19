'use strict';

const { PluginSettingTab, Setting, Notice } = require('obsidian');

class PdfSkimSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const cfg = this.plugin.settings.config;

    containerEl.createEl('h2', { text: 'PDF-Skim' });

    // ---- Import / export ----
    new Setting(containerEl)
      .setName('Import / export settings')
      .setDesc('Save or load your filtering config as a file.')
      .addButton(btn => btn.setButtonText('Export to file').onClick(() => this._exportSettings()))
      .addButton(btn => btn.setButtonText('Import from file').onClick(() => this._importSettings()));

    // ---- Debugging ----
    new Setting(containerEl)
      .setName('Debug mode')
      .setDesc('Shows why each pause/replacement happened. See README.')
      .addToggle(t => t.setValue(!!cfg.debugMode).onChange(async (value) => {
        cfg.debugMode = value;
        await this.plugin.saveSettings();
        if (this.plugin.playback) this.plugin.playback._emitUpdate();
      }));

    // ---- Speech engine ----
    containerEl.createEl('h3', { text: 'Speech engine' });

    new Setting(containerEl)
      .setName('Model folder')
      .setDesc(this._modelDropdownDesc())
      .addDropdown(drop => {
        const detected = this._listModelFolders();
        if (!detected.length) {
          drop.addOption('', '(no models found in models/ — see README)');
        } else {
          drop.addOption('', '(choose a model)');
          for (const name of detected) drop.addOption(name, name);
        }
        // The saved value might be an absolute path, or a folder that's
        // since been removed — either way, show it even if it's not in
        // the detected list rather than silently reverting the dropdown
        // to blank.
        const current = this.plugin.settings.modelDir;
        if (current && !detected.includes(current)) drop.addOption(current, `${current} (not detected)`);
        drop.setValue(current || '');
        drop.onChange(async (value) => {
          this.plugin.settings.modelDir = value;
          await this.plugin.saveSettings();
          this.plugin.sherpa = null; // force re-init with the new model on next narrate
        });
      })
      .addButton(btn => btn.setIcon('refresh-cw').setTooltip('Rescan models/ folder').onClick(() => this.display()));

    new Setting(containerEl)
      .setName('...or an absolute model path')
      .setDesc('For models kept outside models/.')
      .addText(text => text
        .setPlaceholder('/path/to/model/folder')
        .setValue(this._isOutsideModelsFolder() ? this.plugin.settings.modelDir : '')
        .onChange(async (value) => {
          const trimmed = value.trim();
          if (trimmed) {
            this.plugin.settings.modelDir = trimmed;
            await this.plugin.saveSettings();
            this.plugin.sherpa = null;
          }
        }));

    new Setting(containerEl)
      .setName('Engine override')
      .setDesc('Usually leave on Auto-detect.')
      .addDropdown(drop => drop
        .addOptions({ '': 'Auto-detect', vits: 'VITS', kokoro: 'Kokoro', matcha: 'Matcha', kitten: 'Kitten' })
        .setValue(this.plugin.settings.engineOverride)
        .onChange(async (value) => {
          this.plugin.settings.engineOverride = value;
          await this.plugin.saveSettings();
          this.plugin.sherpa = null;
        }));

    new Setting(containerEl)
      .setName('Synthesis threads')
      .setDesc('CPU threads for synthesis.')
      .addSlider(slider => slider
        .setLimits(1, 8, 1)
        .setValue(this.plugin.settings.numThreads)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.numThreads = value;
          await this.plugin.saveSettings();
          this.plugin.sherpa = null;
        }));

    new Setting(containerEl)
      .setName('Speaking speed')
      .setDesc('1.0 = normal.')
      .addSlider(slider => slider
        .setLimits(0.5, 2.0, 0.05)
        .setValue(this.plugin.settings.speed)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.speed = value;
          await this.plugin.saveSettings();
          // Without this, changing speed here only affected the default
          // used the *next* time a PDF loads — an already-playing one
          // kept going at the old speed until the panel's own slider
          // (which does call this) was touched too.
          if (this.plugin.playback) this.plugin.playback.setSpeed(value);
        }));

    new Setting(containerEl)
      .setName('Remember playback position')
      .setDesc('Enables the Resume button.')
      .addToggle(t => t.setValue(this.plugin.settings.rememberPosition).onChange(async (value) => {
        this.plugin.settings.rememberPosition = value;
        await this.plugin.saveSettings();
      }));

    // ---- Whole-document rules ----
    containerEl.createEl('h3', { text: 'Whole-document filtering' });

    this._toggle(containerEl, 'Stop at References/Bibliography',
      'Stops narration once reached.',
      cfg.stopAtReferences, 'enabled');

    this._toggle(containerEl, 'Remove repeated headers/footers',
      'Drops repeating running headers/footers.',
      cfg.removeRepeatedHeadersFooters, 'enabled');
    if (cfg.removeRepeatedHeadersFooters.enabled) {
      new Setting(containerEl)
        .setName('Repetition threshold')
        .setDesc('Fraction of pages required.')
        .addSlider(slider => slider
          .setLimits(0.1, 1.0, 0.05)
          .setValue(cfg.removeRepeatedHeadersFooters.minRepeatFraction)
          .setDynamicTooltip()
          .onChange(async (value) => {
            cfg.removeRepeatedHeadersFooters.minRepeatFraction = value;
            await this.plugin.saveSettings();
          }));
    }

    this._toggle(containerEl, 'Remove boilerplate lines',
      'Page numbers, DOIs, copyright lines, etc.',
      cfg.removeBoilerplate, 'enabled');
    if (cfg.removeBoilerplate.enabled) {
      this._patternList(containerEl, 'Boilerplate patterns (one regex per line, case-insensitive)',
        cfg.removeBoilerplate, 'patterns');
    }

    // ---- Headings ----
    containerEl.createEl('h3', { text: 'Headings' });
    this._toggle(containerEl, 'Announce section numbers',
      'Reads section numbers aloud.',
      cfg.headings, 'enabled');
    if (cfg.headings.enabled) {
      this._number(containerEl, 'Pause after section number (ms)', cfg.headings, 'pauseAfterNumberMs');
    }

    // ---- Figures/tables/etc ----
    containerEl.createEl('h3', { text: 'Figures, tables, listings' });
    this._toggle(containerEl, 'Filter figure/table/listing captions',
      'Includes inline references too.',
      cfg.figuresAndTables, 'enabled');
    if (cfg.figuresAndTables.enabled) {
      new Setting(containerEl)
        .setName('Standalone caption handling')
        .setDesc('For captions on their own line.')
        .addDropdown(drop => drop
          .addOptions({ replace: 'Replace with text below', skip: 'Skip entirely', keep: 'Keep as spoken text' })
          .setValue(cfg.figuresAndTables.mode)
          .onChange(async (value) => {
            cfg.figuresAndTables.mode = value;
            await this.plugin.saveSettings();
          }));
      this._commaList(containerEl, 'Keywords (comma-separated)', cfg.figuresAndTables, 'keywords');
      this._text(containerEl, 'Replacement text (blank = silent pause)', cfg.figuresAndTables, 'replacement');
    }

    this._toggle(containerEl, 'Filter detected table rows',
      'Heuristic — see README for how it works.',
      cfg.tables, 'enabled');
    if (cfg.tables.enabled) {
      new Setting(containerEl)
        .setName('Detected table handling')
        .setDesc('Applies to the whole detected table.')
        .addDropdown(drop => drop
          .addOptions({ skip: 'Skip entirely', replace: 'Replace with text below', keep: 'Keep as spoken text' })
          .setValue(cfg.tables.mode)
          .onChange(async (value) => {
            cfg.tables.mode = value;
            await this.plugin.saveSettings();
          }));
      this._text(containerEl, 'Replacement text (blank = silent pause)', cfg.tables, 'replacement');
    }

    // ---- Brackets ----
    containerEl.createEl('h3', { text: 'Bracketed asides & citations' });
    for (const [key, label] of [['parens', 'Parentheses ( )'], ['square', 'Square brackets [ ]'], ['curly', 'Curly braces { }']]) {
      const bcfg = cfg.brackets[key];
      this._toggle(containerEl, label, null, bcfg, 'enabled');
      if (bcfg.enabled) {
        const group = containerEl.createEl('div', { cls: 'pdf-skim-subsetting-group' });
        this._number(group, 'Minimum words to cut', bcfg, 'minWords');
        this._toggleRaw(group, 'Always strip if citation-shaped', 'Matches common citation patterns.', bcfg, 'alwaysStripCitations');
        this._text(group, 'Replacement text (blank = silent pause)', bcfg, 'replacement');
      }
    }

    // ---- Pauses ----
    containerEl.createEl('h3', { text: 'Pause timing' });
    this._toggle(containerEl, 'Insert structural pauses',
      'Between paragraphs, headings, list items.',
      cfg.structuralPauses, 'enabled');
    if (cfg.structuralPauses.enabled) {
      for (const [key, label] of [
        ['betweenParagraphsMs', 'Between paragraphs (ms)'],
        ['beforeHeadingMs', 'Before a heading (ms)'],
        ['afterHeadingMs', 'After a heading (ms)'],
        ['beforeListMs', 'Before a list (ms)'],
        ['betweenListItemsMs', 'Between list items (ms)'],
      ]) this._number(containerEl, label, cfg.structuralPauses, key);
    }
    this._number(containerEl, 'Silent-cut pause for captions (ms)', cfg.pauses, 'captionMs');
    this._number(containerEl, 'Silent-cut pause for bracket cuts (ms)', cfg.pauses, 'bracketMs');
    this._number(containerEl, 'Silent-cut pause for table cuts (ms)', cfg.pauses, 'tableMs');

    this._toggle(containerEl, 'Insert pauses at punctuation',
      'Within a sentence — commas, periods, etc. See README.',
      cfg.punctuationPauses, 'enabled');
    if (cfg.punctuationPauses.enabled) {
      containerEl.createEl('p', { text: 'After sentence-ending punctuation', cls: 'setting-item-description' });
      for (const [key, label] of [
        ['periodMs', 'Period . (ms)'],
        ['questionMs', 'Question mark ? (ms)'],
        ['exclamationMs', 'Exclamation mark ! (ms)'],
      ]) this._number(containerEl, label, cfg.punctuationPauses, key);

      containerEl.createEl('p', { text: 'After clause punctuation', cls: 'setting-item-description' });
      for (const [key, label] of [
        ['commaMs', 'Comma , (ms)'],
        ['colonMs', 'Colon : (ms)'],
        ['semicolonMs', 'Semicolon ; (ms)'],
      ]) this._number(containerEl, label, cfg.punctuationPauses, key);

      containerEl.createEl('p', { text: 'Before an opening bracket', cls: 'setting-item-description' });
      for (const [key, label] of [
        ['beforeParenMs', 'Parenthesis ( (ms)'],
        ['beforeSquareMs', 'Square bracket [ (ms)'],
        ['beforeCurlyMs', 'Curly brace { (ms)'],
      ]) this._number(containerEl, label, cfg.punctuationPauses, key);
    }

    // ---- Substitutions ----
    containerEl.createEl('h3', { text: 'Pronunciation & abbreviation substitutions' });
    containerEl.createEl('p', {
      text: 'Text swapped in before synthesis. See README for case-sensitivity notes.',
      cls: 'setting-item-description',
    });
    this._substitutionsTable(containerEl, cfg.substitutions);
  }

  _exportSettings() {
    const { Notice } = require('obsidian');
    // Model/engine settings are included deliberately, not left out: a
    // shared "profile" that silently drops which voice it was tuned
    // against is a common source of "why does this sound different than
    // when they sent it to me." The risk that shifts here — an imported
    // model folder that doesn't exist on this machine — is handled on
    // the import side instead (see _importSettings), by falling back to
    // whatever's currently selected rather than pointing at nothing.
    const payload = JSON.stringify({
      config: this.plugin.settings.config,
      modelDir: this.plugin.settings.modelDir,
      engineOverride: this.plugin.settings.engineOverride,
      numThreads: this.plugin.settings.numThreads,
    }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pdf-skim-settings.json';
    a.click();
    URL.revokeObjectURL(url);
    new Notice('PDF-Skim: settings exported.');
  }

  _importSettings() {
    const { Notice } = require('obsidian');
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed.config !== 'object') {
          throw new Error('file does not contain a "config" object');
        }
        this.plugin.settings.config = parsed.config;

        // Model folders are local to whoever exported the file — importing
        // a name that doesn't exist here would otherwise point the plugin
        // at nothing until the person noticed and fixed it manually. Kept
        // as its own notice (rather than folded into the main one) since
        // it's the one part of the import that's a *partial* success, not
        // a full one.
        let modelNote = '';
        if (parsed.modelDir) {
          const path = require('path');
          const isAbsoluteAndExists = path.isAbsolute(parsed.modelDir) && require('fs').existsSync(parsed.modelDir);
          const isKnownLocalFolder = this._listModelFolders().includes(parsed.modelDir);
          if (isAbsoluteAndExists || isKnownLocalFolder) {
            this.plugin.settings.modelDir = parsed.modelDir;
            if (typeof parsed.engineOverride === 'string') this.plugin.settings.engineOverride = parsed.engineOverride;
          } else {
            modelNote = ` Model "${parsed.modelDir}" from that file isn't available here — kept your current model selection.`;
          }
        }
        if (Number.isFinite(parsed.numThreads) && parsed.numThreads > 0) this.plugin.settings.numThreads = parsed.numThreads;

        await this.plugin.saveSettings();
        this.plugin.sherpa = null; // in case the model/engine/thread count changed
        this.display();
        new Notice(`PDF-Skim: settings imported.${modelNote}`, modelNote ? 8000 : 4000);
      } catch (err) {
        new Notice(`PDF-Skim: couldn't import that file — ${err.message}`, 8000);
      }
    };
    input.click();
  }

  /** Subfolder names directly under <pluginDir>/models/ — no validation of
   *  contents beyond "it's a directory": if a folder turns out not to be a
   *  usable model, the debug log (pdf-skim-debug.log) explains why when
   *  the user tries to narrate with it, which is more useful than trying
   *  to guess correctness here. */
  _listModelFolders() {
    try {
      const fs = require('fs');
      const path = require('path');
      const modelsDir = path.join(this.plugin.getPluginDir(), 'models');
      if (!fs.existsSync(modelsDir)) return [];
      return fs.readdirSync(modelsDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  _isOutsideModelsFolder() {
    const path = require('path');
    const value = this.plugin.settings.modelDir;
    return !!value && path.isAbsolute(value);
  }

  _modelDropdownDesc() {
    const count = this._listModelFolders().length;
    return count
      ? `Detected ${count} model folder${count === 1 ? '' : 's'} in models/.`
      : 'No model folders detected in models/ yet — see the README for where to download one.';
  }

  // ---- small render helpers ----

  _toggle(containerEl, name, desc, obj, key) {
    const s = new Setting(containerEl).setName(name);
    if (desc) s.setDesc(desc);
    s.addToggle(t => t.setValue(obj[key]).onChange(async (value) => {
      obj[key] = value;
      await this.plugin.saveSettings();
      this.display();
    }));
  }

  _toggleRaw(containerEl, name, desc, obj, key) {
    const s = new Setting(containerEl).setName(name);
    if (desc) s.setDesc(desc);
    s.addToggle(t => t.setValue(obj[key]).onChange(async (value) => {
      obj[key] = value;
      await this.plugin.saveSettings();
    }));
  }

  _number(containerEl, name, obj, key) {
    new Setting(containerEl).setName(name).addText(text => text
      .setValue(String(obj[key]))
      .onChange(async (value) => {
        const n = Number(value);
        if (!Number.isNaN(n)) {
          obj[key] = n;
          await this.plugin.saveSettings();
        }
      }));
  }

  _text(containerEl, name, obj, key) {
    new Setting(containerEl).setName(name).addText(text => text
      .setValue(obj[key] || '')
      .onChange(async (value) => {
        obj[key] = value;
        await this.plugin.saveSettings();
      }));
  }

  _commaList(containerEl, name, obj, key) {
    new Setting(containerEl).setName(name).addText(text => text
      .setValue((obj[key] || []).join(', '))
      .onChange(async (value) => {
        obj[key] = value.split(',').map(s => s.trim()).filter(Boolean);
        await this.plugin.saveSettings();
      }));
  }

  _patternList(containerEl, name, obj, key) {
    new Setting(containerEl).setName(name).addTextArea(area => {
      area.setValue((obj[key] || []).join('\n'));
      area.inputEl.rows = 8;
      area.inputEl.style.width = '100%';
      area.onChange(async (value) => {
        obj[key] = value.split('\n').map(s => s.trim()).filter(Boolean);
        await this.plugin.saveSettings();
      });
    });
  }

  _substitutionsTable(containerEl, entries) {
    const header = containerEl.createEl('div', { cls: 'pdf-skim-substitutions-header' });
    header.createEl('span', { text: 'Match' });
    header.createEl('span', { text: 'Replace with' });
    header.createEl('span', { text: 'Whole word' });
    header.createEl('span', { text: 'Case sensitive' });

    entries.forEach((entry, i) => {
      const row = new Setting(containerEl)
        .addText(text => text.setPlaceholder('match').setValue(entry.match).onChange(async (value) => {
          entry.match = value;
          await this.plugin.saveSettings();
        }))
        .addText(text => text.setPlaceholder('replace with').setValue(entry.replace).onChange(async (value) => {
          entry.replace = value;
          await this.plugin.saveSettings();
        }))
        .addToggle(t => t.setTooltip('Whole word only').setValue(entry.wholeWord !== false).onChange(async (value) => {
          entry.wholeWord = value;
          await this.plugin.saveSettings();
        }))
        .addToggle(t => t.setTooltip('Case sensitive ("RAM" won\'t match "ram" or "Ram")').setValue(!!entry.caseSensitive).onChange(async (value) => {
          entry.caseSensitive = value;
          await this.plugin.saveSettings();
        }))
        .addButton(btn => btn.setIcon('trash').setTooltip('Remove').onClick(async () => {
          entries.splice(i, 1);
          await this.plugin.saveSettings();
          this.display();
        }));
      row.settingEl.style.padding = '6px 0';
    });

    new Setting(containerEl).addButton(btn => btn.setButtonText('Add substitution').onClick(async () => {
      entries.push({ match: '', replace: '', wholeWord: true, caseSensitive: false });
      await this.plugin.saveSettings();
      this.display();
    }));
  }
}

module.exports = { PdfSkimSettingTab };
