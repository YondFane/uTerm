import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.TimeUnit;

/** Optional MongoDB worker; driver classes are loaded only when connecting. 可选 MongoDB 进程，仅在连接时加载驱动类。 */
public final class MongoBridge {
    private Object client;
    private Object writer;
    private boolean writable;

    public static void main(String[] args) throws Exception {
        if (args.length == 1 && args[0].equals("--version")) { System.out.println("uterm-database/1"); return; }
        MongoBridge bridge = new MongoBridge();
        try (BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
            while (true) {
                StringBuilder line = new StringBuilder();
                int next;
                while ((next = input.read()) != -1 && next != '\n') {
                    if (line.length() >= 1048576) throw new IllegalArgumentException("DB_INPUT_LIMIT");
                    line.append((char) next);
                }
                if (line.isEmpty() && next == -1) break;
                Object id = null, result = null;
                String failure = null;
                try {
                    Map<String, Object> request = object(Json.parse(line.toString()));
                    id = request.get("id");
                    result = bridge.dispatch(request);
                } catch (Throwable error) {
                    while (error instanceof InvocationTargetException && error.getCause() != null) error = error.getCause();
                    String message = error.getMessage();
                    String type = error.getClass().getSimpleName();
                    // Vendor exceptions can echo documents and credentials; return fixed codes only. 厂商异常可能回显文档及凭据，因此仅返回固定错误码。
                    failure = error instanceof IllegalArgumentException && message != null && message.matches("DB_[A-Z_]+") ? message
                        : type.contains("Security") ? "DB_HTTP_AUTH"
                        : type.contains("Timeout") ? "DB_TIMEOUT"
                        : type.contains("Socket") ? "DB_DISCONNECTED"
                        : type.contains("Write") ? "DB_DOCUMENT_CONFLICT"
                        : error instanceof ClassNotFoundException || error instanceof NoClassDefFoundError ? "DB_COMPONENT_MISSING"
                        : "DB_DOCUMENT_QUERY";
                }
                Map<String, Object> response = new LinkedHashMap<>();
                response.put("id", id); response.put("result", result); response.put("error", failure);
                byte[] bytes = (Json.write(response) + "\n").getBytes(StandardCharsets.UTF_8);
                System.out.write(bytes); System.out.flush();
            }
        } finally { if (bridge.client != null) call("com.mongodb.client.MongoClient", bridge.client, "close"); }
    }

