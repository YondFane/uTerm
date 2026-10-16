import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.Reader;
import java.net.Authenticator;
import java.net.PasswordAuthentication;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.SQLNonTransientConnectionException;
import java.sql.SQLRecoverableException;
import java.sql.Statement;
import java.sql.Types;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Bundled JDBC worker; credentials arrive only through stdin. 内置 JDBC 进程，凭据仅通过标准输入传入。 */
public final class DatabaseBridge {
    private Connection connection;
    private volatile Statement running;
    private volatile boolean working;
    private volatile boolean writable;
    private String kind;
    private final String planSavepoint = "UTERM_PLAN_" + java.util.UUID.randomUUID().toString().replace("-", "").substring(0, 16);
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    /** Runs the versioned, line-framed local protocol. 运行带版本的本地逐行协议。 */
    public static void main(String[] args) throws Exception {
        if (args.length == 1 && args[0].equals("--version")) {
            System.out.println("uterm-database/1");
            return;
        }
        new DatabaseBridge().serve();
    }

    private synchronized void reply(Object id, Object result, String error) {
        Map<String, Object> output = new LinkedHashMap<>();
        output.put("id", id);
        output.put("result", result);
        output.put("error", error);
        byte[] bytes = (Json.write(output) + "\n").getBytes(StandardCharsets.UTF_8);
        System.out.write(bytes, 0, bytes.length);
        System.out.flush();
    }

    @SuppressWarnings("unchecked")
    private void serve() throws Exception {
        BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        try {
            while (true) {
                StringBuilder line = new StringBuilder();
                int next;
                while ((next = input.read()) != -1 && next != '\n') {
                    if (line.length() >= 1048576) throw new IllegalArgumentException("DB_INPUT_LIMIT");
                    line.append((char) next);
                }
                if (line.isEmpty() && next == -1) break;
                Map<String, Object> request = (Map<String, Object>) Json.parse(line.toString());
                Object id = request.get("id");
                if ("cancel".equals(request.get("op"))) {
                    Statement statement = running;
                    if (statement != null) {
                        try { statement.cancel(); } catch (SQLException ignored) { }
                    }
                    reply(id, Map.of("cancelled", statement != null), null);
                } else if (working) reply(id, null, "DB_BUSY");
                else {
                    working = true;
                    worker.submit(() -> {
                        Object result = null;
                        String failure = null;
                        try {
                            result = dispatch(request);
                        } catch (SQLException error) {
                            // Do not return vendor messages that may echo SQL or credentials. 不返回可能回显 SQL 或凭据的厂商错误文本。
                            String state = error.getSQLState();
                            failure = error instanceof SQLNonTransientConnectionException
                                || error instanceof SQLRecoverableException
                                || (state != null && state.startsWith("08"))
                                ? "DB_DISCONNECTED" : "DB_SQL:" + error.getErrorCode() + ":" + state;
                            if (!failure.equals("DB_DISCONNECTED") && error.getMessage() != null) {
                                var position = java.util.regex.Pattern.compile("(?i)\\bPosition\\s*:\\s*([0-9]{1,7})\\b").matcher(error.getMessage());
                                var lineNumber = java.util.regex.Pattern.compile("(?i)\\bat line\\s+([0-9]{1,7})\\b").matcher(error.getMessage());
                                // Return numeric locations only; vendor messages may contain SQL values.
                                // 仅返回数字位置，厂商错误文本可能包含 SQL 数据值。
                                if (position.find()) failure += ":POSITION:" + position.group(1);
                                else if (lineNumber.find()) failure += ":LINE:" + lineNumber.group(1);
                            }
                        } catch (Exception error) {
                            String code = error.getMessage();
                            failure = code != null && code.matches("DB_[A-Z_]+") ? code : "DB_OPERATION_FAILED";
                        } finally {
                            running = null;
                            working = false;
                        }
                        reply(id, result, failure);
                    });
                }
            }
        } finally {
            worker.shutdownNow();
            if (connection != null) connection.close();
        }
    }

