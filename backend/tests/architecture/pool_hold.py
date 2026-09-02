"""Read the source tree and say, for every route, what it dials while holding a connection.

A ``Session`` autobegins on its first query and keeps the connection it checked
out there until something commits, rolls back or closes. Every ``await`` in
between is therefore paid for in pooled connections, and an ``await`` that talks
to a language model, a mail server or a licence API is paid for at that
provider's latency. The engine takes SQLAlchemy's defaults, so fifteen of those
at once and the sixteenth request to *any* database-backed endpoint blocks at
checkout.

The structural fact that makes this blameless at every site: ``get_current_user``
runs a token-revocation SELECT on every authenticated request. No handler ever
begins clean. So the question is never "did this handler open a transaction" --
it is always "did anything release it before the dial", and the answer lives in
a chain of calls three or four modules deep that no reviewer reads end to end.

**Why static, when a running observer exists beside it.** The observer records
what a test actually drove. It is exact about the sites it reaches and silent
about every other one, and silence reads as health. Two rows fixed by the
observer's own pull request sat on a branch nothing in the backend suite drives:
the lane had to construct that branch by hand, with three environment variables
and a monkeypatched builder, in order to watch a defect the analyser had already
pointed at. This module answers the complementary question -- *was this site
examined at all* -- across every route, whether or not a test reaches it.

**What it cannot see, stated plainly rather than papered over.** A dial behind a
callable parameter (``await runner(client.handshake)``) is invisible: the callee
is decided at the call site by an argument this analysis does not track. A second
dynamic-dispatch registry gets a free pass the way ``generate_response`` would,
were it not declared a leaf by hand. A new protocol verb is simply not a dial
until somebody adds it to :data:`DIAL_METHODS`, and a new transport library is
not a transport until somebody adds it to
:data:`TRANSPORT_LIBRARIES` -- both are guarded by drift tests that fail asking
for a decision rather than by inference. These are the reasons the analyser is
one of two instruments and not the only one.

Stdlib ``ast`` only: it never imports the application, never opens a database and
never runs a handler. It parses text, so its failure mode is a red test naming a
module, not a broken app.
"""

from __future__ import annotations

import ast
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

# ---------------------------------------------------------------------------
# What counts as reaching the network
# ---------------------------------------------------------------------------

# Constructors whose instances *are* a socket. Any method called on a name bound
# to one of these is a dial, whatever the method happens to be called, because
# the object cannot do anything that is not I/O.
TRANSPORT_CONSTRUCTORS = frozenset(
    {
        "httpx.AsyncClient",
        "httpx.Client",
        "openai.AsyncOpenAI",
        "anthropic.AsyncAnthropic",
        "aiosmtplib.SMTP",
    }
)

# Libraries whose mere import means a module can reach the network on its own
# account. Not used to find dials -- used by the drift test, which fails on a
# module that imports one of these and is not already understood, so a new
# transport arrives as a question rather than as silence.
TRANSPORT_LIBRARIES = frozenset(
    {
        "aiohttp",
        "aiosmtplib",
        "anthropic",
        "asyncpg",
        "boto3",
        "httpx",
        "openai",
        "redis",
        "requests",
        "smtplib",
        "socket",
        "websockets",
    }
)

# Modules every one of whose functions dials.
DIAL_MODULES = frozenset({"aiosmtplib", "smtplib"})

# Fully qualified functions that dial.
DIAL_QUALIFIED = frozenset({"socket.getaddrinfo"})

# Methods on an ``httpx`` client that put a request on the wire. Constructing the
# client does not; ``build_request`` and ``close`` do not.
HTTP_VERBS = frozenset(
    {"delete", "get", "head", "options", "patch", "post", "put", "request", "send", "stream"}
)

