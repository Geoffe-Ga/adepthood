"""Find every place ``backend/src`` can open a connection, from the source itself (#3065).

The recipient register (:mod:`privacy.recipients`) is only worth what it is
checked against. This sweep reads the tree with :mod:`ast` and reports:

* **dial sites** -- each call to a constructor or function in
  :data:`OUTBOUND_CONSTRUCTORS` (HTTP clients and transports, provider SDK
  clients, SMTP sessions, the error monitor, the JWKS client, raw sockets), and
  each call of an attribute in :data:`OUTBOUND_ATTRIBUTES` on any receiver
  (``loop.getaddrinfo``), keyed by module and enclosing qualname. Import
  aliases are resolved, so ``from smtplib import SMTP as S; S(...)`` is an SMTP
  session;
* **literal hosts** -- the host of every non-docstring string constant that is
  an ``http(s)://`` URL, set and tuple members included, loopback excluded.

:func:`register_gaps` then reconciles both, and the egress leaves the other
boundary suites already instrument, against a register. This is the single
constructor table for the backend: the sink-registry suite (B15) imports it
rather than keeping a second one.
"""

from __future__ import annotations

import ast
from collections import Counter
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Self
from urllib.parse import urlsplit

from privacy.recipients import SHARED_FACTORY_SITES, DialSite, Recipient, RecipientId
from tests.support.egress_call_graph import EGRESS_FUNCTIONS
from tests.support.outbound_boundary import _CLIENT_FACTORIES, _DIAL_LEAVES

SRC_ROOT: Final = Path(__file__).resolve().parents[2] / "src"

#: The module-level one-shot request verbs httpx and requests both expose.
_HTTP_VERBS: Final = ("get", "post", "put", "patch", "delete", "head", "options")

#: Fully-qualified callables that open (or configure the opening of) a connection.
OUTBOUND_CONSTRUCTORS: Final = frozenset(
    {
        *(
            f"{lib}.{name}"
            for lib in ("httpx", "httpx2")
            for name in (
                "Client",
                "AsyncClient",
                "HTTPTransport",
                "AsyncHTTPTransport",
                *_HTTP_VERBS,
                "request",
                "stream",
            )
        ),
        "openai.OpenAI",
        "openai.AsyncOpenAI",
        "anthropic.Anthropic",
        "anthropic.AsyncAnthropic",
        "smtplib.SMTP",
        "smtplib.SMTP_SSL",
        "sentry_sdk.init",
        "sentry_sdk.capture_exception",
        "sentry_sdk.capture_message",
        "sentry_sdk.capture_event",
        "jwt.PyJWKClient",
        "urllib.request.urlopen",
        "urllib.request.build_opener",
        "http.client.HTTPConnection",
        "http.client.HTTPSConnection",
        "socket.create_connection",
        "socket.socket",
        "asyncio.open_connection",
        "aiohttp.ClientSession",
        *(f"requests.{verb}" for verb in (*_HTTP_VERBS, "request")),
        "requests.Session",
    }
)

#: Attribute calls that dial whatever their receiver is (an event loop, a socket module).
OUTBOUND_ATTRIBUTES: Final = frozenset(
    {"getaddrinfo", "create_connection", "sock_connect", "open_connection"}
)

_URL_SCHEMES: Final = ("https://", "http://")
_LOOPBACK_HOSTS: Final = frozenset({None, "", "localhost", "127.0.0.1", "::1"})
_MODULE_SCOPE: Final = "<module>"
_SCOPES: Final = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)


@dataclass(frozen=True, slots=True, order=True)
class LiteralHost:
    """A URL host written into the source, and the module it is written in."""

    module: str
    host: str


@dataclass(frozen=True, slots=True)
class Sweep:
    """Everything the source can dial, as found."""

    sites: frozenset[DialSite]
    hosts: frozenset[LiteralHost]