    @SuppressWarnings("unchecked")
    private Object dispatch(Map<String, Object> request) throws Exception {
        String op = text(request, "op");
        if (op.equals("connect")) {
            Map<String, Object> config = (Map<String, Object>) request.get("config");
            kind = text(config, "kind");
            String host = text(config, "host");
            String port = config.get("port").toString();
            String database = text(config, "database");
            boolean tls = Boolean.TRUE.equals(config.get("tls"));
            Properties properties = new Properties();
            properties.setProperty("user", text(config, "username"));
            properties.setProperty("password", text(request, "password"));
            properties.setProperty("connectTimeout", kind.equals("mysql") ? "12000" : "12");
            properties.setProperty("socketTimeout", kind.equals("mysql") ? "35000" : "35");
            String authority = host.contains(":") ? "[" + host + "]" : host;
            String url;
            switch (kind) {
                case "mysql" -> {
                    properties.setProperty("sslMode", tls ? "VERIFY_IDENTITY" : "DISABLED");
                    properties.setProperty("allowLoadLocalInfile", "false");
                    properties.setProperty("allowMultiQueries", "false");
                    properties.setProperty("useInformationSchema", "true");
                    properties.setProperty("useCursorFetch", "true");
                    properties.setProperty("serverTimezone", "UTC");
                    if (request.get("proxy_port") instanceof Number proxy && proxy.intValue() > 0) {
                        properties.setProperty("socksProxyHost", "127.0.0.1");
                        properties.setProperty("socksProxyPort", proxy.toString());
                        properties.setProperty("socksProxyRemoteDns", "true");
                    }
                    url = "jdbc:mysql://" + authority + ":" + port + "/" + database;
                }
                case "postgresql" -> {
                    properties.setProperty("sslmode", tls ? "verify-full" : "disable");
                    properties.setProperty("sslfactory", "org.postgresql.ssl.DefaultJavaSSLFactory");
                    url = "jdbc:postgresql://" + authority + ":" + port + "/" + database;
                }
                case "oracle" -> {
                    properties.setProperty("oracle.net.CONNECT_TIMEOUT", "12000");
                    properties.setProperty("oracle.jdbc.ReadTimeout", "35000");
                    properties.setProperty("oracle.net.ssl_server_dn_match", "true");
                    url = "jdbc:oracle:thin:@" + (tls ? "tcps" : "tcp") + "://" + authority + ":" + port + "/" + database;
                }
                default -> throw new IllegalArgumentException("DB_INVALID_CONFIG");
            }
            if (request.get("proxy_port") instanceof Number proxy && proxy.intValue() > 0) {
                System.setProperty("socksProxyHost", "127.0.0.1");
                System.setProperty("socksProxyPort", proxy.toString());
                System.setProperty("socksNonProxyHosts", "");
                String token = text(request, "proxy_token");
                Authenticator.setDefault(new Authenticator() {
                    @Override protected PasswordAuthentication getPasswordAuthentication() {
                        if ("127.0.0.1".equals(getRequestingHost()) && getRequestingPort() == proxy.intValue()
                                && "SOCKS5".equalsIgnoreCase(getRequestingProtocol())) {
                            return new PasswordAuthentication("uterm", token.toCharArray());
                        }
                        return null;
                    }
                });
                if (kind.equals("oracle")) {
                    properties.setProperty("oracle.net.socksProxyHost", "127.0.0.1");
                    properties.setProperty("oracle.net.socksProxyPort", proxy.toString());
                    properties.setProperty("oracle.net.socksRemoteDNS", "true");
                }
            }
            if (tls) installTrust(text(config, "ca_file"));
            DriverManager.setLoginTimeout(12);
            connection = DriverManager.getConnection(url, properties);
            connection.setAutoCommit(false);
            connection.setReadOnly(true);
            return Map.of("version", connection.getMetaData().getDatabaseProductVersion(), "protocol", 1);
        }
        if (connection == null || connection.isClosed()) throw new IllegalArgumentException("DB_DISCONNECTED");
        if (op.equals("writable")) {
            connection.rollback();
            writable = Boolean.TRUE.equals(request.get("enabled"));
            connection.setReadOnly(!writable);
            return Map.of("writable", writable);
        }
        if (op.equals("commit") || op.equals("rollback")) {
            if (op.equals("commit")) connection.commit();
            else connection.rollback();
            return Map.of("pending", false);
        }
        if (op.equals("metadata")) {
            connection.rollback();
            if (kind.equals("oracle") && !writable) try (Statement s = connection.createStatement()) {
                s.execute("SET TRANSACTION READ ONLY");
            }
            DatabaseMetaData metadata = connection.getMetaData();
            ResultSet values;
            String catalog = text(request, "catalog");
            String schema = text(request, "schema");
            String table = text(request, "table");
            switch (text(request, "view")) {
                case "catalogs" -> values = kind.equals("mysql") ? metadata.getCatalogs() : metadata.getSchemas();
                case "tables" -> values = metadata.getTables(catalog.isEmpty() ? null : catalog,
                    schema.isEmpty() ? null : metadataPattern(metadata, schema), "%",
                    new String[]{"TABLE", "VIEW", "SYSTEM TABLE", "SYSTEM VIEW"});
                case "columns" -> values = metadata.getColumns(catalog.isEmpty() ? null : catalog,
                    schema.isEmpty() ? null : metadataPattern(metadata, schema), metadataPattern(metadata, table), "%");
                default -> throw new IllegalArgumentException("DB_INVALID_REQUEST");
            }
            try (ResultSet rows = values) { return result(rows, 500, 0); }
            finally { connection.rollback(); }
        }
        if (op.equals("table") || op.equals("preview") || op.equals("apply")) {
            if (op.equals("apply") && !writable) throw new IllegalArgumentException("DB_READ_ONLY");
            if (!writable && kind.equals("oracle")) try (Statement s = connection.createStatement()) { s.execute("SET TRANSACTION READ ONLY"); }
            try {
                long start = System.nanoTime();
                Map<String, Object> response = op.equals("table") ? DatabaseTable.read(connection, kind, request)
                    : op.equals("preview") ? DatabaseTable.preview(connection, kind, request) : DatabaseTable.apply(connection, kind, request);
                response.put("elapsed", (System.nanoTime() - start) / 1000000);
                response.put("pending", writable);
                return response;
            } finally { if (!writable) connection.rollback(); }
        }
        if (op.equals("explain")) {
            String sql = text(request, "sql");
            if (!Sql.readOnly(sql, kind)) throw new IllegalArgumentException("DB_READ_ONLY");
            if (kind.equals("oracle")) {
                if (!writable) throw new IllegalArgumentException("DB_EXPLAIN_WRITABLE");
                java.sql.Savepoint point = connection.setSavepoint(planSavepoint);
                String identity = java.util.UUID.randomUUID().toString().replace("-", "").substring(0, 24);
                try {
                    try (Statement plan = connection.createStatement()) {
                        running = plan;
                        plan.setQueryTimeout(15);
                        plan.execute("EXPLAIN PLAN SET STATEMENT_ID = '" + identity + "' FOR " + sql);
                    }
                    try (java.sql.PreparedStatement plan = connection.prepareStatement("SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE', ?, 'TYPICAL'))")) {
                        running = plan;
                        plan.setString(1, identity);
                        plan.setQueryTimeout(15);
                        plan.setMaxRows(201);
                        try (ResultSet rows = plan.executeQuery()) {
                            Map<String, Object> response = result(rows, 200, 0);
                            response.put("pending", true);
                            return response;
                        }
                    }
                } finally {
                    try { connection.rollback(point); }
                    catch (Exception rollback) { connection.close(); throw new IllegalArgumentException("DB_WRITE_UNKNOWN"); }
                }
            }
            Map<String, Object> explain = new LinkedHashMap<>(request);
            explain.put("op", "query");
            explain.put("sql", (kind.equals("postgresql") ? "EXPLAIN (FORMAT JSON) " : "EXPLAIN ") + sql);
            return execute(explain, true);
        }
        if (!op.equals("query")) throw new IllegalArgumentException("DB_INVALID_REQUEST");
        return execute(request, false);
    }