    static Object call(String owner, Object target, String name, Object... args) throws Exception {
        for (Method method : Class.forName(owner).getMethods()) {
            if (!method.getName().equals(name) || method.getParameterCount() != args.length) continue;
            Class<?>[] parameters = method.getParameterTypes();
            boolean matches = true;
            for (int index = 0; index < args.length; index++) {
                Class<?> type = parameters[index];
                if (type == int.class) type = Integer.class;
                else if (type == long.class) type = Long.class;
                else if (type == boolean.class) type = Boolean.class;
                if (args[index] != null && !type.isInstance(args[index])) matches = false;
            }
            if (matches) return method.invoke(target, args);
        }
        throw new IllegalArgumentException("DB_COMPONENT_MISSING");
    }
    @SuppressWarnings("unchecked")
    static Map<String, Object> object(Object value) {
        if (!(value instanceof Map)) throw new IllegalArgumentException("DB_DOCUMENT_QUERY");
        return (Map<String, Object>) value;
    }
    private static String text(Map<String, Object> value, String key) {
        return value.get(key) instanceof String string ? string : "";
    }
    private static Object bson(String value) throws Exception { return call("org.bson.Document", null, "parse", value); }
    private static Object bson(Object value) throws Exception { return bson(Json.write(value)); }
    private String canonical(Object value) throws Exception { return (String) call("org.bson.Document", value, "toJson", writer); }
    static void readOnly(Object value) {
        if (value instanceof Map<?, ?> map) {
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (List.of("$out", "$merge", "$function", "$accumulator", "$where").contains(entry.getKey()))
                    throw new IllegalArgumentException("DB_DOCUMENT_READ_ONLY");
                readOnly(entry.getValue());
            }
        } else if (value instanceof List<?> list) for (Object child : list) readOnly(child);
    }
    private Object database(String name) throws Exception {
        if (name.isEmpty() || name.length() > 255 || name.indexOf('\0') >= 0) throw new IllegalArgumentException("DB_DOCUMENT_TARGET");
        return call("com.mongodb.client.MongoClient", client, "getDatabase", name);
    }
    private Object dispatch(Map<String, Object> request) throws Exception {
        if ("connect".equals(request.get("op"))) {
            Map<String, Object> config = object(request.get("config"));
            String host = text(config, "host"), username = text(config, "username");
            String authority = host.contains(":") ? "[" + host + "]" : host;
            String uri = "mongodb://" + authority + ":" + config.get("port")
                + "/?directConnection=true&retryReads=false&retryWrites=false&serverSelectionTimeoutMS=12000&connectTimeoutMS=12000&socketTimeoutMS=35000&maxPoolSize=2&minPoolSize=0&tls=" + Boolean.TRUE.equals(config.get("tls"));
            if (request.get("proxy_port") instanceof Number port && port.intValue() > 0)
                uri += "&proxyHost=127.0.0.1&proxyPort=" + port + "&proxyUsername=uterm&proxyPassword=" + text(request, "proxy_token");
            if (Boolean.TRUE.equals(config.get("tls"))) DatabaseBridge.installTrust(text(config, "ca_file"));
            Object settings = call("com.mongodb.MongoClientSettings", null, "builder");
            Object connection = Class.forName("com.mongodb.ConnectionString").getConstructor(String.class).newInstance(uri);
            call("com.mongodb.MongoClientSettings$Builder", settings, "applyConnectionString", connection);
            call("com.mongodb.MongoClientSettings$Builder", settings, "timeout", 35000L, TimeUnit.MILLISECONDS);
            if (!username.isEmpty()) {
                String source = text(config, "auth_source");
                Object credential = call("com.mongodb.MongoCredential", null, "createCredential", username,
                    source.isEmpty() ? "admin" : source, text(request, "password").toCharArray());
                call("com.mongodb.MongoClientSettings$Builder", settings, "credential", credential);
            }
            client = call("com.mongodb.client.MongoClients", null, "create", call("com.mongodb.MongoClientSettings$Builder", settings, "build"));
            Object jsonSettings = call("org.bson.json.JsonWriterSettings", null, "builder");
            call("org.bson.json.JsonWriterSettings$Builder", jsonSettings, "outputMode", Class.forName("org.bson.json.JsonMode").getField("EXTENDED").get(null));
            writer = call("org.bson.json.JsonWriterSettings$Builder", jsonSettings, "build");
            call("com.mongodb.client.MongoDatabase", database("admin"), "runCommand", bson("{\"ping\":1}"));
            return Map.of("version", "MongoDB", "protocol", 1);
        }
        if (client == null) throw new IllegalArgumentException("DB_DISCONNECTED");
        if (!"document".equals(request.get("op"))) throw new IllegalArgumentException("DB_INVALID_REQUEST");
        String action = text(request, "action");
        if (action.equals("writable")) { writable = Boolean.TRUE.equals(request.get("enabled")); return Map.of("writable", writable); }
        if (action.equals("databases")) return names(call("com.mongodb.client.MongoClient", client, "listDatabaseNames"));
        Object database = database(text(request, "database"));
        if (action.equals("collections")) return names(call("com.mongodb.client.MongoDatabase", database, "listCollectionNames"));
        String name = text(request, "collection");
        if (name.isEmpty() || name.length() > 1024 || name.indexOf('\0') >= 0) throw new IllegalArgumentException("DB_DOCUMENT_TARGET");
        Object collection = call("com.mongodb.client.MongoDatabase", database, "getCollection", name);
        if (action.equals("query")) {
            Map<String, Object> query = object(Json.parse(text(request, "query")));
            readOnly(query);
            int offset = ((Number) request.getOrDefault("offset", 0)).intValue();
            if (offset < 0 || offset > 9950) throw new IllegalArgumentException("DB_INPUT_LIMIT");
            Object iterable;
            if (query.containsKey("pipeline")) {
                if (query.size() != 1 || !(query.get("pipeline") instanceof List<?> pipeline) || pipeline.size() > 100)
                    throw new IllegalArgumentException("DB_DOCUMENT_QUERY");
                List<Object> stages = new ArrayList<>();
                for (Object stage : pipeline) stages.add(bson(object(stage)));
                stages.add(bson(Map.of("$skip", offset))); stages.add(bson(Map.of("$limit", 51)));
                iterable = call("com.mongodb.client.MongoCollection", collection, "aggregate", stages);
                call("com.mongodb.client.AggregateIterable", iterable, "maxTime", 30L, TimeUnit.SECONDS);
                call("com.mongodb.client.AggregateIterable", iterable, "allowDiskUse", false);
            } else {
                if (!List.of("filter", "sort", "projection").containsAll(query.keySet())) throw new IllegalArgumentException("DB_DOCUMENT_QUERY");
                iterable = call("com.mongodb.client.MongoCollection", collection, "find", bson(object(query.getOrDefault("filter", Map.of()))));
                for (String field : List.of("sort", "projection")) if (query.containsKey(field))
                    call("com.mongodb.client.FindIterable", iterable, field, bson(object(query.get(field))));
                call("com.mongodb.client.FindIterable", iterable, "skip", offset);
                call("com.mongodb.client.FindIterable", iterable, "limit", 51);
                call("com.mongodb.client.FindIterable", iterable, "maxTime", 30L, TimeUnit.SECONDS);
            }
            call("com.mongodb.client.MongoIterable", iterable, "batchSize", 50);
            Object cursor = call("com.mongodb.client.MongoIterable", iterable, "iterator");
            List<Object> documents = new ArrayList<>();
            int budget = 0;
            boolean more = false;
            try {
                while ((boolean) call("com.mongodb.client.MongoCursor", cursor, "hasNext")) {
                    if (documents.size() >= 50) { more = true; break; }
                    Object document = call("com.mongodb.client.MongoCursor", cursor, "next");
                    String value = canonical(document);
                    budget += value.length();
                    if (value.length() > 262144 || budget > 1048576) throw new IllegalArgumentException("DB_REPLY_LIMIT");
                    Map<String, Object> fields = object(document);
                    Object key = bson("{}");
                    if (fields.containsKey("_id")) object(key).put("_id", fields.get("_id"));
                    String identity = fields.containsKey("_id") ? canonical(key) : "";
                    documents.add(Map.of("value", value, "identity", identity));
                }
            } finally { call("com.mongodb.client.MongoCursor", cursor, "close"); }
            return Map.of("documents", documents, "more", more && offset < 9950);
        }
        if (!List.of("insert", "replace", "delete").contains(action)) throw new IllegalArgumentException("DB_INVALID_REQUEST");
        if (!writable || !Boolean.TRUE.equals(request.get("confirmed"))) throw new IllegalArgumentException("DB_DOCUMENT_READ_ONLY");
        if (action.equals("insert")) {
            call("com.mongodb.client.MongoCollection", collection, "insertOne", bson(text(request, "document")));
        } else {
            Map<String, Object> identity = object(bson(text(request, "identity")));
            Map<String, Object> original = object(bson(text(request, "original")));
            if (identity.size() != 1 || !identity.containsKey("_id") || !Objects.equals(identity.get("_id"), original.get("_id"))) throw new IllegalArgumentException("DB_DOCUMENT_TARGET");
            Object filter = bson("{}");
            // Build BSON directly so ObjectId and dates survive optimistic conflict checks. 直接构建 BSON，确保乐观冲突检查保留 ObjectId 和日期类型。
            Map<String, Object> expression = object(filter);
            Object literal = bson("{}"); object(literal).put("$literal", original);
            Object equality = bson("{}"); object(equality).put("$eq", List.of("$$ROOT", literal));
            Object condition = bson("{}"); object(condition).put("$expr", equality);
            expression.put("$and", List.of(identity, condition));
            long affected;
            if (action.equals("replace")) {
                Map<String, Object> replacement = object(bson(text(request, "document")));
                if (!Objects.equals(identity.get("_id"), replacement.get("_id"))) throw new IllegalArgumentException("DB_DOCUMENT_CONFLICT");
                Object result = call("com.mongodb.client.MongoCollection", collection, "replaceOne", filter, replacement);
                affected = (long) call("com.mongodb.client.result.UpdateResult", result, "getMatchedCount");
            } else {
                Object result = call("com.mongodb.client.MongoCollection", collection, "deleteOne", filter);
                affected = (long) call("com.mongodb.client.result.DeleteResult", result, "getDeletedCount");
            }
            if (affected != 1) throw new IllegalArgumentException("DB_DOCUMENT_CONFLICT");
        }
        return Map.of("affected", 1);
    }
    private Object names(Object iterable) throws Exception {
        Object cursor = call("com.mongodb.client.MongoIterable", iterable, "iterator");
        List<String> names = new ArrayList<>();
        try {
            while ((boolean) call("com.mongodb.client.MongoCursor", cursor, "hasNext")) {
                if (names.size() >= 500) break;
                names.add((String) call("com.mongodb.client.MongoCursor", cursor, "next"));
            }
        } finally { call("com.mongodb.client.MongoCursor", cursor, "close"); }
        return Map.of("names", names);
    }
}
