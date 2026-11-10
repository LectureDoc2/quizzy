# Quiz Markdown

*Draft specification, 2026-11-05. Nothing in this document is implemented yet.*

Quiz Markdown is a source format for quizzes that is easier to write by hand
than the [Quiz JSON format](README.md#quiz-json-format). A compiler turns it
into Quiz JSON; everything downstream — validation, encryption, the server, the
`<ld-quiz>` component — keeps working on JSON and never sees Markdown.

```
germany-quiz.en.quiz.md ──compile──▶ germany-quiz.en.json ──encrypt──▶ germany-quiz.en.encrypted.txt
```

The syntax is borrowed from [MyST](https://mystmd.org): a question is a MyST
directive, its settings are directive options, a comment is a `%` line.

---

## 1. Goals and non-goals

**Goals**

- **Math without doubled backslashes.** `$\vec{a}$` instead of
  `"\\( \\vec{a} \\)"`.
- **Code as ordinary fenced blocks**, without `\n` and `\"`.
- **Short common cases.** A multiple-choice question is the question, a blank
  line, and a list of options with checkboxes.
- **Every mistake reported at a line of the source file**, and none silently
  compiled into a different quiz.
- **Syntactically MyST**, so editors that highlight MyST highlight quiz files
  too (see §12 for what that does and does not mean).

**Non-goals**

- **Replacing JSON.** JSON remains the format the server accepts; a quiz can
  still be written in JSON directly.
- **New quiz features.** Every construct maps to a field that exists in JSON
  today. The one convenience beyond that, a default `timeLimit` (§5), is
  expanded by the compiler.
- **Rendering.** The compiler neither renders math nor highlights code. It
  passes both through to the server, which already does both (§7). The server
  is not changed and gains no dependency.
- **All of MyST.** Only the subset described here is accepted. Anything else is
  an error, not ignored.

Where this specification says *error*, a later version may give the construct a
meaning. Nothing that compiles under this version will change its meaning.

---

## 2. Files

- Extension **`.quiz.md`**, UTF-8, LF or CRLF line endings. A leading byte
  order mark is ignored.
- The compiled file has the same name with `.quiz.md` replaced by `.json`:
  `germany-quiz.en.quiz.md` → `germany-quiz.en.json`.
- The double extension lets the tools recognise a quiz source, and lets a MyST
  project exclude quiz sources (`project.exclude` in `myst.yml`) should they ever
  sit next to lecture sources.

---

## 3. Example

````markdown
---
title: Germany
timeLimit: 30
---

% Warm-up question; deliberately easy.
::::{multiple-choice}
What is the capital of Germany?

:::{options}
* [ ] Cologne
* [ ] Munich
* [x] Berlin
:::
::::

::::{multiple-choice}
:timeLimit: 45
Which of these equal $\sqrt{4}$? (Several answers are correct.)

:::{options}
* [x] $2$
* [ ] $-2 \cdot -1 \cdot -1$
* [x] $\frac{8}{4}$
:::
::::

::::{short-answer}
:match: strict
Please calculate: $2 + 4 \cdot 5$

:::{answers}
* 22
:::
::::

::::{short-answer}
Same name, different parameter lists: what is this called?

:::{answers}
* Overloading [of Methods]
* Method Overloading
* Überladen [von Methoden]
:::
::::

::::{estimation}
:answer: 84.5
:timeLimit: 45
How many people live in Germany (in millions)?
::::

::::{ordering}
Order by length, shortest first:

:::{options}
* `Foo`
* `Foo?`
* `Foo :-)`
:::
::::

::::{multiple-choice}
What does this print?

```java
void main() {
    IO.println(1 / 2);
}
```

:::{options}
* [x] `0`
* [ ] `0.5`
* [ ] It does not compile
:::
::::
````

---

## 4. File structure

A file consists of

1. optional front matter (§5), then
2. one or more questions (§6), in the order in which they are asked.

Between and around questions only **blank lines** and **comment lines** are
allowed. A comment line starts with `%` (MyST's comment syntax) and is dropped by
the compiler, wherever it appears. A `%` line inside a code block or a `<pre>`
element is code, not a comment.

Any other text outside a question is an error. A question whose opening line is
mistyped must not disappear without a word, and neither may a heading the author
believes to be the quiz title.

---

## 5. Front matter

```markdown
---
title: Lineare Algebra
secret: jzi9hnfn6cqO/h7HklslsI9/ijrGVJKm
recordNamedResults: false
timeLimit: 30
---
```

- Starts on the **first line** of the file and ends at the next line consisting
  of `---`.
- One `key: value` per line. Blank lines and lines starting with `#` are
  ignored.
- It is valid YAML, but the compiler reads only this flat form, and it takes a
  value's type from the key, not from YAML's guessing: `title: 1.10` is the
  string `"1.10"`, not the number 1.1. Nested values, lists, multi-line strings
  and anchors are errors.
- A value in double quotes follows JSON string syntax, for the rare title that
  needs leading spaces or a `"`. Otherwise the value is the rest of the line,
  with surrounding whitespace removed. Unlike YAML, there are no trailing
  comments: `title: Quiz #1` is the title `Quiz #1`.

| Key | Value | JSON |
|---|---|---|
| `title` | plain text, shown as written: no Markdown, no math | `title` |
| `secret` | text | `secret` |
| `recordNamedResults` | `true` or `false` | `recordNamedResults` |
| `timeLimit` | seconds, or `none` | not itself in the JSON: copied into every question that does not set its own |

Any other key is an error.

---

## 6. Questions

### 6.1 The directive

```markdown
::::{multiple-choice}
:timeLimit: 45
Question text …

:::{options}
…
:::
::::
```

- **Opening line:** three or more colons, then `{type}`, at the start of the
  line. `type` is `multiple-choice`, `short-answer`, `estimation` or
  `ordering`. Text after `{type}` (MyST's directive *argument*) is an error: the
  question text goes on lines of its own.
- **Closing line:** colons only, at least as many as the opening line, at the
  start of the line; trailing whitespace is ignored.
- A question containing a block (§8) **must open with more colons than the
  block**. Otherwise the block's closing line would close the question. The
  convention throughout: **four colons for a question, three for a block** —
  estimation questions included, so that all questions look alike.
- An unclosed question is an error, reported at its opening line rather than at
  the end of the file.

Colons rather than backticks (MyST's other directive fence), because question
texts contain code fences and a colon fence does not compete with them.

### 6.2 Options

Lines of the form `:name: value` directly after the opening line. The first line
that is not of this form ends the options.

| Option | Questions | Value | JSON |
|---|---|---|---|
| `timeLimit` | all | seconds (a non-negative number), or `none` | `timeLimit`; `none` leaves it out, so the presenter ends the question — also overriding a default from the front matter |
| `match` | short-answer | `fuzzy`, `strict` or `exact` | `match` |
| `answer` | estimation (required) | a number | `correctAnswer` |

- **Numbers** are written like `84.5`, `-3` or `6.022e23`. Underscores between
  digits are allowed for readability (`84_500_000`). A decimal comma (`1,41`) is
  an error, with a hint to write `1.41`.
- An unknown option, an option that does not apply to the question's type (for
  example `match` on an estimation question) and a repeated option are errors.
- `timeLimit` and `match` keep their JSON names, so that the validator's
  messages apply word for word. `answer` is shorter than `correctAnswer`, and
  the compiler checks it itself.

### 6.3 The body

Everything after the options up to the block — or up to the closing line, for
estimation — is the **question text**, written in Markdown (§7). It must not be
empty.

| Type | Body |
|---|---|
| `multiple-choice` | text, then an `{options}` block with checkboxes (§8.1) |
| `ordering` | text, then an `{options}` block in the correct order (§8.2) |
| `short-answer` | text, then an `{answers}` block (§8.3) |
| `estimation` | text only; the answer is the `:answer:` option |

- The block is the **last thing** in the question. Text after it is an error.
- A question has **exactly one** block. A block of the wrong kind (`{answers}` in
  a multiple-choice question) is an error that names the right one.

The block is explicit because "the last list in the question" would not work:
two bullet lists with the same marker, separated only by a blank line, are a
single list in Markdown. A question text ending in a list would silently gain
its items as options.

---

## 7. Question text and option text

Question text and multiple-choice and ordering options are Markdown and are
compiled to HTML, the form the JSON already uses. Accepted answers of
short-answer questions are not (§8.3).

### 7.1 Markdown

- **CommonMark, plus GFM tables and strikethrough** (markdown-it's default
  preset, with raw HTML enabled). Typographic replacements and automatic links
  are off: text arrives as written, so `--` stays `--` and `"` stays `"`.
- **Raw HTML** is allowed and passed through unchanged, exactly as in JSON today;
  the server's sanitizer applies as before. CommonMark's rules for HTML blocks
  apply: a block that starts with `<pre` may contain blank lines, most other HTML
  blocks end at the first blank line.
- **Single paragraph, no `<p>`.** Text that is a single paragraph compiles to its
  inline HTML without a `<p>` wrapper, which is what one writes in JSON today.
  Anything else — several paragraphs, a paragraph and a code block, a list, a
  table — compiles to block HTML.
- **MyST roles** (`` {math}`x` ``, `` {code}`x` ``) are an error. markdown-it
  does not know them and would show `{math}` as text.

### 7.2 Math

- Delimiters are the server's: `$…$`, `$$…$$`, `\(…\)` and `\[…\]`. `$` and `$$`
  are recommended: they are MyST's, and the shortest.
- Math is located **before** Markdown is parsed and emitted unchanged, byte for
  byte, into the JSON, where the server renders it with KaTeX as today. Markdown
  has no effect inside math: `$a*b*c$`, `$\{x \mid x > 0\}$` and
  `$$\begin{pmatrix} a \\ b \end{pmatrix}$$` arrive as written. Without this
  step, CommonMark would read `\{` and `\\` as escapes, `*b*` as emphasis, and
  `\(` as a literal parenthesis.
- Code is set aside **before** math is located, as on the server: fenced
  blocks, code spans, and `<pre>` and `<code>` elements written as HTML. In
  `` `echo $PATH` `` the `$` is code.
- Delimiters are paired the way the server pairs them (`math-renderer.js`), so
  the region the compiler protects is the region the server renders.
- **Math must not span a blank line.** That is almost always a stray dollar sign
  (`costs $5 … and $10`) and is an error. A blank line inside a formula would be
  a LaTeX error anyway.
- **A literal dollar sign** is written `\$`. The compiler emits `&#36;`, which
  neither the sanitizer nor the math renderer reads as `$`, and which the
  browser shows as `$`.

### 7.3 Code

- **Fenced code blocks** use three or more backticks, with the language after
  the opening fence, as described in [Code blocks](README.md#code-blocks); the
  same language names apply.
- **MyST code directives**, ```` ```{code} java ```` and
  ```` ```{code-block} java ````, are accepted and written to the JSON as
  ```` ```java ````. This matters: the server reads ```` ```{code} java ```` as a
  block without a language, and shows it unhighlighted without a warning. MyST
  options inside such a block (`:linenos:`, `:emphasize-lines:`) are an error.
- **Tilde fences** (`~~~`) are an error; the server does not recognise them.
- Fences are emitted into the JSON **unchanged**, on lines of their own, with
  the indentation of a list item removed when the block sits in an option. The
  server finds and highlights them there. The compiler does not turn them into
  `<pre><code>`: hand-written `<pre><code>` gets no highlighting.
- An **unknown language** is a warning, from the same list of names the server
  uses.
- **Inline code** `` `x` `` compiles to `<code>x</code>`, with `&`, `<` and `>`
  escaped. The server's math pass skips `<code>`.

---

## 8. Blocks

A block is opened by a line of colons followed by `{options}` or `{answers}`,
and closed by a line of at least as many colons (§6.1). Inside a block only the
list, blank lines and comment lines are allowed. Lists use `*`, `-` or `+` as
bullet markers; numbered lists are an error.

### 8.1 `{options}` in a multiple-choice question

```markdown
:::{options}
* [ ] Cologne
* [x] Berlin
* [x] $\sqrt{4} = 2$
:::
```

- Every item starts with a **checkbox** followed by a space: `[ ]` or `[]` for
  a wrong option, `[x]` or `[X]` for a correct one. An item without a checkbox
  is an error.
- **At least one** option is checked. Several make the question multi-select;
  `correctIndices` lists all of them, in order. No checked option is an error:
  JSON accepts an empty `correctIndices`, but it is almost certainly a forgotten
  `[x]`, so this format offers no way to write it.
- An item's text is Markdown (§7): inline formatting, math, and code blocks on
  indented continuation lines.

  ````markdown
  * [x] It prints `0`, because

    ```java
    1 / 2
    ```

    is integer division.
  ````

- Blank lines between items change nothing. In CommonMark they would make the
  list "loose" and wrap every item in `<p>`. Here each item follows §7.1's
  single-paragraph rule instead.
- The validator's limits apply: 2 to 26 options.

### 8.2 `{options}` in an ordering question

- The same list, **without checkboxes**, items **in the correct order**.
  Participants get them shuffled. A checkbox is an error: "ordering options have
  no checkboxes; list them in the correct order".
- Items are Markdown, as in §8.1.
- The validator's limits apply: 2 to 10 items, all different.

### 8.3 `{answers}` in a short-answer question

```markdown
:::{answers}
* Overloading [of Methods]
* Method Overloading
* int\[\]
:::
```

- One item per line. The accepted answer is the line's text after the bullet
  marker and one space, with trailing whitespace removed, **taken as it is**:
  not Markdown, no math, no HTML. Exactly that string goes into
  `acceptedAnswers`.
- The rules of [`acceptedAnswers`](README.md#quiz-json-format) therefore apply
  unchanged, minus JSON's own escaping: `[…]` marks an optional part, `\[` and
  `\]` are literal brackets, `\\` is a literal backslash. Compare an answer from
  `java-einfuehrung-quiz.de.json`:

  | JSON | Quiz Markdown |
  |---|---|
  | `"int\\[\\]"` | `* int\[\]` |
  | `"Ein \\\" und ein \\\\\\\\"` | `* Ein \" und ein \\\\` |

- Continuation lines are an error; an accepted answer is a single line. So is an
  empty item.
- The validator's limits apply: 1 to 50 answers of at most 200 characters.

The answers are taken raw because CommonMark would drop the backslash from `\[`
and could read `[of Methods]` as a link.

---

## 9. Mapping to JSON

| Quiz Markdown | JSON |
|---|---|
| front matter `title`, `secret`, `recordNamedResults` | the same top-level properties |
| front matter `timeLimit` | each question's `timeLimit`, unless it sets its own |
| `{type}` on the opening line | `type` |
| the body before the block | `text` |
| `:timeLimit:` | `timeLimit` (`none`: property left out) |
| `:match:` | `match` |
| `:answer:` | `correctAnswer` |
| `{options}` items, multiple-choice | `options` |
| positions of the `[x]` items | `correctIndices` (zero-based) |
| `{options}` items, ordering | `options`, in source order |
| `{answers}` items | `acceptedAnswers`, in source order |

The JSON is written with two-space indentation, top-level properties in the
order `title`, `secret`, `recordNamedResults`, `questions`, and question
properties in the order `type`, `text`, `options`, `correctIndices`,
`correctAnswer`, `acceptedAnswers`, `match`, `timeLimit`. A property appears only
when the source sets it. A stable order keeps the diffs of compiled files
readable.

The compiled quiz is passed to `validateQuiz`. The compiler never writes a JSON
file that the validator rejects.

---

## 10. Errors and warnings

Errors come from two layers:

1. **The compiler's own checks**, the errors described in §§4–8.
2. **`validateQuiz`** on the compiled quiz: limits, distinct ordering items,
   the optional-part syntax of accepted answers.

Both are reported against the **source line**, in the form `validate-quiz.js`
already uses:

```
✗ germany-quiz.en.quiz.md
    line 14: question 3: match only applies to short-answer questions.
      14 | :match: fuzzy
         | ^
```

Validator messages name a JSON path (`question 3, option 2: …`). The compiler
records, for every path it writes, the source line it came from: a question's
opening line, the first line of its text, the line of an option or list item.
Each message is then mapped through `quizMessagePath`, as `locateQuizMessages`
does for JSON. As in the validator, up to 20 errors are reported per file, and
compilation continues after an error wherever the structure still makes sense.

Some of the compiler's own messages:

| Situation | Message (wording not final) |
|---|---|
| `::::{multiple-choise}` | unknown question type "multiple-choise"; did you mean "multiple-choice"? |
| question never closed | this question is never closed; close it with a line of at least 4 colons |
| `::::` reached while `:::{options}` is open | the {options} block opened at line 9 is not closed; close it with `:::` before the question ends |
| `:::{multiple-choice}` containing `:::{options}` | open the question with more colons than its {options} block: `::::{multiple-choice}` |
| `:match:` on an estimation question | match only applies to short-answer questions |
| `:answer: 1,41` | answer must be a number; write 1.41, with a decimal point |
| option without checkbox | every option needs a checkbox: `[ ]` or `[x]` |
| no `[x]` | none of the options is marked correct with `[x]` |
| checkbox in ordering | ordering options have no checkboxes; list them in the correct order |
| text after the block | nothing may follow the {options} block in a question |
| text between questions | text outside a question; is a question's opening line mistyped? |
| `$` across a blank line | this formula runs across a blank line; for a dollar sign, write `\$` |
| `~~~` fence | write code blocks with backticks; the server does not recognise `~~~` |

**Warnings** do not stop compilation: an unknown code language, and — as
`validate-quiz.js` does today — a quiz without a `secret`.

---

## 11. Tools

- **`node tools/compile-quiz.js <file.quiz.md> [more …] [--check]`** writes the
  `.json` next to each source. `--check` compiles and validates without writing,
  for CI. Exit codes as in `validate-quiz.js`: 0 usable, 1 invalid, 2 wrong
  invocation.
- **`validate-quiz.js` and `encrypt-quiz.js`** accept a `.quiz.md` directly and
  compile it in memory, so encrypting needs no intermediate JSON file.
- The compiler is **one module without Node imports**,
  `packages/server/src/quiz-markdown.js`, like `short-answer.js` and
  `quiz-validator.js`, so that `/tools.html` can bundle it too.
- **Dependency:** `markdown-it`, for the Markdown inside question text and
  options. The structure — front matter, directives, options, `{answers}` — is
  parsed line by line by the compiler itself. Only the authoring tools load
  `markdown-it`; the server's pipeline does not change.

---

## 12. Relationship to MyST

Every quiz file is **syntactically** valid MyST: a MyST parser reads its
directives, options, code fences, `$` math and comments the same way. That is
what makes editor support work. It is not a promise that a MyST site renders a
quiz file meaningfully:

- `{multiple-choice}` and the other question types are unknown directives to
  `mystmd`, which warns about them.
- `\(…\)` and `\[…\]` are not math in MyST, where they are escaped parentheses
  and brackets. They work in quiz files because the server renders them, but
  `$` and `$$` are the portable choice.
- The format is a strict subset: no directive arguments, no YAML option blocks,
  no roles, no tilde fences.

Compiling quiz directives that are embedded in lecture sources, through a
`mystmd` plugin in LectureDoc2's build, is a possible later step and not part of
this specification.

---

## 13. Migrating existing quizzes

**`node tools/quiz-to-markdown.js <quiz.json>`** writes `<name>.quiz.md` next to
the JSON file:

- JSON escaping is undone; math is carried over unchanged, delimiters included.
- HTML stays HTML, except that `<code>…</code>` containing no markup becomes a
  code span. Every `<pre` is preceded by a blank line and starts a line of its
  own, so that CommonMark treats it as an HTML block that runs to `</pre>`, blank
  lines included. Without this, the `<pre>` blocks in
  `java-konzepte-quiz.de.json`, which follow a `<p>…</p>` on the same line, would
  be part of an HTML block that ends at the first blank line in the code. The
  rest of the code would then be read as Markdown.
- A fenced block inside `text` becomes a fenced block on lines of its own.

**Acceptance test.** For each of the ten quizzes under `quizzes/`, converting,
compiling and validating succeeds, and every question produces equivalent HTML
after the server's pipeline (`prepareQuiz`) to the original. The only accepted
differences are `<p>` wrappers around texts made of several blocks, whitespace
between block elements, and characters escaped as entities (`<<` inside a code
span becomes `&lt;&lt;`).

---

## 14. Open questions

1. **Default `timeLimit` in the front matter.** All 230 questions in `quizzes/`
   set a time limit, 30 seconds most often (66 of them). The default is the one
   feature JSON does not have. Keep it?
2. **Headings between questions.** They are an error under §4. Allowing them as
   section markers for the author, dropped from the JSON, would help with long
   quizzes, and would be a backward-compatible change later.
3. **Converting `\(…\)` to `$…$` in the migration tool.** That would be more
   readable, but the round trip would no longer carry math over byte for byte.
