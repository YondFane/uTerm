import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Savepoint;
import java.sql.Types;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;

/** Generates parameterized table operations from live metadata. 根据实时元数据生成参数化表操作。 */
final class DatabaseTable {
    private static final String SAVEPOINT = "UTERM_GRID_" + java.util.UUID.randomUUID().toString().replace("-", "").substring(0, 16);
    record Column(String name, int type, boolean nullable, boolean generated, boolean defaulted) { }
    record Shape(List<Column> columns, List<String> keys, boolean editable, String target, String signature) { }
    record Command(String kind, String sql, List<Object> values, List<Column> bindings, List<?> original) { }

    private static String text(Map<String, Object> request, String key) {
        Object value = request.get(key);
        String result = value instanceof String ? (String) value : "";
        if (result.length() > 1024 || result.indexOf('\0') >= 0) fail("DB_INVALID_REQUEST");
        return result;
    }
    private static String quote(String kind, String value) {
        String quote = kind.equals("mysql") ? "`" : "\"";
        return quote + value.replace(quote, quote + quote) + quote;
    }
    private static String pattern(DatabaseMetaData metadata, String value) throws Exception {
        String escape = metadata.getSearchStringEscape();
        return escape.isEmpty() ? value : value.replace(escape, escape + escape).replace("%", escape + "%").replace("_", escape + "_");
    }
    private static boolean supported(int type) {
        return switch (type) {
            case Types.CHAR, Types.VARCHAR, Types.NCHAR, Types.NVARCHAR, Types.LONGVARCHAR, Types.LONGNVARCHAR,
                Types.INTEGER, Types.SMALLINT, Types.TINYINT, Types.BIGINT, Types.NUMERIC, Types.DECIMAL,
                Types.FLOAT, Types.REAL, Types.DOUBLE, Types.BOOLEAN, Types.BIT,
                Types.DATE, Types.TIME, Types.TIMESTAMP -> true;
            default -> false;
        };
    }
    static Shape shape(Connection connection, String kind, Map<String, Object> request) throws Exception {
        String catalog = text(request, "catalog"), schema = text(request, "schema"), table = text(request, "table");
        if (table.isEmpty()) fail("DB_INVALID_REQUEST");
        DatabaseMetaData metadata = connection.getMetaData();
        String cat = catalog.isEmpty() ? null : catalog, sch = schema.isEmpty() ? null : schema;
        List<Column> columns = new ArrayList<>();
        try (ResultSet rows = metadata.getColumns(cat, sch == null ? null : pattern(metadata, sch), pattern(metadata, table), "%")) {
            while (rows.next()) {
                if (columns.size() >= 256) fail("DB_REPLY_LIMIT");
                String name = rows.getString("COLUMN_NAME");
                boolean generated = "YES".equalsIgnoreCase(rows.getString("IS_AUTOINCREMENT")) || "YES".equalsIgnoreCase(rows.getString("IS_GENERATEDCOLUMN"));
                columns.add(new Column(name, rows.getInt("DATA_TYPE"), rows.getInt("NULLABLE") != DatabaseMetaData.columnNoNulls,
                    generated, rows.getString("COLUMN_DEF") != null));
            }
        }
        if (columns.isEmpty()) fail("DB_TABLE_UNSUPPORTED");
        TreeMap<Integer, String> ordered = new TreeMap<>();
        try (ResultSet rows = metadata.getPrimaryKeys(cat, sch, table)) {
            while (rows.next()) {
                if (ordered.size() >= 64) fail("DB_TABLE_UNSUPPORTED");
                ordered.put(rows.getInt("KEY_SEQ"), rows.getString("COLUMN_NAME"));
            }
        }
        List<String> keys = new ArrayList<>(ordered.values());
        boolean tableType = false;
        try (ResultSet rows = metadata.getTables(cat, sch == null ? null : pattern(metadata, sch), pattern(metadata, table), new String[]{"TABLE", "VIEW"})) {
            if (rows.next()) tableType = "TABLE".equalsIgnoreCase(rows.getString("TABLE_TYPE"));
        }
        boolean editable = tableType && !keys.isEmpty() && columns.stream().allMatch(column -> supported(column.type()))
            && keys.stream().allMatch(key -> columns.stream().anyMatch(column -> column.name().equals(key) && !column.nullable()));
        if (editable && kind.equals("mysql")) {
            try (PreparedStatement engine = connection.prepareStatement("SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?")) {
                engine.setString(1, catalog);
                engine.setString(2, table);
                engine.setQueryTimeout(10);
                try (ResultSet rows = engine.executeQuery()) { editable = rows.next() && "InnoDB".equalsIgnoreCase(rows.getString(1)); }
            }
        }
        String namespace = kind.equals("mysql") ? catalog : schema;
        String target = (namespace.isEmpty() ? "" : quote(kind, namespace) + ".") + quote(kind, table);
        String signature = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(
            (target + columns.toString() + keys.toString() + editable).getBytes(StandardCharsets.UTF_8)));
        return new Shape(columns, keys, editable, target, signature);
    }
    private static Map<String, Object> descriptor(Shape shape) {
        List<Object> columns = new ArrayList<>();
        for (Column column : shape.columns()) columns.add(Map.of("name", column.name(), "jdbcType", column.type(), "nullable", column.nullable(),
            "generated", column.generated(), "hasDefault", column.defaulted(), "editable", supported(column.type()) && !column.generated() && !shape.keys().contains(column.name())));
        return Map.of("columns", columns, "keys", shape.keys(), "editable", shape.editable(), "signature", shape.signature(), "target", shape.target());
    }
    private static Column column(Shape shape, String name) {
        return shape.columns().stream().filter(column -> column.name().equals(name)).findFirst().orElseThrow(() -> new IllegalArgumentException("DB_INVALID_REQUEST"));
    }
    private static Object value(Object value, Column column) {
        if (value == null) {
            if (!column.nullable()) fail("DB_INVALID_VALUE");
            return null;
        }
        if (!(value instanceof String) || ((String) value).length() > 16384) fail("DB_INVALID_VALUE");
        return value;
    }
    private static void bind(PreparedStatement statement, List<Object> values, List<Column> columns) throws Exception {
        for (int at = 0; at < values.size(); at++) {
            Object value = values.get(at);
            Column column = columns.get(at);
            if (value == null) { statement.setNull(at + 1, column.type()); continue; }
            String text = (String) value;
            try {
                switch (column.type()) {
                    case Types.INTEGER, Types.SMALLINT, Types.TINYINT, Types.BIGINT, Types.NUMERIC, Types.DECIMAL, Types.FLOAT, Types.REAL, Types.DOUBLE -> {
                        BigDecimal number = new BigDecimal(text);
                        if (number.precision() > 16384 || Math.abs((long) number.scale()) > 16384) fail("DB_INVALID_VALUE");
                        statement.setBigDecimal(at + 1, number);
                    }
                    case Types.BOOLEAN, Types.BIT -> {
                        if (!List.of("true", "false", "t", "f", "1", "0").contains(text.toLowerCase(java.util.Locale.ROOT))) fail("DB_INVALID_VALUE");
                        statement.setBoolean(at + 1, text.equals("1") || text.equalsIgnoreCase("true") || text.equals("t"));
                    }
                    case Types.DATE -> statement.setDate(at + 1, java.sql.Date.valueOf(text));
                    case Types.TIME -> statement.setObject(at + 1, java.time.LocalTime.parse(text));
                    case Types.TIMESTAMP -> statement.setTimestamp(at + 1, java.sql.Timestamp.valueOf(text));
                    default -> statement.setString(at + 1, text);
                }
            } catch (RuntimeException error) { fail("DB_INVALID_VALUE"); }
        }
    }
    private static String keyWhere(Shape shape, String kind) {
        return String.join(" AND ", shape.keys().stream().map(key -> quote(kind, key) + " = ?").toList());
    }
    @SuppressWarnings("unchecked")
    static Map<String, Object> read(Connection connection, String kind, Map<String, Object> request) throws Exception {
        return read(connection, kind, request, 30);
    }
    @SuppressWarnings("unchecked")
    private static Map<String, Object> read(Connection connection, String kind, Map<String, Object> request, int timeout) throws Exception {
        Shape shape = shape(connection, kind, request);
        String sql = "SELECT " + String.join(", ", shape.columns().stream().map(column -> quote(kind, column.name())).toList()) + " FROM " + shape.target();
        List<Object> values = new ArrayList<>();
        List<Column> bindings = new ArrayList<>();
        List<String> conditions = new ArrayList<>();
        Object filters = request.getOrDefault("filters", List.of());
        if (!(filters instanceof List) || ((List<?>) filters).size() > 8) fail("DB_INPUT_LIMIT");
        for (Object item : (List<?>) filters) {
            if (!(item instanceof Map)) fail("DB_INVALID_REQUEST");
            Map<String, Object> filter = (Map<String, Object>) item;
            Column column = column(shape, text(filter, "column"));
            String name = quote(kind, column.name());
            String operation = text(filter, "operator");
            if (operation.equals("null") || operation.equals("notnull")) conditions.add(name + (operation.equals("null") ? " IS NULL" : " IS NOT NULL"));
            else {
                String operator = switch (operation) { case "eq" -> "="; case "gt" -> ">"; case "lt" -> "<"; case "contains" -> "LIKE"; default -> throw new IllegalArgumentException("DB_INVALID_REQUEST"); };
                if (!supported(column.type())) fail("DB_INVALID_VALUE");
                Object value = value(filter.get("value"), column);
                if (value == null) fail("DB_INVALID_VALUE");
                if (operation.equals("contains")) {
                    if (!List.of(Types.CHAR, Types.VARCHAR, Types.NCHAR, Types.NVARCHAR, Types.LONGVARCHAR, Types.LONGNVARCHAR).contains(column.type())) fail("DB_INVALID_VALUE");
                    value = "%" + ((String) value).replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%";
                }
                conditions.add(name + " " + operator + " ?" + (operation.equals("contains") ? " ESCAPE '!'" : ""));
                values.add(value);
                bindings.add(column);
            }
        }
        if (!conditions.isEmpty()) sql += " WHERE " + String.join(" AND ", conditions);
        if (!shape.keys().isEmpty()) sql += " ORDER BY " + String.join(", ", shape.keys().stream().map(key -> quote(kind, key)).toList());
        Object rawOffset = request.getOrDefault("offset", 0);
        if (!(rawOffset instanceof Number) || ((Number) rawOffset).doubleValue() != ((Number) rawOffset).intValue()) fail("DB_INPUT_LIMIT");
        int offset = ((Number) rawOffset).intValue();
        if (offset < 0 || offset > 10000) fail("DB_INPUT_LIMIT");
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            bind(statement, values, bindings);
            statement.setQueryTimeout(timeout);
            statement.setFetchSize(200);
            statement.setMaxRows(offset + 201);
            try (ResultSet rows = statement.executeQuery()) {
                Map<String, Object> result = DatabaseBridge.result(rows, 200, offset);
                result.put("table", descriptor(shape));
                return result;
            }
        }
    }
    @SuppressWarnings("unchecked")
    private static List<Command> commands(Shape shape, String kind, Map<String, Object> request) {
        if (!shape.editable()) fail("DB_TABLE_UNSUPPORTED");
        if (!shape.signature().equals(request.get("signature"))) fail("DB_CONFLICT");
        Object raw = request.get("changes");
        if (!(raw instanceof List) || ((List<?>) raw).isEmpty() || ((List<?>) raw).size() > 100) fail("DB_INPUT_LIMIT");
        List<Command> commands = new ArrayList<>();
        for (Object item : (List<?>) raw) {
            if (!(item instanceof Map)) fail("DB_INVALID_REQUEST");
            Map<String, Object> change = (Map<String, Object>) item;
            String operation = text(change, "kind");
            if (!List.of("insert", "update", "delete").contains(operation)) fail("DB_INVALID_REQUEST");
            Map<String, Object> changed = change.get("values") instanceof Map ? (Map<String, Object>) change.get("values") : Map.of();
            List<?> original = change.get("original") instanceof List ? (List<?>) change.get("original") : List.of();
            if (!operation.equals("insert") && original.size() != shape.columns().size()) fail("DB_INVALID_REQUEST");
            List<String> names = new ArrayList<>(), assignments = new ArrayList<>();
            List<Object> values = new ArrayList<>();
            List<Column> bindings = new ArrayList<>();
            if (!operation.equals("delete")) for (var entry : changed.entrySet()) {
                Column column = column(shape, entry.getKey());
                if (column.generated() || operation.equals("update") && shape.keys().contains(column.name())) fail("DB_INVALID_VALUE");
                names.add(quote(kind, column.name()));
                assignments.add(quote(kind, column.name()) + " = ?");
                values.add(value(entry.getValue(), column));
                bindings.add(column);
            }
            if (!operation.equals("delete") && names.isEmpty()) fail("DB_INVALID_VALUE");
            String sql;
            if (operation.equals("insert")) {
                for (Column column : shape.columns()) if (!column.nullable() && !column.generated() && !column.defaulted() && !changed.containsKey(column.name())) fail("DB_INVALID_VALUE");
                sql = "INSERT INTO " + shape.target() + " (" + String.join(", ", names) + ") VALUES (" + String.join(", ", names.stream().map(name -> "?").toList()) + ")";
            } else {
                sql = operation.equals("delete") ? "DELETE FROM " + shape.target() : "UPDATE " + shape.target() + " SET " + String.join(", ", assignments);
                sql += " WHERE " + keyWhere(shape, kind);
                for (String key : shape.keys()) {
                    Column column = column(shape, key);
                    Object keyValue = value(original.get(shape.columns().indexOf(column)), column);
                    if (keyValue == null) fail("DB_TABLE_UNSUPPORTED");
                    values.add(keyValue);
                    bindings.add(column);
                }
            }
            commands.add(new Command(operation, sql, values, bindings, original));
        }
        return commands;
    }
    static Map<String, Object> preview(Connection connection, String kind, Map<String, Object> request) throws Exception {
        Shape shape = shape(connection, kind, request);
        List<Object> preview = new ArrayList<>();
        for (Command command : commands(shape, kind, request)) {
            try (PreparedStatement statement = connection.prepareStatement(command.sql())) { bind(statement, command.values(), command.bindings()); }
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("sql", command.sql());
            entry.put("parameters", command.values());
            preview.add(entry);
        }
        return new LinkedHashMap<>(Map.of("preview", preview));
    }
    static Map<String, Object> apply(Connection connection, String kind, Map<String, Object> request) throws Exception {
        long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(25);
        Shape shape = shape(connection, kind, request);
        List<Command> commands = commands(shape, kind, request);
        Savepoint point = connection.setSavepoint(SAVEPOINT);
        try {
            for (Command command : commands) {
                if (!command.kind().equals("insert")) {
                    List<Object> keys = new ArrayList<>();
                    List<Column> bindings = new ArrayList<>();
                    for (String key : shape.keys()) {
                        Column column = column(shape, key);
                        keys.add(command.original().get(shape.columns().indexOf(column)));
                        bindings.add(column);
                    }
                    String sql = "SELECT " + String.join(", ", shape.columns().stream().map(column -> quote(kind, column.name())).toList())
                        + " FROM " + shape.target() + " WHERE " + keyWhere(shape, kind) + " FOR UPDATE";
                    try (PreparedStatement select = connection.prepareStatement(sql)) {
                        bind(select, keys, bindings);
                        select.setQueryTimeout(remaining(deadline));
                        select.setMaxRows(2);
                        try (ResultSet rows = select.executeQuery()) {
                            if (!rows.next()) fail("DB_CONFLICT");
                            for (int at = 0; at < shape.columns().size(); at++) {
                                String actual;
                                Column column = shape.columns().get(at);
                                if (List.of(Types.CHAR, Types.VARCHAR, Types.NCHAR, Types.NVARCHAR, Types.LONGVARCHAR, Types.LONGNVARCHAR).contains(column.type())) {
                                    try (java.io.Reader reader = rows.getCharacterStream(at + 1)) {
                                        if (reader == null) actual = null;
                                        else {
                                            char[] buffer = new char[16385];
                                            int length = 0, next;
                                            while (length < buffer.length && (next = reader.read(buffer, length, buffer.length - length)) > 0) length += next;
                                            if (length > 16384) fail("DB_CONFLICT");
                                            actual = new String(buffer, 0, length);
                                        }
                                    }
                                } else actual = rows.getString(at + 1);
                                if (actual != null && actual.length() > 16384 || !Objects.equals(actual, command.original().get(at))) fail("DB_CONFLICT");
                            }
                            if (rows.next()) fail("DB_TABLE_UNSUPPORTED");
                        }
                    }
                }
                try (PreparedStatement statement = connection.prepareStatement(command.sql())) {
                    bind(statement, command.values(), command.bindings());
                    statement.setQueryTimeout(remaining(deadline));
                    if (statement.executeUpdate() != 1) fail("DB_CONFLICT");
                }
            }
            Map<String, Object> response = read(connection, kind, request, remaining(deadline));
            // Oracle keeps one reusable savepoint because its JDBC driver cannot release it.
            // Oracle JDBC 不支持释放保存点，因此始终复用同一个名称，避免保存点累积。
            if (!kind.equals("oracle")) connection.releaseSavepoint(point);
            response.put("applied", commands.size());
            return response;
        } catch (Exception error) {
            try { connection.rollback(point); }
            catch (Exception rollback) { connection.close(); fail("DB_WRITE_UNKNOWN"); }
            throw error;
        }
    }
    private static int remaining(long deadline) {
        long nanos = deadline - System.nanoTime();
        if (nanos <= 0) fail("DB_BATCH_TIMEOUT");
        return (int) Math.max(1, java.util.concurrent.TimeUnit.NANOSECONDS.toSeconds(nanos));
    }
    private static void fail(String code) { throw new IllegalArgumentException(code); }
}