# Functions whose dial no import graph can reach, declared with the reason.
# ``generate_response`` dispatches through ``globals()[spec.call_name]``, so the
# edge from it to the provider call exists only at runtime. Declaring it is the
# honest move; inferring it is not available.
DECLARED_LEAVES: Mapping[str, str] = {
    "services.botmason.generate_response": (
        "dispatches through globals()[spec.call_name], so no import edge reaches "
        "the provider call it makes"
    ),
}

# Calls that run their first argument somewhere else. Resolved through rather
# than treated as leaves: without this, a CPU-bound hash and a blocking socket
# send look identical from the call site.
TRAMPOLINES = frozenset({"asyncio.to_thread", "anyio.to_thread.run_sync"})

# Method names that are a dial when called on any receiver, mapped to the
# protocol in this source tree that declares them. The mapping is what the
# collision test asserts against: a name here must be defined only inside its
# declared family, or the name is ambiguous and this table is lying.
DIAL_METHODS: Mapping[str, str] = {
    "handshake": "domain.creek_vault.CreekVaultClient",
    "ingest": "domain.creek_vault.CreekVaultClient",
    "upload": "domain.creek_vault.CreekVaultClient",
    "classify": "domain.creek_vault.CreekVaultClient",
    "classify_corpus": "domain.creek_vault.CreekVaultClient",
    "link_corpus": "domain.creek_vault.CreekVaultClient",
    "reflect": "domain.creek_vault.CreekVaultClient",
    "wheel": "domain.creek_vault.CreekVaultClient",
    "send": "services.email.EmailSender",
    "complete": "domain.resonance.ResonanceLLM",
}

# ---------------------------------------------------------------------------
# What counts as opening and releasing a transaction
# ---------------------------------------------------------------------------

# ``get`` is here deliberately. It autobegins exactly as ``execute`` does, and
# leaving it out was a live hole: a handler whose only database touch was
# ``await session.get(User, user_id)`` read as clean while dialling under the
# transaction that call had just opened. It is safe to include because a receiver
# only counts as a session when its annotation resolves to a session type, so
# ``mapping.get(key)`` is never mistaken for this.
SESSION_OPENERS = frozenset(
    {
        "add",
        "delete",
        "exec",
        "execute",
        "flush",
        "get",
        "merge",
        "refresh",
        "scalar",
        "scalars",
        "stream",
    }
)

SESSION_RELEASERS = frozenset({"close", "commit", "rollback"})

# Session classes, by the name they resolve to rather than the name they are
# written as. A module-local ``Db = AsyncSession`` alias resolves into this set
# during construction, so renaming the type cannot blind the analysis.
SESSION_TYPES = frozenset(
    {
        "sqlalchemy.ext.asyncio.AsyncSession",
        "sqlalchemy.orm.Session",
        "sqlmodel.Session",
        "sqlmodel.ext.asyncio.session.AsyncSession",
    }
)

# HTTP methods a route decorator can name.
ROUTE_VERBS = frozenset({"delete", "get", "head", "options", "patch", "post", "put"})

# Transaction state through a function body. ``DEAD`` is the state after a
# ``return`` or ``raise``: the path contributes nothing further, and joining it
# as merely "clean" is how ``if connection is None: return ...`` leaks a still-open
# transaction past an analysis that only tracks two states.
DEAD, CLEAN, OPEN = -1, 0, 1

_LOCALS = ".<locals>."


@dataclass(frozen=True)
class DialSite:
    """One outbound call reached with a transaction open.

    Attributes:
        holder: Qualified name of the function that contains the call.
        dial: What is dialled -- a protocol verb, a transport method, or a
            qualified function name.
        line: Where in ``holder`` the call sits. Present for the failure message
            only, and deliberately not part of any key: a census keyed on line
            numbers goes red on a blank line and trains its readers to edit it
            without reading it.
    """

    holder: str
    dial: str
    line: int


@dataclass(frozen=True)
class HeldDial:
    """A route reaching an outbound call without releasing its connection first.

    This is the census key, and it carries no line number for the reason
    :class:`DialSite` gives.
    """

    route: str
    holder: str
    dial: str


