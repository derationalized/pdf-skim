# Overview
PDF-Skim narrates PDF documents, using the fully offline *Sherpa-ONNX* text-to-speech synthesis engine. The engine is completely independent of the user's operating system and thus compatible with Windows and Linux (support for macOS can be added, see end of document for instructions). Most narration utilities focus on verbosity, speaking every word, number, and character parsed by its engine. This approach is insufficient for highly technical material such as:
— dissertations
- conference papers
- journal articles
- engineering textbooks
Material of this nature often contains a wealth of information which interrupts sentence flow when verbalized, such as:
- headers and footers full of publishing information
- tables, figures, graphs, or blocks of example code
- lengthy inline citations
- equations
- shorthand / technical acronyms
- lists
PDF-Skim filters out these distractions, resulting in a narration that is more natural and coherent when dealing with technical material. This allows users to "skim-over" research material while simultaneously working on other tasks. Pressing a customizable hotkey will insert a link to the current page in the active note, effectively bookmarking a passage to return to later for more in-depth study. This plugin is designed with this goal in mind; To aid professionals and students in technical fields sift through material to find pertinent information more quickly than thorough a read-through yet more accurately than keyword searching.

---

# Installation
1. Copy the **pdf-skim** plugin folder into "<your vault>/.obsidian/plugins/".
2. Download *Sherpa-ONNX* voice model(s) from: [https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models]
3. Move downloaded voice model(s) into "<your vault>/.obsidian/plugins/pdf-skim/models". **Note:** *Only a single copy of each voice model is needed on dual-boot systems or using shared vaults: models are shared between all OS-specific backends.*
4. Restart Obsidian, then enable the plugin in **settings**.
5. In **settings**, the **Model folder** dropdown auto-detects models present in the "/pdf-skim/models" subdirectory. **Note:** *An absolute-path field is also provided to specify a model residing elsewhere on your system.*
6. Configure filtering, word replacements, inserted pauses, and other options in *settings*.

---

# Usage
Click the PDF-Skim icon in the left ribbon (or run **PDF-Skim: Open player panel**) to open its control panel.

## Panel Controls
Each of the panel's controls can be bound to a hotkey:
- **Page number edit box:** starts narration from specified page number.
- **Beginning:** starts narration from the top of the document.
- **Current page:** starts narration from the page currently viewed.
- **Cursor:** starts narration from whatever text is currently *selected* in the PDF.
- **Selection only:** narrates *only* the currently-selected text, then stops. This *does not* effect the sentence scrubber position. Pressing the **return to document** button will return the playback to the previous sentence scrubber position.**Note:** *This can help with narrating texts using multi-column layouts by simply selecting the column to narrate.*
- ***Resume*:** starts narration from the last played position in the current PDF, picking up narration where you left off **Note:** *This can be toggled in* ***settings.***
- **Pause narration**, **Stop narration:** self-explanatory.
- **Jump to next / previous heading:** seeks to the next / previous section heading detected.
- **Skip to next / previous sentence:** skips to the next / previous sentence.
- ***Page scrubber*:** displays current page being narrated and can be dragged.
- A one-line preview of the current sentence is shown under the scrubber.
- **Speaker:** selects from the different speaker voices if the current TTS model has multiple voices.
- **Insert link to current passage:** inserts a link to the current passage being read into the current / last opened note. Useful for flagging sections for later review without stopping playback. **Note:* *A note must be open in the workspace; This will* ***not*** *create a new note to link into.*

---

# Configuration

All plugin configuration settings can be imported / exported to a file for quick recall, using the buttons at the top of the settings page.

### Debug mode
Displays a text box in the control panel containing the narrated text along with any text substitutions, pauses, or other decisions made by the plugin. **Note:** ***Does not*** *change what is actually sent to the speech engine. Useful for tuning settings against actual documents.*

### Speech engine
- **Model folder:** auto-detected from "pdf-skim/models/". **Note:** *Only fill in the absolute-path field if you need to load a model from outside the plugin directory.*
- **Engine override:** override speech model auto-detection. **Note:** *This may be needed for some Kitten models, which look identical to Kokoro models on disk.*
- **Synthesis threads:** sets the number of CPU threads to use for speech synthesis.
- **Speaking speed:** self-explanatory.
- **Remember playback position:** enables resuming PDF narration between Obsidian restarts by saving the last played position for each PDF.

### Whole-document filtering
- **Stop at References / Bibliography:** cuts narration off once a heading resembling a list of references is reached.
- **Remove repeated headers / footers:** drops short lines (running headers, journal names, page numbers) that repeat across many pages.
	- **Repetition threshold:** the fraction of pages a line must appear on to count.
- **Remove boilerplate lines:** drops lines matching customizable regular expression patterns. **Note:** *This can be used to remove DOIs, copyright notices, etc.*
	- **Boilerplate patterns:** regular expressions to use: one per line, case-insensitive.

### Headings
- **Announce section numbers:** numbered headings are read preceded with "section". **Example:** *"3.2 Related Work" is read as "Section 3.2 Related Work".*
	- **Pause after section number:** time in miliseconds to pause between announcing a section number and its heading title.

