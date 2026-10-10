"""The shadow run's probe: `python3 -I probe.py apply` adds PlanShadow.java and wraps today's three text-answer entries
(Execution's executeStreaming and executeWire on a session source) so each answer is compared with its lite plan's;
`python3 -I probe.py remove` undoes it. Run from the repository root. Matched by the entries' signatures."""
import pathlib
import sys

HERE = pathlib.Path(__file__).parent
ROOT = pathlib.Path("core/src/main/java/com/legend")
SHADOW = ROOT / "PlanShadow.java"
EXECUTION = ROOT / "Execution.java"
ORIGIN = ROOT / "exec" / "StatementOrigin.java"
MARK = "    // shadow probe: wrapped\n"

# (signature line(s) as written, the private method its body becomes, the wrapper's body)
ENTRIES = [
    ("""    public static void executeStreaming(String model, String query,
            @com.legend.base.Nullable String runtimeFqn, com.legend.exec.Sessions.Source sessions,
            java.io.Writer out) throws java.io.IOException {""", "shadowStreaming0",
     """        PlanShadow.Tee tee = new PlanShadow.Tee(out);
        shadowStreaming0(model, query, runtimeFqn, sessions, tee);
        PlanShadow.compare("streamed", model, query, runtimeFqn, TypedQuery.Output.STREAMED_JSON, tee.text(), sessions);
    }
"""),
    ("""    public static java.util.List<String> executeWire(String model,
            String query, @com.legend.base.Nullable String runtimeFqn,
            com.legend.exec.Sessions.Source sessions,
            com.legend.lowering.WireRender.Format format, java.io.Writer out)
            throws java.io.IOException {""", "shadowWire0",
     """        PlanShadow.Tee tee = new PlanShadow.Tee(out);
        java.util.List<String> columns = shadowWire0(model, query, runtimeFqn, sessions, format, tee);
        PlanShadow.compare(format == com.legend.lowering.WireRender.Format.CSV ? "csv" : "json", model, query,
                runtimeFqn, format == com.legend.lowering.WireRender.Format.CSV ? TypedQuery.Output.CSV
                        : TypedQuery.Output.JSON, tee.text(), sessions);
        return columns;
    }
"""),
    ("""    public static com.legend.plan.QueryPlan executeWire(String model,
            com.legend.protocol.spec.ValueSpecification query, String runtimeFqn,
            com.legend.exec.Sessions.Source sessions, java.io.Writer out) throws java.io.IOException {""",
     "shadowExecute0",
     """        PlanShadow.Tee tee = new PlanShadow.Tee(out);
        com.legend.plan.QueryPlan plan = shadowExecute0(model, query, runtimeFqn, sessions, tee);
        PlanShadow.compare("execute", model, query, runtimeFqn, TypedQuery.Output.JSON, tee.text(), sessions);
        return plan;
    }
"""),
]

ORIGIN_SIG = "    public static void sent(String sql) {\n"
ORIGIN_COUNT = "    public static void count(StatementOrigin origin) {\n"
ORIGIN_FIELD = "    /** shadow probe: a statement the shadow run sends is not counted. */\n    public static final ThreadLocal<Boolean> SHADOW = ThreadLocal.withInitial(() -> false);\n\n"
SKIP = "        if (SHADOW.get()) {\n            return;\n        }\n"


def wrapped(sig, private, body):
    params_and_rest = sig.split("(", 1)[1]
    head = sig.split("(", 1)[0]
    return (MARK + sig + "\n" + body + "\n    private" + head[len("    public"):] + "(" + params_and_rest)\
        .replace("private static void executeStreaming", "private static void " + private)\
        .replace("private static java.util.List<String> executeWire", "private static java.util.List<String> " + private)\
        .replace("private static com.legend.plan.QueryPlan executeWire", "private static com.legend.plan.QueryPlan " + private)


def apply():
    e = EXECUTION.read_text()
    o = ORIGIN.read_text()
    if MARK in e or SHADOW.exists() or "SHADOW" in o:
        sys.exit("probe: already applied")
    for sig, private, body in ENTRIES:
        if e.count(sig) != 1:
            sys.exit("probe: Execution.java has %d of %s" % (e.count(sig), sig.splitlines()[0].strip()))
    for s in (ORIGIN_SIG, ORIGIN_COUNT):
        if o.count(s) != 1:
            sys.exit("probe: StatementOrigin.java has %d of %s" % (o.count(s), s.strip()))
    for sig, private, body in ENTRIES:
        e = e.replace(sig, wrapped(sig, private, body), 1)
    anchor = "public enum StatementOrigin {\n"
    if o.count(anchor) != 1:
        sys.exit("probe: StatementOrigin's declaration not found")
    o = o.replace(ORIGIN_SIG, ORIGIN_SIG + SKIP, 1).replace(ORIGIN_COUNT, ORIGIN_COUNT + SKIP, 1)
    o = o.replace(anchor, anchor, 1)
    # the field goes after the enum's constants: before the first method
    i = o.index("    public static StatementOrigin current()")
    o = o[:i] + ORIGIN_FIELD + o[i:]
    SHADOW.write_text((HERE / "PlanShadow.java.txt").read_text())
    EXECUTION.write_text(e)
    ORIGIN.write_text(o)


def remove():
    import subprocess
    if SHADOW.exists():
        SHADOW.unlink()
    subprocess.run(["git", "checkout", "--", str(EXECUTION), str(ORIGIN)], check=True)


{"apply": apply, "remove": remove}[sys.argv[1]]()