@dataclass(frozen=True, slots=True)
class RegisterGaps:
    """Every way the register and the source disagree. Empty means they agree."""

    unclaimed_sites: frozenset[DialSite] = frozenset()
    stale_sites: frozenset[DialSite] = frozenset()
    multiply_claimed: frozenset[DialSite] = frozenset()
    unclaimed_hosts: frozenset[LiteralHost] = frozenset()
    stale_hosts: frozenset[str] = frozenset()
    multiply_claimed_hosts: frozenset[str] = frozenset()
    unclaimed_leaves: frozenset[tuple[str, str]] = frozenset()
    stale_leaves: frozenset[tuple[str, str]] = frozenset()

    @classmethod
    def empty(cls) -> Self:
        """No disagreement of any kind."""
        return cls()

    def empty_of_findings(self) -> bool:
        """Whether there is nothing to report."""
        return self == self.empty()


def egress_leaves() -> frozenset[tuple[str, str]]:
    """The function-shaped egress leaves the boundary suites already instrument."""
    return frozenset({*_DIAL_LEAVES, *_CLIENT_FACTORIES, *EGRESS_FUNCTIONS})


def _module_name(path: Path, root: Path) -> str:
    parts = list(path.relative_to(root).with_suffix("").parts)
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


def _import_bindings(node: ast.Import) -> Iterator[tuple[str, str]]:
    """``import a.b`` binds ``a``; ``import a.b as c`` binds ``c`` to ``a.b``."""
    for alias in node.names:
        root = alias.name.split(".")[0]
        yield (alias.asname, alias.name) if alias.asname else (root, root)


def _from_bindings(node: ast.ImportFrom) -> Iterator[tuple[str, str]]:
    """``from a import b as c`` binds ``c`` to ``a.b``; relative imports are local."""
    if node.module is None or node.level:
        return
    for alias in node.names:
        yield alias.asname or alias.name, f"{node.module}.{alias.name}"


def _bindings(node: ast.AST) -> Iterator[tuple[str, str]]:
    """The ``(bound name, dotted target)`` pairs one import statement introduces."""
    if isinstance(node, ast.Import):
        yield from _import_bindings(node)
    elif isinstance(node, ast.ImportFrom):
        yield from _from_bindings(node)


def _import_aliases(tree: ast.Module) -> dict[str, str]:
    """Map each name an import binds to the dotted name it stands for."""
    return dict(pair for node in ast.walk(tree) for pair in _bindings(node))


def _dotted(expr: ast.expr, aliases: Mapping[str, str]) -> str | None:
    """Resolve ``a.b.c`` to its imported dotted name, or ``None`` when it is not one."""
    if isinstance(expr, ast.Name):
        return aliases.get(expr.id)
    if isinstance(expr, ast.Attribute):
        base = _dotted(expr.value, aliases)
        return f"{base}.{expr.attr}" if base is not None else None
    return None


def _constructor(call: ast.Call, aliases: Mapping[str, str]) -> str | None:
    """The outbound constructor ``call`` invokes, if it invokes one."""
    name = _dotted(call.func, aliases)
    if name in OUTBOUND_CONSTRUCTORS:
        return name
    if isinstance(call.func, ast.Attribute) and call.func.attr in OUTBOUND_ATTRIBUTES:
        return f"*.{call.func.attr}"
    return None


def _docstring(owner: ast.Module | ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef) -> int:
    """The id of ``owner``'s docstring constant, or ``0`` when it has none."""
    first = owner.body[0] if owner.body else None
    is_doc = isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant)
    return id(first.value) if is_doc and isinstance(first, ast.Expr) else 0


def _docstring_nodes(tree: ast.Module) -> set[int]:
    """The ids of every docstring constant, which are prose rather than endpoints."""
    owners = [tree, *(n for n in ast.walk(tree) if isinstance(n, _SCOPES))]
    return {_docstring(owner) for owner in owners} - {0}


def _walk_scoped(node: ast.AST, scope: tuple[str, ...]) -> Iterator[tuple[ast.AST, str]]:
    """Yield every node with the dotted qualname of the scope enclosing it."""
    for child in ast.iter_child_nodes(node):
        inner = (*scope, child.name) if isinstance(child, _SCOPES) else scope
        yield child, ".".join(scope) or _MODULE_SCOPE
        yield from _walk_scoped(child, inner)


def _url_constant(node: ast.AST, docstrings: set[int]) -> str | None:
    """The URL a non-docstring string constant spells, if it spells one."""
    if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
        return None
    is_url = node.value.startswith(_URL_SCHEMES)
    return node.value if is_url and id(node) not in docstrings else None