    private Object execute(Map<String, Object> request, boolean explain) throws Exception {
        String sql = text(request, "sql").trim();
        if (sql.isEmpty() || sql.length() > 262144) throw new IllegalArgumentException("DB_INPUT_LIMIT");
        List<Sql.Token> command = explain ? List.of() : Sql.tokens(sql, kind);
        if (!explain) {
            boolean readOnly = Sql.readOnly(command, kind);
            if (!writable && !readOnly) throw new IllegalArgumentException("DB_READ_ONLY");
        }
        if (!writable && kind.equals("oracle")) try (Statement s = connection.createStatement()) {
            s.execute("SET TRANSACTION READ ONLY");
        }
        int offset = Math.max(0, Math.min(10000, ((Number) request.getOrDefault("offset", 0)).intValue()));
        long start = System.nanoTime();
        try (Statement statement = connection.createStatement()) {
            running = statement;
            statement.setQueryTimeout(30);
            statement.setFetchSize(200);
            statement.setMaxRows(offset + 201);
            Map<String, Object> response;
            if (statement.execute(sql)) try (ResultSet rows = statement.getResultSet()) {
                response = result(rows, 200, offset);
            } else response = new LinkedHashMap<>(Map.of("affected", statement.getUpdateCount()));
            response.put("elapsed", (System.nanoTime() - start) / 1000000);
            boolean finished = command.size() == 1 && List.of("COMMIT", "ROLLBACK", "END").contains(command.get(0).text().toUpperCase(java.util.Locale.ROOT));
            response.put("pending", writable && !finished);
            if (!writable) connection.rollback();
            return response;
        } catch (Exception error) {
            if (!writable) connection.rollback();
            throw error;
        }
    }

