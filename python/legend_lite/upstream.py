"""A SERVER PLANS FOR PYTHON'S PAGES (docs/ONE_PLATFORM_PROGRAM_2026_10_12.md G1): legend-lite's server (the ``remote``
plane) or legend-engine (``engine``), over legend-engine's ``pure/v1`` API, the twin of the tab's planner on a server
(datacube/src/planner.ts ``UpstreamPlanner``, over engine-client's ``PureV1Client``). Each request is written as the tab
writes it and each plan read as the tab reads it (one corpus holds the two alike:
engine-client/test/fixtures/upstream-plans.json). The server holds nothing -- every request carries its model -- and
plans only: Python runs the plan's SQL on its own DuckDB, the page sending Pure, never SQL (R4). Over the standard
library's HTTP; a server's sign-in is not here yet (the program's G10)."""

from __future__ import annotations

import urllib.error
import urllib.request
from typing import Any

from . import _json, compiler
from .compiler import Column, LegendError, Plan

# each plane a server is, and what the planner menu says of it (the tab's PLANES, datacube/demo/boot.ts)
PLANES = {
    'remote': ('legend-lite', 'Plan remote (legend-lite at {url})'),
    'engine': ('legend-engine', 'Plan on the engine (legend-engine at {url})'),
}

# how long a server is given to answer one call (seconds): a plan, a type, a parse
_TIMEOUT = 60


def from_runtime(query: dict[str, Any], runtime: str) -> dict[str, Any]:
    """The query as the server runs it: its relation read from the runtime, ``->from(runtime)`` (``PureV1Client
    .fromRuntime``). A cube query is one relation expression with no parameters; anything else is refused."""
    body = query.get('body')
    if query.get('_type') != 'lambda' or not isinstance(body, list) or len(body) != 1 or query.get('parameters'):
        raise ValueError('a cube query is one relation expression with no parameters')
    source = {'_type': 'packageableElementPtr', 'fullPath': runtime}
    return {'_type': 'lambda', 'parameters': [], 'body': [{'_type': 'func', 'function': 'from', 'parameters': [body[0], source]}]}


def generate_plan_request(query: dict[str, Any], model: str, runtime: str) -> dict[str, Any]:
    """``execution/generatePlan``'s body for a query over ``model`` through ``runtime``, as the tab's client writes it
    (``PureV1Client.generatePlan``): ``vX_X_X`` carries the protocol models production versions lack (DuckDB's), and the
    context is required (legend-engine answers 500 without it)."""
    return {'clientVersion': 'vX_X_X', 'function': from_runtime(query, runtime),
            'model': {'_type': 'text', 'code': model}, 'context': {'_type': 'BaseExecutionContext'}}


def sql_of(plan: dict[str, Any]) -> str | None:
    """The plan's first SQL node's statement, breadth first from its root (planner.ts ``sqlOf``)."""
    work: list[Any] = [plan.get('rootExecutionNode')]
    while work:
        node = work.pop(0)
        if not isinstance(node, dict):
            continue
        if node.get('_type') == 'sql' and isinstance(node.get('sqlQuery'), str):
            return node['sqlQuery']
        work.extend(node.get('executionNodes') or [])
    return None


def tds_columns(plan: dict[str, Any]) -> tuple[Column, ...]:
    """The plan's result columns (its root's ``resultType.tdsColumns``), each its name and its type as the server says
    it (relation-type.ts ``tdsColumns``: the page reads these types itself, by legend-lite's lattice)."""
    root = plan.get('rootExecutionNode')
    columns = root.get('resultType', {}).get('tdsColumns') if isinstance(root, dict) else None
    if not isinstance(columns, list):
        raise LegendError('the plan carries no tdsColumns', 'PLAN')
    out = []
    for c in columns:
        if not (isinstance(c, dict) and isinstance(c.get('name'), str) and isinstance(c.get('type'), str)):
            raise LegendError(f'a plan column without a name and a type: {_json.dumps(c)}', 'PLAN')
        out.append(Column(c['name'], c['type'], c))
    return tuple(out)