def _module_name(path: Path, root: Path) -> str:
    """Return the dotted name a module under ``root`` is imported by."""
    parts = list(path.relative_to(root).with_suffix("").parts)
    if parts and parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


def _absolutise(module: str | None, level: int, package: str) -> str:
    """Return the absolute target of a possibly-relative ``from ... import``."""
    if not level:
        return module or ""
    base = package.split(".") if package else []
    if level > 1:
        base = base[: len(base) - (level - 1)]
    return ".".join([*base, module]) if module else ".".join(base)


def _import_bindings(node: ast.Import, table: dict[str, str]) -> None:
    """Record what an ``import x`` statement binds in the importing module."""
    for alias in node.names:
        if alias.asname:
            table[alias.asname] = alias.name
        else:
            head = alias.name.partition(".")[0]
            table[head] = head


def _import_from_bindings(node: ast.ImportFrom, package: str, table: dict[str, str]) -> None:
    """Record what a ``from x import y`` statement binds in the importing module."""
    base = _absolutise(node.module, node.level, package)
    for alias in node.names:
        table[alias.asname or alias.name] = f"{base}.{alias.name}" if base else alias.name


def _bindings_of(tree: ast.Module, module: str) -> dict[str, str]:
    """Map every locally bound import name to the qualified thing it names.

    This is the layer a call-shape matcher lacks. ``from x import y as z``
    binds ``z``, and nothing at the call site spells ``y``; resolving ``z``
    through this table makes the two indistinguishable, which is what they are.
    """
    package = module.rpartition(".")[0]
    table: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            _import_bindings(node, table)
        elif isinstance(node, ast.ImportFrom):
            _import_from_bindings(node, package, table)
    return table


def _root_and_attrs(expr: ast.expr) -> tuple[str | None, list[str]]:
    """Split an attribute chain into its root name and the attributes below it."""
    attrs: list[str] = []
    while isinstance(expr, ast.Attribute):
        attrs.append(expr.attr)
        expr = expr.value
    if isinstance(expr, ast.Name):
        return expr.id, list(reversed(attrs))
    return None, list(reversed(attrs))


def _alias_targets(node: ast.stmt) -> Iterator[tuple[str, ast.expr]]:
    """Yield ``(name, value)`` for each simple module-level alias assignment."""
    if isinstance(node, ast.Assign):
        for target in node.targets:
            if isinstance(target, ast.Name) and node.value is not None:
                yield target.id, node.value
    elif (
        isinstance(node, ast.AnnAssign)
        and isinstance(node.target, ast.Name)
        and node.value is not None
    ):
        yield node.target.id, node.value