    private static String text(Map<String, Object> map, String key) {
        Object value = map.get(key);
        return value instanceof String ? (String) value : "";
    }

    private static String metadataPattern(DatabaseMetaData metadata, String value) throws SQLException {
        String escape = metadata.getSearchStringEscape();
        return escape.isEmpty() ? value : value.replace(escape, escape + escape)
            .replace("%", escape + "%").replace("_", escape + "_");
    }

    static Map<String, Object> result(ResultSet result, int limit, int offset) throws Exception {
        ResultSetMetaData metadata = result.getMetaData();
        int count = metadata.getColumnCount();
        if (count > 256) throw new IllegalArgumentException("DB_REPLY_LIMIT");
        List<Object> columns = new ArrayList<>();
        for (int index = 1; index <= count; index++) columns.add(Map.of(
            "name", metadata.getColumnLabel(index), "type", metadata.getColumnTypeName(index)));
        List<Object> rows = new ArrayList<>();
        List<Object> partial = new ArrayList<>();
        int budget = 0;
        for (int index = 0; index < offset && result.next(); index++) { }
        boolean more = false;
        while (result.next()) {
            if (rows.size() >= limit) { more = true; break; }
            List<Object> row = new ArrayList<>();
            for (int index = 1; index <= count; index++) {
                Object cell;
                boolean truncated = false;
                switch (metadata.getColumnType(index)) {
                    case Types.BLOB, Types.BINARY, Types.VARBINARY, Types.LONGVARBINARY -> {
                        InputStream stream = result.getBinaryStream(index);
                        if (stream == null) cell = null;
                        else try (stream) {
                            byte[] bytes = stream.readNBytes(4097);
                            truncated = bytes.length > 4096;
                            cell = Map.of("binary", Base64.getEncoder().encodeToString(Arrays.copyOf(bytes, Math.min(4096, bytes.length))),
                                "truncated", bytes.length > 4096);
                        }
                    }
                    case Types.CHAR, Types.VARCHAR, Types.LONGVARCHAR,
                         Types.NCHAR, Types.NVARCHAR, Types.LONGNVARCHAR,
                         Types.CLOB, Types.NCLOB -> {
                        Reader reader = result.getCharacterStream(index);
                        if (reader == null) cell = null;
                        else try (reader) {
                            char[] chars = new char[16385];
                            int read = 0, next;
                            while (read < chars.length && (next = reader.read(chars, read, chars.length - read)) > 0) read += next;
                            truncated = read > 16384;
                            cell = new String(chars, 0, Math.min(16384, read)) + (read > 16384 ? " …" : "");
                        }
                    }
                    default -> {
                        String value = result.getString(index);
                        truncated = value != null && value.length() > 16384;
                        cell = value == null ? null : value.substring(0, Math.min(16384, value.length())) + (value.length() > 16384 ? " …" : "");
                    }
                }
                budget += Json.length(cell);
                if (budget > 1048576) throw new IllegalArgumentException("DB_REPLY_LIMIT");
                row.add(cell);
                if (truncated) partial.add(List.of(rows.size(), index - 1));
            }
            rows.add(row);
        }
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("columns", columns);
        response.put("rows", rows);
        response.put("more", more);
        if (!partial.isEmpty()) response.put("partial", partial);
        return response;
    }

    private static void installTrust(String path) throws Exception {
        if (path.isEmpty()) return;
        Path source = Path.of(path);
        if (Files.size(source) > 1048576) throw new IllegalArgumentException("DB_CA_FAILED");
        KeyStore store = KeyStore.getInstance("PKCS12");
        store.load(null, null);
        try (InputStream input = Files.newInputStream(source)) {
            int index = 0;
            for (Certificate certificate : CertificateFactory.getInstance("X.509").generateCertificates(input))
                store.setCertificateEntry("ca" + index++, certificate);
            if (index == 0) throw new IllegalArgumentException("DB_CA_FAILED");
        }
        Path temporary = Files.createTempFile("uterm-db-trust-", ".p12");
        temporary.toFile().deleteOnExit();
        try (OutputStream output = Files.newOutputStream(temporary)) {
            store.store(output, new char[0]);
        }
        System.setProperty("javax.net.ssl.trustStore", temporary.toString());
        System.setProperty("javax.net.ssl.trustStoreType", "PKCS12");
        System.setProperty("javax.net.ssl.trustStorePassword", "");
    }
}
