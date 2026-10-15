import java.lang.reflect.Method;

/** Checks dialect guards without a database. 无需数据库即可验证方言保护。 */
public final class DatabaseSqlProbe {
    public static void main(String[] args) throws Exception {
        Method readOnly = Class.forName("Sql").getDeclaredMethod("readOnly", String.class, String.class);
        readOnly.setAccessible(true);
        for (String kind : new String[]{"mysql", "postgresql", "oracle"}) {
            for (String sql : new String[]{"/* comment */ SELECT 1", "WITH c AS (SELECT 1) SELECT * FROM c", "SELECT 'DELETE; UPDATE'"}) {
                if (!Boolean.TRUE.equals(readOnly.invoke(null, sql, kind))) throw new AssertionError(sql);
            }
            for (String sql : new String[]{"UPDATE test SET x=1", "SELECT * FROM test FOR UPDATE", "WITH c AS (DELETE FROM test RETURNING *) SELECT * FROM c"}) {
                if (!Boolean.FALSE.equals(readOnly.invoke(null, sql, kind))) throw new AssertionError(sql);
            }
            for (String sql : new String[]{"SELECT 1; DELETE FROM test", "SELECT 'unfinished"}) {
                try { readOnly.invoke(null, sql, kind); throw new AssertionError(sql); }
                catch (java.lang.reflect.InvocationTargetException expected) {
                    if (!"DB_SQL_UNSUPPORTED".equals(expected.getCause().getMessage())) throw expected;
                }
            }
        }
        System.out.println("SQL guards passed");
    }
}