def _literal_host(node: ast.AST, docstrings: set[int]) -> str | None:
    """The off-box host a string constant names, if it names one."""
    url = _url_constant(node, docstrings)
    host = urlsplit(url).hostname if url is not None else None
    return host if host not in _LOOPBACK_HOSTS else None


def _sweep_module(path: Path, root: Path) -> tuple[set[DialSite], set[LiteralHost]]:
    module = _module_name(path, root)
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    aliases = _import_aliases(tree)
    docstrings = _docstring_nodes(tree)
    sites: set[DialSite] = set()
    hosts: set[LiteralHost] = set()
    for node, scope in _walk_scoped(tree, ()):
        if isinstance(node, ast.Call):
            constructor = _constructor(node, aliases)
            if constructor is not None:
                sites.add(DialSite(module, scope, constructor))
        host = _literal_host(node, docstrings)
        if host is not None:
            hosts.add(LiteralHost(module, host))
    return sites, hosts


def sweep(src_root: Path) -> Sweep:
    """Every dial site and literal host under ``src_root`` (``*.py`` only)."""
    sites: set[DialSite] = set()
    hosts: set[LiteralHost] = set()
    for path in sorted(src_root.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        module_sites, module_hosts = _sweep_module(path, src_root)
        sites |= module_sites
        hosts |= module_hosts
    return Sweep(sites=frozenset(sites), hosts=frozenset(hosts))


def _claims(register: Mapping[RecipientId, Recipient]) -> dict[DialSite, set[RecipientId]]:
    claims: dict[DialSite, set[RecipientId]] = {}
    for recipient in register.values():
        for site in recipient.dial_sites:
            claims.setdefault(site, set()).add(recipient.id)
    return claims


def _is_misclaimed(site: DialSite, owners: set[RecipientId]) -> bool:
    """Whether ``owners`` is anything but one row, or the declared shared set."""
    shared = SHARED_FACTORY_SITES.get(site)
    return owners != shared if shared is not None else len(owners) > 1


def _misclaimed(claims: Mapping[DialSite, set[RecipientId]]) -> frozenset[DialSite]:
    """Sites owned by more than one row, unless they are the declared shared factories."""
    return frozenset(site for site, owners in claims.items() if _is_misclaimed(site, owners))


def _host_owner_counts(register: Mapping[RecipientId, Recipient]) -> Counter[str]:
    """How many rows claim each literal host."""
    return Counter(host for recipient in register.values() for host in recipient.hosts)


def _unclaimed_hosts(found: frozenset[LiteralHost], owners: Counter[str]) -> frozenset[LiteralHost]:
    """Literal hosts in the source that no register row claims."""
    return frozenset(literal for literal in found if literal.host not in owners)


def _host_gaps(
    found: frozenset[LiteralHost], register: Mapping[RecipientId, Recipient]
) -> tuple[frozenset[LiteralHost], frozenset[str], frozenset[str]]:
    """Unclaimed literal hosts, register hosts the source no longer names, doubled hosts."""
    owners = _host_owner_counts(register)
    unclaimed = _unclaimed_hosts(found, owners)
    stale = frozenset(owners.keys() - {literal.host for literal in found})
    doubled = frozenset(host for host, count in owners.items() if count > 1)
    return unclaimed, stale, doubled


def register_gaps(
    found: Sweep,
    register: Mapping[RecipientId, Recipient],
    leaves: frozenset[tuple[str, str]],
) -> RegisterGaps:
    """Reconcile a sweep and the instrumented egress leaves against ``register``."""
    claims = _claims(register)
    claimed_leaves = frozenset(leaf for r in register.values() for leaf in r.egress_leaves)
    unclaimed_hosts, stale_hosts, doubled_hosts = _host_gaps(found.hosts, register)
    return RegisterGaps(
        unclaimed_sites=frozenset(found.sites - claims.keys()),
        stale_sites=frozenset(claims.keys() - found.sites),
        multiply_claimed=_misclaimed(claims),
        unclaimed_hosts=unclaimed_hosts,
        stale_hosts=stale_hosts,
        multiply_claimed_hosts=doubled_hosts,
        unclaimed_leaves=leaves - claimed_leaves,
        stale_leaves=claimed_leaves - leaves,
    )