class SourceTree:
    """Every module under a root, parsed once, with the names each one binds."""

    def __init__(self, root: Path) -> None:
        """Parse ``root`` and index its modules, functions and methods."""
        self.root = root
        self.modules: dict[str, ast.Module] = {}
        self.paths: dict[str, Path] = {}
        for path in sorted(root.rglob("*.py")):
            if "__pycache__" in path.parts:
                continue
            name = _module_name(path, root)
            self.modules[name] = ast.parse(path.read_text(encoding="utf-8"))
            self.paths[name] = path
        self.bindings = {name: _bindings_of(tree, name) for name, tree in self.modules.items()}
        self.functions: dict[str, ast.FunctionDef | ast.AsyncFunctionDef] = {}
        self.owner: dict[str, str] = {}
        self.classes: set[str] = set()
        self.methods_by_name: dict[str, set[str]] = {}
        for name, tree in self.modules.items():
            self._index(tree, name, name, is_class=False)
        self.session_types = self._resolve_session_types()

    @property
    def modules_read(self) -> int:
        """How many modules the walk parsed."""
        return len(self.modules)

    @property
    def functions_read(self) -> int:
        """How many functions, methods and closures the walk indexed."""
        return len(self.functions)

    def _index(self, node: ast.AST, prefix: str, module: str, *, is_class: bool) -> None:
        """Record every function, method and closure reachable from ``node``."""
        for child in getattr(node, "body", []):
            if isinstance(child, ast.FunctionDef | ast.AsyncFunctionDef):
                qualified = f"{prefix}.{child.name}"
                self.functions[qualified] = child
                self.owner[qualified] = module
                if is_class:
                    self.methods_by_name.setdefault(child.name, set()).add(qualified)
                self._index(child, f"{qualified}.<locals>", module, is_class=False)
            elif isinstance(child, ast.ClassDef):
                self.classes.add(f"{prefix}.{child.name}")
                self._index(child, f"{prefix}.{child.name}", module, is_class=True)

    def qualify(self, expr: ast.expr, module: str) -> str | None:
        """Resolve an expression to the dotted name it refers to, through ``module``'s imports."""
        root, attrs = _root_and_attrs(expr)
        if root is None:
            return None
        table = self.bindings[module]
        if root in table:
            head = table[root]
        elif f"{module}.{root}" in self.functions or f"{module}.{root}" in self.modules:
            head = f"{module}.{root}"
        else:
            head = root
        return ".".join([head, *attrs])

    def _resolve_session_types(self) -> frozenset[str]:
        """Return the session classes plus every module-level alias of one.

        Run to a fixpoint so an alias of an alias resolves too. Without this, one
        ``Db = AsyncSession`` at the top of a module makes every session in it
        invisible, and the whole file reads clean.
        """
        known = set(SESSION_TYPES)
        changed = True
        while changed:
            changed = False
            for module, tree in self.modules.items():
                for node in tree.body:
                    changed |= self._record_alias(node, module, known)
        return frozenset(known)

    def _record_alias(self, node: ast.stmt, module: str, known: set[str]) -> bool:
        """Add ``module``'s aliases of an already-known session type to ``known``."""
        added = False
        for name, value in _alias_targets(node):
            qualified = f"{module}.{name}"
            if qualified not in known and self.qualify(value, module) in known:
                known.add(qualified)
                added = True
        return added

    def session_parameters(
        self, func: ast.FunctionDef | ast.AsyncFunctionDef, module: str
    ) -> set[str]:
        """Return the parameter names of ``func`` annotated as a session."""
        names: set[str] = set()
        for arg in self._all_args(func):
            if arg.annotation is None:
                continue
            if any(self._names_a_session(sub, module) for sub in ast.walk(arg.annotation)):
                names.add(arg.arg)
        return names

    def _names_a_session(self, node: ast.AST, module: str) -> bool:
        """Report whether ``node`` is a reference resolving to a session type."""
        if not isinstance(node, ast.Name | ast.Attribute):
            return False
        return self.qualify(node, module) in self.session_types

    @staticmethod
    def _all_args(func: ast.FunctionDef | ast.AsyncFunctionDef) -> list[ast.arg]:
        """Return every parameter of ``func``, in declaration order."""
        args = func.args
        return [*args.posonlyargs, *args.args, *args.kwonlyargs]

    def transport_names(
        self, func: ast.FunctionDef | ast.AsyncFunctionDef, module: str
    ) -> set[str]:
        """Return the names in ``func`` that hold a live transport object."""
        names = {
            arg.arg
            for arg in self._all_args(func)
            if arg.annotation is not None and self._is_transport(arg.annotation, module)
        }
        for node in ast.walk(func):
            names |= self._transport_bindings(node, module)
        return names

    def _transport_bindings(self, node: ast.AST, module: str) -> set[str]:
        """Return names bound to a transport object by one statement."""
        if isinstance(node, ast.With | ast.AsyncWith):
            return {
                item.optional_vars.id
                for item in node.items
                if isinstance(item.context_expr, ast.Call)
                and self._is_transport(item.context_expr.func, module)
                and isinstance(item.optional_vars, ast.Name)
            }
        if not isinstance(node, ast.stmt):
            return set()
        return {
            name
            for name, value in _alias_targets(node)
            if isinstance(value, ast.Call) and self._is_transport(value.func, module)
        }

    def _is_transport(self, expr: ast.expr, module: str) -> bool:
        """Report whether ``expr`` names a transport constructor."""
        qualified = self.qualify(expr, module) or ""
        tails = {name.rpartition(".")[2] for name in TRANSPORT_CONSTRUCTORS}
        return qualified in TRANSPORT_CONSTRUCTORS or qualified.rpartition(".")[2] in tails

    def depends_on(self, func: ast.FunctionDef | ast.AsyncFunctionDef, module: str) -> list[str]:
        """Return the FastAPI dependencies of ``func``, in parameter order.

        A handler's dependencies run before its first line, so the transaction
        one of them opens is already open when the body starts. Seeding the walk
        with them is what makes ``get_current_user``'s revocation SELECT visible
        at every authenticated route, which is the fact the whole class rests on.
        """
        found: list[str] = []
        for arg in self._all_args(func):
            if arg.annotation is not None:
                found.extend(self._depends_in(arg.annotation, module))
        for default in func.args.defaults + [d for d in func.args.kw_defaults if d]:
            found.extend(self._depends_in(default, module))
        return found

    def _depends_in(self, node: ast.expr, module: str) -> Iterator[str]:
        """Yield the resolved callees of every ``Depends(...)`` inside ``node``."""
        for sub in ast.walk(node):
            if not isinstance(sub, ast.Call) or not sub.args:
                continue
            called = self.qualify(sub.func, module) or ""
            if called.rpartition(".")[2] != "Depends":
                continue
            dependency = self.qualify(sub.args[0], module)
            if dependency in self.functions:
                yield dependency