def read_plan(text: str) -> Plan:
    """A server's ``generatePlan`` answer as a Plan: its SQL and its columns; a refusal (the engine's error shape) or
    a plan with no SQL raised, in the server's words."""
    try:
        plan = _json.loads(text)
    except ValueError:
        raise LegendError(f'the server answered no plan: {text[:300]}', 'PLAN') from None
    if not isinstance(plan, dict) or 'rootExecutionNode' not in plan:
        message = plan.get('message') if isinstance(plan, dict) else None
        kind = plan.get('errorType') if isinstance(plan, dict) else None
        raise LegendError(message if isinstance(message, str) else f'the server answered no plan: {text[:300]}',
                          kind if isinstance(kind, str) else 'PLAN')
    sql = sql_of(plan)
    if sql is None:
        raise LegendError('the plan carries no SQL node', 'PLAN')
    return Plan(sql, tds_columns(plan))


class RemotePlanner:
    """The ``remote`` or ``engine`` plane on a Python host (engine.py's ``Planner``): the server at ``url`` answers
    every ``pure/v1`` call the page makes (a query's types, a parse, a print) and plans its grids' queries, whose SQL
    Python runs (``plan``)."""

    def __init__(self, plane: str, url: str) -> None:
        if plane not in PLANES:
            raise ValueError(f'a planner on a server is one of {", ".join(PLANES)}, not {plane!r}')
        if not url.startswith(('http://', 'https://')):
            raise ValueError(f"a planner's server is an http:// or https:// address, not {url!r}")
        self.plane = plane
        self.url = url.rstrip('/')
        self.server = PLANES[plane][0]
        self.label = PLANES[plane][1].format(url=self.url)

    def answering(self) -> str | None:
        """Why the server does not answer, or None: asked once as the planner is chosen, as the tab asks (its health
        route: legend-lite's ``/health``, legend-engine's ``/api/server/v1/info``), and said, never substituted."""
        health = '/health' if self.plane == 'remote' else '/api/server/v1/info'
        try:
            with urllib.request.urlopen(self.url + health, timeout=5) as answer:
                return None if answer.status == 200 else f'{self.server} answered {answer.status} at {self.url}'
        except (urllib.error.URLError, OSError) as failure:
            return f'{self.server} is not answering at {self.url}: {failure}'

    def _post(self, path: str, query: str, body: str, content_type: str) -> compiler.Answer:
        request = urllib.request.Request(self.url + path + (f'?{query}' if query else ''), data=body.encode('utf-8'),
                                         headers={'Content-Type': content_type}, method='POST')
        try:
            with urllib.request.urlopen(request, timeout=_TIMEOUT) as answer:
                return compiler.Answer(answer.status, answer.headers.get('Content-Type', 'application/json'),
                                       answer.read().decode('utf-8'))
        except urllib.error.HTTPError as refused:
            return compiler.Answer(refused.code, refused.headers.get('Content-Type', 'application/json'),
                                   refused.read().decode('utf-8', errors='replace'))
        except (urllib.error.URLError, OSError) as failure:
            return self.refusal(f'{self.server} did not answer at {self.url}: {failure}')

    def answer(self, path: str, query: str, body: str) -> compiler.Answer:
        """A ``pure/v1`` call of the page's, sent on to the server as it came (its path, its query string, its body)."""
        content_type = 'text/plain' if '/grammar/grammarToJson/' in path else 'application/json'
        return self._post(path, query, body, content_type)

    def execute_plan(self, body: str, models: list[str]) -> compiler.Answer:
        """legend-engine's execute API is not answered through a server's plan on Python yet: its answer's shape is the
        module's Java's (the program's C1). The page's grids run through ``plan`` instead."""
        return self.refusal(f'execute is not planned on {self.server} from Python yet: a grid is planned and run '
                            'through plan-and-run')

    def refusal(self, message: str) -> compiler.Answer:
        return compiler.refusal(message)

    def plan(self, query: str, held: compiler.HeldModel, runtime: str) -> str:
        """A grid's query (its lambda's JSON) planned by the server over the model held (its text: the server holds
        nothing), through ``runtime``: the server's answer as it came, which the page reads as the tab's planner reads
        it (``read`` reads it here)."""
        try:
            request = generate_plan_request(_json.loads(query), held.model, runtime)
        except ValueError as refused:
            return self.refused_plan(str(refused))
        return self._post('/api/pure/v1/execution/generatePlan', '', _json.dumps(request), 'application/json').body

    def read(self, answer: str) -> Plan:
        return read_plan(answer)

    def refused_plan(self, message: str) -> str:
        return _json.dumps({'message': message, 'errorType': 'PLAN'})
