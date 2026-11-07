import java.io.ByteArrayInputStream;
import java.io.StringReader;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.*;
import java.util.*;
import java.util.concurrent.ExecutorService;
import java.util.logging.Logger;

/** Exercises the bundled engine through a JDBC model, without claiming vendor-server acceptance.
 * 通过 JDBC 模型验证内置引擎，不将其宣称为厂商服务器验收。
 */
public final class DatabaseJdbcSimulation {
    private static final String SECRET = "PRIVATE_SIMULATED_JDBC_PASSWORD";
    private static final int[] TYPES = {Types.BIGINT, Types.NUMERIC, Types.VARBINARY, Types.VARCHAR, Types.VARCHAR};
    private static final String[] VALUES = {"9223372036854775807", "12345678901234567890.1234567890", null, "中文🚀", null};
    private static String url;
    private static Properties properties;
    private static boolean readonly;
    private static int writes, commits, rollbacks;
    private static Object fallback(Class<?> type) {
        if (type == boolean.class) return false;
        if (type == int.class) return 0;
        if (type == long.class) return 0L;
        return null;
    }
    @SuppressWarnings("unchecked")
    private static <T> T proxy(Class<T> type, java.lang.reflect.InvocationHandler handler) {
        return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, handler);
    }
    private static void check(boolean value) {
        if (!value) throw new AssertionError("Simulated JDBC contract mismatch");
    }
    private static ResultSet rows() {
        int[] row = {0};
        ResultSetMetaData metadata = proxy(ResultSetMetaData.class, (p, method, args) -> switch (method.getName()) {
            case "getColumnCount" -> TYPES.length;
            case "getColumnLabel" -> "column_" + args[0];
            case "getColumnTypeName" -> "SIMULATED_TYPE_" + args[0];
            case "getColumnType" -> TYPES[(int) args[0] - 1];
            default -> fallback(method.getReturnType());
        });
        return proxy(ResultSet.class, (p, method, args) -> switch (method.getName()) {
            case "getMetaData" -> metadata;
            case "next" -> row[0]++ == 0;
            case "getString" -> VALUES[(int) args[0] - 1];
            case "getBinaryStream" -> new ByteArrayInputStream(new byte[]{0, (byte) 255, 127});
            case "getCharacterStream" -> VALUES[(int) args[0] - 1] == null ? null : new StringReader(VALUES[(int) args[0] - 1]);
            default -> fallback(method.getReturnType());
        });
    }
    private static Statement statement() {
        return proxy(Statement.class, (p, method, args) -> switch (method.getName()) {
            case "execute" -> {
                String sql = (String) args[0];
                if (sql.startsWith("UPDATE")) writes++;
                yield sql.startsWith("SELECT");
            }
            case "getResultSet" -> rows();
            case "getUpdateCount" -> 1;
            default -> fallback(method.getReturnType());
        });
    }
    private static Connection connection() {
        DatabaseMetaData metadata = proxy(DatabaseMetaData.class, (p, method, args) ->
            method.getName().equals("getDatabaseProductVersion") ? "JDBC model, not a server" : fallback(method.getReturnType()));
        return proxy(Connection.class, (p, method, args) -> {
            switch (method.getName()) {
                case "setAutoCommit": check(Boolean.FALSE.equals(args[0])); break;
                case "setReadOnly": readonly = (boolean) args[0]; break;
                case "getMetaData": return metadata;
                case "createStatement": return statement();
                case "commit": commits++; break;
                case "rollback": rollbacks++; break;
            }
            return fallback(method.getReturnType());
        });
    }
    private static Object call(Method method, Object bridge, Map<String, Object> request) throws Exception {
        try { return method.invoke(bridge, request); }
        catch (InvocationTargetException failure) { throw (Exception) failure.getCause(); }
    }
    public static void main(String[] args) throws Exception {
        Driver driver = new Driver() {
            public boolean acceptsURL(String value) { return value.startsWith("jdbc:"); }
            public Connection connect(String value, Properties valueProperties) {
                url = value; properties = valueProperties; return connection();
            }
            public DriverPropertyInfo[] getPropertyInfo(String value, Properties props) { return new DriverPropertyInfo[0]; }
            public int getMajorVersion() { return 1; }
            public int getMinorVersion() { return 0; }
            public boolean jdbcCompliant() { return false; }
            public Logger getParentLogger() { return Logger.getGlobal(); }
        };
        DriverManager.registerDriver(driver);
        Class<?> type = Class.forName("DatabaseBridge");
        Method dispatch = type.getDeclaredMethod("dispatch", Map.class); dispatch.setAccessible(true);
        var worker = type.getDeclaredField("worker"); worker.setAccessible(true);
        try {
            for (String kind : List.of("mysql", "postgresql", "oracle")) {
                Object bridge = type.getDeclaredConstructor().newInstance();
                writes = 0; commits = 0; rollbacks = 0;
                try {
                    call(dispatch, bridge, Map.of("op", "connect", "config", Map.of("kind", kind,
                        "host", "127.0.0.1", "port", 15432, "database", "qa_service", "username", "qa", "tls", false), "password", SECRET));
                    check(readonly && SECRET.equals(properties.getProperty("password")) && !url.contains(SECRET));
                    check(url.endsWith("/qa_service"));
                    check(url.startsWith(kind.equals("oracle") ? "jdbc:oracle:thin:@tcp://" : "jdbc:" + kind + "://"));
                    Map<?, ?> reply = (Map<?, ?>) call(dispatch, bridge, Map.of("op", "query", "sql", "SELECT exact_values"));
                    List<?> row = (List<?>) ((List<?>) reply.get("rows")).get(0);
                    check(row.equals(Arrays.asList(VALUES[0], VALUES[1], Map.of("binary", "AP9/", "truncated", false), VALUES[3], null)));
                    check(Boolean.FALSE.equals(reply.get("pending")) && rollbacks > 0);
                    try {
                        call(dispatch, bridge, Map.of("op", "query", "sql", "UPDATE qa SET value=1"));
                        throw new AssertionError("Read-only simulation accepted a write");
                    } catch (IllegalArgumentException expected) { check("DB_READ_ONLY".equals(expected.getMessage())); }
                    check(writes == 0);
                    call(dispatch, bridge, Map.of("op", "writable", "enabled", true));
                    check(!readonly);
                    Map<?, ?> changed = (Map<?, ?>) call(dispatch, bridge, Map.of("op", "query", "sql", "UPDATE qa SET value=1"));
                    check(writes == 1 && Boolean.TRUE.equals(changed.get("pending")));
                    call(dispatch, bridge, Map.of("op", "rollback"));
                    call(dispatch, bridge, Map.of("op", "commit"));
                    check(commits == 1 && rollbacks >= 2);
                } finally { ((ExecutorService) worker.get(bridge)).shutdownNow(); }
            }
        } finally { DriverManager.deregisterDriver(driver); }
        System.out.println("MySQL PostgreSQL Oracle JDBC simulations: exact values, endpoint configuration, read-only and transactions passed");
    }
}