@dataclass
class _Resolution:
    """What one call turns out to be, and the detail worth recording about it."""

    kind: str
    detail: str = ""


class _FunctionWalk:
    """Linearise one function body into transaction states and outbound calls."""

    def __init__(self, analysis: PoolHoldAnalysis, qualified: str, stack: frozenset[str]) -> None:
        """Prepare to walk ``qualified`` with ``stack`` as the recursion guard."""
        self.analysis = analysis
        self.tree = analysis.tree
        self.qualified = qualified
        self.module = self.tree.owner[qualified]
        self.func = self.tree.functions[qualified]
        self.stack = stack
        self.sessions = self.tree.session_parameters(self.func, self.module)
        self.transports = self._inherited_transports()
        parent = qualified.rpartition(".")[0]
        self.owning_class = parent if parent not in self.tree.modules else None
        self.sites: list[DialSite] = []
        self.returns: list[int] = []

    def _inherited_transports(self) -> set[str]:
        """Return transport names from this body and from every enclosing one.

        A closure that dials through a client its enclosing function opened would
        otherwise look like a call on an unknown receiver.
        """
        names = self.tree.transport_names(self.func, self.module)
        outer = self.qualified
        while _LOCALS in outer:
            outer = outer.rpartition(_LOCALS)[0]
            if outer in self.tree.functions:
                names |= self.tree.transport_names(self.tree.functions[outer], self.module)
        return names

    # -- resolving a single call ------------------------------------------

    def _resolve(self, node: ast.Call) -> _Resolution:
        """Classify one call as a session verb, a dial, a call into ``src``, or nothing."""
        callee = node.func
        if isinstance(callee, ast.Attribute):
            receiver = self._receiver_resolution(callee)
            if receiver is not None:
                return receiver
        if isinstance(callee, ast.Name):
            local = f"{self.qualified}.<locals>.{callee.id}"
            if local in self.tree.functions:
                return _Resolution("call", local)
        qualified = self.tree.qualify(callee, self.module)
        if qualified is None:
            return _Resolution("none")
        return self._resolve_qualified(qualified)

    def _receiver_resolution(self, callee: ast.Attribute) -> _Resolution | None:
        """Classify a call written as ``receiver.method(...)``, or return ``None``."""
        root, attrs = _root_and_attrs(callee.value)
        method = callee.attr
        if root in self.sessions and not attrs:
            if method in SESSION_RELEASERS:
                return _Resolution("release", method)
            if method in SESSION_OPENERS:
                return _Resolution("open", method)
        if root in self.transports and method in HTTP_VERBS:
            return _Resolution("dial", ".".join([root, *attrs, method]))
        if root == "self" and not attrs and self.owning_class:
            own = f"{self.owning_class}.{method}"
            if own in self.tree.functions:
                return _Resolution("call", own)
        if method in DIAL_METHODS and root not in self.sessions:
            return _Resolution("dial", method)
        return None

    def _resolve_qualified(self, qualified: str) -> _Resolution:
        """Classify a call by the dotted name its callee resolves to."""
        if qualified in TRAMPOLINES:
            return _Resolution("trampoline", qualified)
        head, _, _ = qualified.partition(".")
        if head == "httpx":
            verb = qualified.rpartition(".")[2]
            return _Resolution("dial", qualified) if verb in HTTP_VERBS else _Resolution("none")
        if head in DIAL_MODULES or qualified in DIAL_QUALIFIED or qualified in DECLARED_LEAVES:
            return _Resolution("dial", qualified)
        if qualified in self.tree.functions:
            return _Resolution("call", qualified)
        return _Resolution("none")

    # -- walking ------------------------------------------------------------

    def _enter(self, callee: str, state: int) -> int:
        """Fold a call into ``callee`` into the current state, keeping its dial sites."""
        if callee in self.stack:
            return state
        exit_state, sites = self.analysis.summarise(callee, self.stack | {callee})[state]
        self.sites.extend(sites)
        return state if exit_state == DEAD else exit_state

    def _record(self, node: ast.Call, dial: str) -> None:
        """Record an outbound call reached with the transaction still open."""
        self.sites.append(DialSite(self.qualified, dial, node.lineno))

    def _through_trampoline(self, node: ast.Call, state: int) -> int:
        """Resolve the function a trampoline runs, rather than treating it as a leaf."""
        if not node.args:
            return state
        inner = self._resolve(ast.Call(func=node.args[0], args=[], keywords=[]))
        if inner.kind == "dial":
            if state == OPEN:
                self._record(node, inner.detail)
            return state
        if inner.kind == "call":
            return self._enter(inner.detail, state)
        return state

    def _call(self, node: ast.Call, state: int) -> int:
        """Fold one call expression into the transaction state."""
        resolved = self._resolve(node)
        if resolved.kind == "open":
            return OPEN
        if resolved.kind == "release":
            return CLEAN
        if resolved.kind == "dial":
            if state == OPEN:
                self._record(node, resolved.detail)
            return state
        if resolved.kind == "trampoline":
            return self._through_trampoline(node, state)
        if resolved.kind == "call":
            return self._enter(resolved.detail, state)
        return state

    def expr(self, node: ast.AST | None, state: int) -> int:
        """Fold an expression, left to right over its sub-expressions."""
        if node is None:
            return state
        for child in ast.iter_child_nodes(node):
            state = self.expr(child, state)
        if isinstance(node, ast.Name):
            local = f"{self.qualified}.<locals>.{node.id}"
            if local in self.tree.functions:
                return self._enter(local, state)
        if isinstance(node, ast.Call):
            return self._call(node, state)
        return state

    def block(self, body: Sequence[ast.stmt], state: int) -> int:
        """Fold a statement list, stopping at the first statement that kills the path."""
        for statement in body:
            if state == DEAD:
                return DEAD
            state = self.stmt(statement, state)
        return state

    def _branch(self, node: ast.If, state: int) -> int:
        """Join the two arms of a conditional toward the more open state."""
        state = self.expr(node.test, state)
        return max(self.block(node.body, state), self.block(node.orelse, state))

    def _loop(self, node: ast.For | ast.AsyncFor | ast.While, state: int) -> int:
        """Fold a loop, running the body twice so a second iteration sees the first's state."""
        header = node.iter if isinstance(node, ast.For | ast.AsyncFor) else node.test
        state = self.expr(header, state)
        once = self.block(node.body, state)
        twice = self.block(node.body, max(state, once))
        return max(state, once, twice, self.block(node.orelse, max(state, once)))

    def _guarded(self, node: ast.Try, state: int) -> int:
        """Fold a ``try``, over-approximating where a handler may be entered from."""
        after_body = self.block(node.body, state)
        entry = max(state, after_body)
        ends = [after_body, self.block(node.orelse, after_body)]
        ends.extend(self.block(handler.body, entry) for handler in node.handlers)
        return self.block(node.finalbody, max(ends))

    def _compound(
        self, node: ast.If | ast.For | ast.AsyncFor | ast.While | ast.Try, state: int
    ) -> int:
        """Fold a statement whose own body is a block."""
        if isinstance(node, ast.If):
            return self._branch(node, state)
        if isinstance(node, ast.Try):
            return self._guarded(node, state)
        return self._loop(node, state)

    def _terminator(self, node: ast.stmt, state: int) -> int:
        """Fold a statement that ends the path, evaluating whatever it carries first.

        The state a ``return`` leaves with is kept separately, because it is an
        exit of the function rather than something the next statement inherits --
        and joining it in the wrong place is how a branch that returns still
        holding a transaction reads clean to its caller.
        """
        if isinstance(node, ast.Return):
            self.returns.append(self.expr(node.value, state))
            return DEAD
        for child in ast.iter_child_nodes(node):
            state = self.expr(child, state)
        return DEAD

    def stmt(self, node: ast.stmt, state: int) -> int:
        """Fold one statement into the transaction state."""
        if isinstance(node, ast.If | ast.For | ast.AsyncFor | ast.While | ast.Try):
            return self._compound(node, state)
        if isinstance(node, ast.Return | ast.Raise | ast.Break | ast.Continue):
            return self._terminator(node, state)
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef):
            return state
        if isinstance(node, ast.With | ast.AsyncWith):
            for item in node.items:
                state = self.expr(item.context_expr, state)
            return self.block(node.body, state)
        for child in ast.iter_child_nodes(node):
            state = self.expr(child, state)
        return state

    def run(self, entry: int) -> tuple[int, list[DialSite]]:
        """Walk the whole function from ``entry`` and return its exit state and dial sites."""
        state = entry
        for dependency in self.tree.depends_on(self.func, self.module):
            state = self._enter(dependency, state)
        fell_through = self.block(self.func.body, state)
        return max([*self.returns, fell_through]), self.sites