### Filter figures / tables / listings
- **Filter figure / table / listing captions:** — applies to both a caption on its own line and an inline reference like "(see Fig. 3)".
- **Standalone caption handling:** similar to above but specifically for isolated captions.
- **Keywords:** figures, tables, listings, and other items to skip past are detected using this customizable list of comma separated words.
- **Replacement text:** text to insert when a table / figure / listing is encountered. Leave blank to not insert any text. **Note:** *Can be useful in conjuction with the* ***Insert link to current passage*** *button for detecting important graphical information to refer back to for later study.*
- **Filter detected table rows:**  heuristically detects table rows by looking for unusually wide gaps between text runs on a line that is repeated across several consecutive lines. Will *not* catch tables with sparse or irregular spacing.
- **Replacement text:** same as figure replacement text option except explicitly for table rows.

### Bracketed asides & citations
- **Parentheses, square brackets, and curly braces:** each configured independently.
- **Minimum words to cut:** leaves text intact if the number of words within the parentheses / brackets / braces do not meet the length threshold.
- **Always strip if citation-shaped:** additionally cuts anything matching a citation pattern *(e.g. "(Smith et al., 2020)" or "[12–15]")* regardless of its word count.
- **Replacement text:** same as figure replacement text option except explicitly for parentheses, brackets, and braces.

### Pause timing
- **Insert structural pauses:** time in miliseconds to insert between paragraphs, before / after headings, between list items, etc. **Note:** *Enabling the* ***debug mode*** *setting can make fine-tuning the pause times much easier. Used in conjuction with a high-quality voice model, this can create some very natural sounding narration.*
- **Insert pauses at punctuation:** time in miliseconds to pause when encountering certain punctuation marks separate from the structural pause times. **Note:** *Turn this on if sentences collide or narration feel rushed even with a good voice model. The* ***before an opening bracket*** *timings only matter for bracketed text you've chosen to keep rather than cut.*

### Pronunciation & abbreviation substitution
- **Match:** text edit box specifying target word or string.
- **Replace with:** text edit box specifying the string to replace the target word with.
- **Whole word:** require a strict matching for a replacement to occur.
- **Case sensitive:** requires case to match target word **exactly** for a replacement to occur.
**Note:** *This feature can be used for more than expanding abbreviations and acronyms. This feature is also effective at fixing technical terms and other words frequently butchered by the speech synthesis engine.*

---

# Known Limitations
Extracting clear information indicating headings, lists, etc. from a PDF is inherently heuristic; PDFs encode positioned text, not document structure. This plugin infers structure from font size, indentation, and line spacing. It generally works well on single-column technical papers and textbooks. That said, there are a few known issues:
- **Two-column layouts:** lines from both columns can get interleaved if their y-coordinates overlap. While "Play only selected text" can help workaround this, it does not fully fix this issue.
- **Tables not always caught:** the wide-gap heuristic (see "Configuration") needs at least a few consecutive rows with clearly separated columns in order to detected a table. Tables with few rows or with narrow column margins will likely be undetected and read as an ordinary paragraph.
- **Scanned / image-only PDFs:** these files require separate OCR text extraction not implemented in this plugin. PDFs orginally scanned from images then pre-processed through an OCR text extraction can produce erratic text, resulting in garbled speech output. Images containing slanted pages or skewed lines of text are prone to this behavior.

If narration reads a section badly, try adjusting boilerplate patterns, caption keywords, or bracket settings.

---

# For developers
See [CONTRIBUTING.md](CONTRIBUTING.md) for build instructions.

---

# Adding macOS Support
The plugin does not come with a native speech engine for macOS in "/modules/mac-x64/". Support for macOS can be added using the following step:

1. After step 1 of the regular installtion steps, install [Node.js](https://nodejs.org)
2. ```
   mkdir sherpa-tmp && cd sherpa-tmp
   npm init -y
   npm install sherpa-onnx-node
   ```
3. This produces a "node_modules" folder containing "sherpa-onnx-node" and either "sherpa-onnx-darwin-x64" (Intel) or "sherpa-onnx-darwin-arm64" (Apple Silicon). Copy **both** folders into "pdf-skim/modules/mac-x64/"
4. Copy your Mac's own "node" binary *(run "which node" to find it, or use the one from step 1's Node.js install)* into "pdf-skim/modules/mac-x64/node" alongside the two folders from step 3.
5. Return to regular installation, step 2 to finish installation process.

---

## Disclosures

PDF-Skim runs entirely offline — no network requests are made, and no
data leaves your machine.

To do this, it forks a local, standalone Node.js process (bundled with
the plugin, separate from Obsidian's own process) that runs an offline
speech-synthesis engine (Sherpa-ONNX). This process reads voice model
files from disk and writes a small debug log to disk — both stored inside
the plugin's own folder, outside the note content Obsidian normally
manages. This is required for real-time, on-device text-to-speech and
isn't something a plugin restricted to only reading/writing your vault's
notes could do.

No telemetry, no ads, no account or payment of any kind.

---

# License
Released under the GNU GPL General Public License. Source code of this plugin may be copied, distributed, and used free of charge provided that it or any derivative works remain under the GNU GPL license.
(C) 2026 David Fischer
mailto: drfh7c@umsystem.edu
