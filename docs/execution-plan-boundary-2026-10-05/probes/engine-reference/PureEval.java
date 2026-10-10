import org.eclipse.collections.api.factory.Lists;
import org.finos.legend.pure.m3.navigation.Instance;
import org.finos.legend.pure.m3.serialization.filesystem.repository.CodeRepositoryProviderHelper;
import org.finos.legend.pure.m3.serialization.filesystem.usercodestorage.classpath.ClassLoaderCodeStorage;
import org.finos.legend.pure.m3.serialization.filesystem.usercodestorage.composite.CompositeCodeStorage;
import org.finos.legend.pure.m3.serialization.runtime.Message;
import org.finos.legend.pure.m3.serialization.runtime.PureRuntime;
import org.finos.legend.pure.m3.serialization.runtime.PureRuntimeBuilder;
import org.finos.legend.pure.m4.coreinstance.CoreInstance;
import org.finos.legend.pure.runtime.java.interpreted.FunctionExecutionInterpreted;

/**
 * Pure's INTERPRETED runtime (legend-pure 5.99.0: the reference runtime, the one lite's PCT lane runs): each expression
 * compiled into a function and run, printed by its own toString. Every repository of Pure's own is loaded (not lite's PCT
 * adapter). Run: java -Xmx4g -cp <the PCT lane's jars: a pct_channel_b test's runfiles MANIFEST> PureEval.java '<expr>'...
 */
public class PureEval {
    public static void main(String[] exprs) throws Exception {
        // every repository of Pure's own, not lite's PCT adapter
        var repos = CodeRepositoryProviderHelper.findCodeRepositories().reject(r -> r.getName().equals("core_legend_lite_pct"));
        PureRuntime runtime = new PureRuntimeBuilder(new CompositeCodeStorage(new ClassLoaderCodeStorage(repos))).buildAndInitialize();
        FunctionExecutionInterpreted fe = new FunctionExecutionInterpreted();
        fe.init(runtime, new Message(""));
        StringBuilder src = new StringBuilder();
        for (int i = 0; i < exprs.length; i++) {
            src.append("function probe::f").append(i).append("():String[1] { ").append("(").append(exprs[i]).append(")->toString() }\n");
        }
        runtime.createInMemorySource("probe.pure", src.toString());
        runtime.compile();
        for (int i = 0; i < exprs.length; i++) {
            CoreInstance f = runtime.getFunction("probe::f" + i + "():String[1]");
            try {
                CoreInstance r = fe.start(f, Lists.immutable.empty());
                var values = Instance.getValueForMetaPropertyToManyResolved(r, "values", runtime.getProcessorSupport());
                System.out.println(exprs[i] + "  ->  " + (values.isEmpty() ? "(empty)" : values.get(0).getName()));
            } catch (Exception e) {
                System.out.println(exprs[i] + "  ->  FAIL " + e.getMessage());
            }
        }
    }
}