@dataclass(frozen=True)
class RouteHandler:
    """One HTTP route and the function that serves it."""

    route: str
    handler: str


def _decorator_verb(decorator: ast.expr) -> tuple[str, ast.expr] | None:
    """Return the HTTP verb a route decorator names, with the decorator call itself."""
    call = decorator if isinstance(decorator, ast.Call) else None
    target = call.func if call is not None else decorator
    if isinstance(target, ast.Attribute) and target.attr in ROUTE_VERBS:
        return target.attr, decorator
    return None


def _decorated_path(decorator: ast.expr) -> str:
    """Return the path literal a route decorator carries, or the empty string."""
    if isinstance(decorator, ast.Call) and decorator.args:
        first = decorator.args[0]
        if isinstance(first, ast.Constant) and isinstance(first.value, str):
            return first.value
    return ""


def _router_prefix(tree: ast.Module) -> str:
    """Return the path prefix every route in this module inherits.

    Routers are built once at module scope with a literal ``prefix=`` keyword, so
    the prefix is readable without running anything. The routes this produces are
    checked against the application's own route table by a test, which is what
    keeps this from quietly drifting into a parallel naming scheme.
    """
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        for keyword in node.keywords:
            if keyword.arg == "prefix" and isinstance(keyword.value, ast.Constant):
                value = keyword.value.value
                if isinstance(value, str):
                    return value
    return ""


