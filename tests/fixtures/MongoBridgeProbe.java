import java.io.DataInputStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.ServerSocket;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import org.bson.Document;
import org.bson.RawBsonDocument;
import org.bson.codecs.DocumentCodec;
import org.bson.types.ObjectId;

/** Exercises the real driver against a disposable MongoDB wire fixture. 使用临时 MongoDB 协议模拟服务验证真实驱动。 */
class MongoBridgeProbe {
    private static final DocumentCodec CODEC = new DocumentCodec();
    private static final ObjectId KEY = new ObjectId("507f1f77bcf86cd799439011");
    private static final AtomicInteger writes = new AtomicInteger();
    private static final AtomicInteger updates = new AtomicInteger();
    private static volatile Throwable failure;
    private static final List<java.net.Socket> sockets = new java.util.concurrent.CopyOnWriteArrayList<>();
    private static Document row() { return new Document("_id", KEY).append("large", Long.MAX_VALUE).append("text", "中文").append("nullable", null); }
    private static void check(boolean value) { if (!value) throw new AssertionError("MongoDB protocol regression"); }
    private static Document decode(byte[] bytes, int offset) { return new RawBsonDocument(bytes, offset, bytes.length - offset).decode(CODEC); }
    private static byte[] encode(Document value) { ByteBuffer data = new RawBsonDocument(value, CODEC).getByteBuffer().asNIO(); byte[] bytes = new byte[data.remaining()]; data.get(bytes); return bytes; }
    private static Document cursor(String namespace, List<Document> rows) { return new Document("ok", 1.0).append("cursor", new Document("id", 0L).append("ns", namespace).append("firstBatch", rows)); }
    private static Document respond(Document request) {
        if (request.containsKey("ismaster") || request.containsKey("isMaster") || request.containsKey("hello"))
            return new Document("ok", 1.0).append("isWritablePrimary", true).append("ismaster", true).append("minWireVersion", 0).append("maxWireVersion", 25).append("maxBsonObjectSize", 16777216).append("maxMessageSizeBytes", 48000000).append("maxWriteBatchSize", 100000).append("connectionId", 1);
        if (request.containsKey("listDatabases")) return new Document("ok", 1.0).append("databases", List.of(new Document("name", "qa")));
        if (request.containsKey("listCollections")) return cursor("qa.$cmd.listCollections", List.of(new Document("name", "docs")));
        if (request.containsKey("find") || request.containsKey("aggregate")) return cursor("qa.docs", List.of(row()));
        if (request.containsKey("insert")) { writes.incrementAndGet(); return new Document("ok", 1.0).append("n", 1); }
        if (request.containsKey("update")) {
            writes.incrementAndGet();
            Document update = (Document) request.getList("updates", Document.class).get(0);
            List<Document> conditions = update.get("q", Document.class).getList("$and", Document.class);
            check(conditions.get(0).get("_id") instanceof ObjectId);
            List<Object> equality = conditions.get(1).get("$expr", Document.class).getList("$eq", Object.class);
            Document literal = (Document) ((Document) equality.get(1)).get("$literal");
            check(literal.equals(row()));
            check(update.get("u", Document.class).get("large") instanceof Long);
            return new Document("ok", 1.0).append("n", updates.incrementAndGet() == 1 ? 1 : 0).append("nModified", 1);
        }
        if (request.containsKey("delete")) { writes.incrementAndGet(); return new Document("ok", 1.0).append("n", 1); }
        return new Document("ok", 1.0);
    }
    private static void serve(java.net.Socket socket) {
        try (socket) {
            DataInputStream input = new DataInputStream(socket.getInputStream());
            while (true) {
                byte[] header = input.readNBytes(16);
                if (header.length == 0) return;
                check(header.length == 16);
                ByteBuffer fields = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN);
                int length = fields.getInt(), requestId = fields.getInt(); fields.getInt(); int opcode = fields.getInt();
                check(length >= 16 && length < 1048576);
                byte[] body = input.readNBytes(length - 16);
                int offset;
                if (opcode == 2004) { offset = 4; while (body[offset++] != 0) {} offset += 8; }
                else { check(opcode == 2013 && body[4] == 0); offset = 5; }
                int bsonLength = ByteBuffer.wrap(body, offset, 4).order(ByteOrder.LITTLE_ENDIAN).getInt();
                byte[] commandBytes = java.util.Arrays.copyOfRange(body, offset, offset + bsonLength);
                Document request = decode(commandBytes, 0);
                offset += bsonLength;
                while (offset < body.length) {
                    check(body[offset++] == 1);
                    int start = offset;
                    int size = ByteBuffer.wrap(body, offset, 4).order(ByteOrder.LITTLE_ENDIAN).getInt(); offset += 4;
                    int nameStart = offset; while (body[offset++] != 0) {}
                    String name = new String(body, nameStart, offset - nameStart - 1, java.nio.charset.StandardCharsets.UTF_8);
                    List<Document> values = new ArrayList<>();
                    while (offset < start + size) {
                        int count = ByteBuffer.wrap(body, offset, 4).order(ByteOrder.LITTLE_ENDIAN).getInt();
                        values.add(decode(java.util.Arrays.copyOfRange(body, offset, offset + count), 0)); offset += count;
                    }
                    request.put(name, values);
                }
                byte[] document = encode(respond(request));
                int extra = opcode == 2004 ? 20 : 5;
                ByteBuffer response = ByteBuffer.allocate(16 + extra + document.length).order(ByteOrder.LITTLE_ENDIAN);
                response.putInt(response.capacity()).putInt(42).putInt(requestId).putInt(opcode == 2004 ? 1 : 2013).putInt(0);
                if (opcode == 2004) response.putLong(0L).putInt(0).putInt(1); else response.put((byte) 0);
                response.put(document); socket.getOutputStream().write(response.array()); socket.getOutputStream().flush();
            }
        } catch (java.io.IOException ignored) { }
        catch (Throwable error) { failure = error; }
    }
    @SuppressWarnings("unchecked")
    private static Map<String, Object> dispatch(Method dispatch, MongoBridge bridge, Map<String, Object> request) throws Exception {
        try { return (Map<String, Object>) dispatch.invoke(bridge, request); }
        catch (InvocationTargetException error) { if (error.getCause() instanceof Exception cause) throw cause; throw error; }
    }
    @SuppressWarnings("unchecked")
    public static void main(String[] args) throws Exception {
        var threads = Executors.newCachedThreadPool();
        try (ServerSocket server = new ServerSocket(0, 10, java.net.InetAddress.getLoopbackAddress())) {
            threads.submit(() -> { try { while (!server.isClosed()) { var socket = server.accept(); sockets.add(socket); threads.submit(() -> serve(socket)); } } catch (java.io.IOException ignored) {} });
            MongoBridge bridge = new MongoBridge();
            Method method = MongoBridge.class.getDeclaredMethod("dispatch", Map.class); method.setAccessible(true);
            dispatch(method, bridge, Map.of("op", "connect", "config", Map.of("host", "127.0.0.1", "port", server.getLocalPort(), "tls", false), "password", ""));
            check(dispatch(method, bridge, Map.of("op", "document", "action", "databases")).get("names").equals(List.of("qa")));
            check(dispatch(method, bridge, Map.of("op", "document", "action", "collections", "database", "qa")).get("names").equals(List.of("docs")));
            Map<String, Object> query = Map.of("op", "document", "action", "query", "database", "qa", "collection", "docs", "query", "{\"filter\":{},\"sort\":{\"_id\":1}}");
            Map<String, Object> result = dispatch(method, bridge, query);
            Map<String, String> document = (Map<String, String>) ((List<?>) result.get("documents")).get(0);
            check(document.get("value").contains("9223372036854775807") && document.get("value").contains("$numberLong") && document.get("value").contains("$oid"));
            var write = new java.util.HashMap<String, Object>(Map.of("op", "document", "action", "replace", "database", "qa", "collection", "docs", "document", document.get("value"), "original", document.get("value"), "identity", document.get("identity"), "confirmed", true));
            try { dispatch(method, bridge, write); throw new AssertionError(); } catch (IllegalArgumentException expected) { check(expected.getMessage().equals("DB_DOCUMENT_READ_ONLY")); }
            check(writes.get() == 0);
            dispatch(method, bridge, Map.of("op", "document", "action", "writable", "enabled", true));
            dispatch(method, bridge, write);
            try { dispatch(method, bridge, write); throw new AssertionError(); } catch (IllegalArgumentException expected) { check(expected.getMessage().equals("DB_DOCUMENT_CONFLICT")); }
            write.put("action", "delete"); dispatch(method, bridge, write);
            write.put("action", "insert"); dispatch(method, bridge, write);
            var aggregate = new java.util.HashMap<>(query); aggregate.put("query", "{\"pipeline\":[{\"$match\":{}}]}"); dispatch(method, bridge, aggregate);
            for (String pipeline : List.of("{\"pipeline\":[{\"$out\":\"other\"}]}", "{\"pipeline\":[{\"$facet\":{\"nested\":[{\"$merge\":\"other\"}]}}]}")) {
                aggregate.put("query", pipeline);
                try { dispatch(method, bridge, aggregate); throw new AssertionError(); } catch (IllegalArgumentException expected) { check(expected.getMessage().equals("DB_DOCUMENT_READ_ONLY")); }
            }
            check(writes.get() == 4);
            if (failure != null) throw new AssertionError(failure);
            var field = MongoBridge.class.getDeclaredField("client"); field.setAccessible(true);
            ((AutoCloseable) field.get(bridge)).close();
            System.out.println("MongoDB driver, canonical BSON, read guards and conflict checks passed");
        } finally { for (var socket : sockets) socket.close(); threads.shutdownNow(); }
    }
}
