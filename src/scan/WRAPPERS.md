# Repository-local wrapper resolution

The scanner understands direct `fetch`/`axios` calls (see the compatibility matrix). This
document describes the bounded, additional support for calls made through a small
repository-local wrapper function, or through an `axios.create(...)` instance imported from
another file. It does not change how a direct call is matched, redacted, or reported; it only
widens what can reach a direct call's URL/method/body.

## What counts as a wrapper

A wrapper is one of:

- `function name(...) { ... }`
- `const name = (...) => ...`
- `const name = function (...) { ... }`

whose parameters are plain identifiers (no destructuring, defaults, or rest), and whose body is
**exactly one statement**: `return <expr>;` (a block body), or the arrow's own expression body.
`async`/`return await <expr>` is unwrapped the same way. `<expr>` must itself be a single call
already recognized by the scanner (`fetch`, `node-fetch`/`cross-fetch` import, `axios`,
`axios.create(...)`, `require('axios')`). Anything else in the body — more statements, loops,
conditionals, a spread of an unknown object, recursion, or a call to another local function
instead of directly to the client — means this is not a recognized wrapper; the function and its
internal call are then scanned exactly as before (no `via`, ordinary direct-call rules).

### URL

The call's URL argument inside the wrapper must be exactly one of:

- a wrapper parameter, forwarded as the whole URL, or
- `<base> + <param>` or `` `<base>${param}<suffix>` ``, where `<base>` (and any other template
  text) is a string literal or an immutable module-level constant resolvable without the
  parameter, and `<param>` is exactly one wrapper parameter.

At most one parameter may appear in the URL. `<param> + <base>` (the parameter *first*) is not
supported: a bare leading identifier in a `+`/template join is already treated elsewhere in the
scanner as an **unknown base** (a path-only review hint), and a wrapper does not reinterpret that
same shape as a resolvable path variable — keeping the two conventions aligned is required for
soundness. Anything that transforms the URL (`id.toUpperCase()`, `new URL(dynamic)`, string
methods, etc.) is not recognized.

### Method and body

- The HTTP method may be a literal written inside the wrapper (`{method: 'POST'}`, or an axios
  shorthand call like `api.post(...)`).
- Or the method may come from an **inline literal object passed at the call site**, through a
  config/options parameter that the wrapper forwards **unchanged** as the whole `fetch`
  config / axios config argument (e.g. `function request(url, options) { return fetch(url,
  options); }`). The call site's actual argument for that parameter is read exactly like a
  direct call's config argument (same `method`/`body`/`data`/`baseURL` property rules).
- A request body may also be forwarded directly as its own parameter (optionally through
  `JSON.stringify(param)`), independent of a forwarded config object, e.g.
  `function createUser(url, body) { return fetch(url, { method: 'POST', body:
  JSON.stringify(body) }); }`.

If the method cannot be determined by either path, the wrapper is still recognized, but its call
sites resolve exactly as an unresolved/low-confidence direct call with an unknown method would.

## Scope: same file, or one relative import hop

A wrapper call is resolved when the callee is:

- declared in the same file, or
- imported through exactly one static relative ES import (`import { api } from './http.js'`,
  a default import, or a NodeNext `.js` specifier resolving to `.ts`/`.tsx`/`.mts`/`.cts`,
  including `index` files), or one `const { api } = require('./http')`.

Only the file the scan already loaded (honouring excludes, the symlink refusal, and the
file/size limits) can be the target of that one hop; an import that resolves to a file the
scanner skipped or never read is not resolved. Package specifiers (anything not starting with
`./` or `../`) are never followed. There is no second hop: a function that itself forwards to
another local wrapper (rather than calling `fetch`/`axios` directly) is not a recognized
wrapper, and a plain re-export (`export { api } from './a.js'`) is not a wrapper declaration in
the re-exporting file — so a chain through either is not resolved.

The same one-hop rule also lets a call site reach an **`axios.create({ baseURL: <literal or
immutable constant> })` instance** declared in another file, exactly as if it were declared
locally (`const api = axios.create(...); api.get(url)`).

## Output

Each resolved wrapper call site gets its own `ConsumerUse`:

- `range` is the call site (e.g. `getUser(id)`), in the caller's file — never a position inside
  the wrapper's body.