class PoolHoldAnalysis:
    """The questions this package exists to answer, over one parsed source tree."""

    def __init__(self, tree: SourceTree) -> None:
        """Prepare an analysis over ``tree``."""
        self.tree = tree
        self._summaries: dict[tuple[str, int], tuple[int, list[DialSite]]] = {}

    def summarise(
        self, qualified: str, stack: frozenset[str] = frozenset()
    ) -> dict[int, tuple[int, list[DialSite]]]:
        """Return ``{entry state: (exit state, dial sites)}`` for one function.

        Two entry states are enough because the lattice has two live values, and
        composing two-point summaries is exact for it -- so the walk follows a
        call chain to whatever depth ``src`` has, at the cost of one memoised
        summary per function per entry state.
        """
        summary = {}
        for entry in (CLEAN, OPEN):
            key = (qualified, entry)
            if key not in self._summaries:
                # Seeded before the walk so a cycle back into this function
                # reads a value rather than recursing forever; the recursion
                # guard in ``_enter`` is what keeps the seed from being wrong.
                self._summaries[key] = (entry, [])
                walk = _FunctionWalk(self, qualified, stack | {qualified})
                self._summaries[key] = walk.run(entry)
            summary[entry] = self._summaries[key]
        return summary

    def dials_held_open(self, qualified: str) -> tuple[DialSite, ...]:
        """Return every outbound call ``qualified`` reaches with a transaction open.

        Entered CLEAN, because a route handler is entered with nothing of its own
        open -- whatever it holds by its first line, it holds because one of its
        own dependencies opened it, and those are walked as part of the summary.
        """
        _, sites = self.summarise(qualified)[CLEAN]
        return tuple(sorted(set(sites), key=lambda site: (site.holder, site.line, site.dial)))

    def route_handlers(self) -> tuple[RouteHandler, ...]:
        """Return every HTTP route in the tree and the function serving it.

        Enumerated by decorator shape anywhere under the root rather than only
        inside ``routers``, because a handler registered from a service module
        would otherwise vanish from the population -- and a population with a
        hole in it is the failure this whole package is about.
        """
        found: set[RouteHandler] = set()
        for module, tree in self.tree.modules.items():
            prefix = _router_prefix(tree)
            for node in ast.walk(tree):
                if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
                    found |= self._routes_of(node, module, prefix)
        return tuple(sorted(found, key=lambda entry: (entry.route, entry.handler)))

    def _routes_of(
        self,
        node: ast.FunctionDef | ast.AsyncFunctionDef,
        module: str,
        prefix: str,
    ) -> set[RouteHandler]:
        """Return the routes one decorated function serves."""
        qualified = f"{module}.{node.name}"
        if qualified not in self.tree.functions:
            return set()
        found = set()
        for decorator in node.decorator_list:
            verb = _decorator_verb(decorator)
            if verb is not None:
                path = f"{prefix}{_decorated_path(verb[1])}"
                found.add(RouteHandler(f"{verb[0].upper()} {path}", qualified))
        return found

    def findings(self) -> frozenset[HeldDial]:
        """Return every ``(route, holder, dial)`` this tree reaches with a connection held."""
        return frozenset(
            HeldDial(entry.route, site.holder, site.dial)
            for entry in self.route_handlers()
            for site in self.dials_held_open(entry.handler)
        )


def analyse_tree(root: Path) -> PoolHoldAnalysis:
    """Parse every module under ``root`` and return an analysis over it."""
    return PoolHoldAnalysis(SourceTree(root))


def backend_source_root() -> Path:
    """Return the ``src`` tree this package analyses in production."""
    return Path(__file__).resolve().parents[2] / "src"