- `urlExpression`, and any `url`/`query` bindings, are built from the call-site argument text/
  span; a `request-property` binding is only emitted for an inline object literal at the call
  site that the wrapper forwards as the body. `response-property` bindings follow the existing
  response-variable rules applied to the call site's own result, unchanged.
- `via: { name, file, range }` names the wrapper and points at its declaration (`file` is
  repository-relative).
- **Confidence is capped at `medium`**, even when the URL, method and operation would otherwise
  be unambiguous — crossing a wrapper (and, for an import, a file boundary) is strictly less
  certain than a direct call written at the point of use.

Matching to OpenAPI operations, redaction of exported URL expressions, and confidence/resolution
rules otherwise work exactly as for a direct call.

## Duplicates

The single recognized call inside a wrapper's body is still visited like any other call
expression in its file, so it still gets its own `ConsumerUse` (for transparency — e.g. so a
file-level review still shows where the wrapper ultimately calls out). By default that internal
use is resolved exactly like a direct call of the same shape would be — same resolution,
confidence, `operationIds` and findings — because soundness requires never dropping a finding
without proof that it is reported somewhere else.

That internal use's `operationIds` and findings are suppressed (downgraded to
`resolution: 'unresolved'`, `confidence: 'low'`, no `operationIds`, no findings) **only when both
of these can be proven from the file(s) the scan actually read**:

- **The wrapper is not reachable from outside its own file.** No `export` modifier, no
  `export { name }` list, no default export, and no CommonJS `module.exports`/`exports.x`
  assignment of it. An exported wrapper might be called from a file this scan did not read (a
  two-hop import, a re-export, a package consumer, or simply a caller added later), so an
  exported wrapper's internal use is never suppressed, even if this scan finds no importer for it.
- **Every other reference to the wrapper's own binding in its own file is a direct call of it that
  itself resolved (`resolution: 'resolved'`) through this wrapper.** A reference used any other
  way — passed as a value (`handlers.push(getUser)`), stored, re-exported, called indirectly
  (`.call`/`.apply`/`.bind`, a computed call), or a call that itself stayed `partial`/`unresolved`
  (unresolvable arguments, multiple matches, an unconfirmed origin, ...) — means some reachable use
  of the operation is not accounted for by a specific call site's own finding, so suppression does
  not apply and the internal use is left exactly as an unsuppressed (pre-S2-shaped) call would be.

Only when both hold is every real use of the operation provably already covered by a resolved,
`via`-bearing call site's own finding, making the wrapper body's own (necessarily parameter-based,
at-best-`partial`) match pure noise; findings stay keyed per `(change, use)`, so a given operation
and call site is still never counted twice even when suppression does not apply.

## Never-reassigned `let`

Independent of wrappers, a module-local `let` with a literal/resolvable initializer is treated
like a `const` wherever the scanner already resolves constants (URL/base text, method literals,
object literals, wrapper bases), provided it is never, anywhere in the file:

- the target of `=`/compound assignment (`+=`, etc.), including through a destructuring
  assignment (`[a, b] = ...`, `({a} = ...)`),
- the target of `++`/`--`,
- the loop variable of a bare `for (x of ...)`/`for (x in ...)` (i.e. not `for (const x of ...)`),
- or exported (`export let x`, `export { x }`, `export default x`).

A reassignment inside a nested function or closure still counts (the check is file-wide, not
scope-local). A `let` that fails any of these stays exactly as unresolved/dynamic as before.

## Limits

- Wrapper parameters must be plain identifiers — no destructuring, default values, or `...rest`.
- At most one parameter may feed the URL, and it is forwarded to the whole URL, or joined to one
  resolvable base via `+` or a template literal — no multi-parameter URL building.
- No chains: one function wrapping another, or a re-export, is not resolved.
- No axios bare-call overload disambiguation (`axios(url, config)` / `axios(config)`) inside a
  wrapper body — use `fetch`, an axios shorthand method (`api.get(...)`, etc.), or
  `axios.request(config)` instead; the ambiguous bare form is left unresolved like today.
- These rules intentionally favor leaving a wrapper (or one of its call sites) unresolved over
  guessing: soundness over coverage, matching the rest of the scanner.
